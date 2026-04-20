# DASH Period Flattening Restructure Design

## Overview

Restructure `lib/dash/dash_periods.ts` around a clear lookup-first flow: derive
stable identity straight from the XML, and only construct domain objects on
cache miss. Kills the mutable `PeriodContext`, the throwaway-SwitchingSet
pattern, the split `null`/throw convention for unsupported types, and the
untyped cast in `addTrack`. Also closes the subtitle gap: `SubtitleSwitchingSet`
gains a `language` field and is parsed end-to-end.

As part of this, `SwitchingSet` and `Track` gain public `id` fields — stable
identifiers that let consumers reference entities without relying on array
order. This also removes the composite map-key bookkeeping the parser
currently does.

## Goals

- Each helper has one job, readable top-to-bottom.
- Method names reflect intent: `get*Id` for identity extraction,
  `parse*` for construction, `resolve*` for deriving a single value from XML.
- Identity extraction and object construction are independent pure functions
  of the XML. No shared state, no argument coupling.
- Subtitle is a first-class type alongside video and audio.
- One "unsupported type" convention.

## Non-goals

- Changing any public type beyond adding `id` to `BaseSwitchingSet`/`BaseTrack`
  and `language` to `SubtitleSwitchingSet`.
- Reworking segment parsing (`dash_segments.ts`).
- Performance tuning. Re-reading XML attributes on cache miss is acceptable
  (the reads are trivial).

## Type Changes

`lib/types/manifest.ts`:

```ts
export interface BaseSwitchingSet {
  id: string;
  /** Codec string. */
  codec: string;
}

export interface BaseTrack {
  id: string;
  /** Bitrate in bits per second. */
  bandwidth: number;
  /** Ordered chunks on the presentation timeline. */
  segments: Segment[];
  /** Longest segment duration in seconds. */
  maxSegmentDuration: number;
}

export interface SubtitleSwitchingSet extends BaseSwitchingSet {
  type: MediaType.SUBTITLE;
  /** Language */
  language: string;
  /** Subtitle tracks. */
  tracks: SubtitleTrack[];
}
```

- `SwitchingSet.id` — the identity string (e.g. `video:avc`,
  `audio:mp4a:en`). Stable across periods within a manifest.
- `Track.id` — the raw `Representation@id` from DASH. Unique within a
  switching set.
- `SubtitleSwitchingSet.language` — symmetric with `AudioSwitchingSet`.

## Module Layout

`lib/dash/dash_periods.ts` exposes one public function:

```ts
export function flattenPeriods(
  sourceUrl: string,
  mpd: txml.TNode,
  periods: txml.TNode[],
): SwitchingSet[]
```

All helpers below are module-private.

### Identity extraction

```ts
function getAdaptationSetId(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string
```

- Resolves type and codec, then returns `${type}:${codec}` for video or
  `${type}:${codec}:${language}` for audio and subtitle.
- Used by the orchestrator to look up an existing `SwitchingSet` before
  deciding whether to parse.
- DASH-specific and module-private. Replaces and deletes
  `ManifestUtils.getSwitchingSetKey`.

No separate helper is needed for `Representation` identity. `Track.id` is
simply the `Representation@id` attribute, read inline inside
`parseRepresentation` (the same attribute is already read there when
building the init-segment URL).

### Object construction (called only on cache miss)

```ts
function parseAdaptationSet(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet  // tracks: []

function parseRepresentation(
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  type: MediaType,
  duration: number | null,
): Track
```

Both functions read top-to-bottom: derive id, resolve shared fields, then
dispatch on type to attach type-specific fields.

`parseAdaptationSet`:

```ts
const type = resolveType(adaptationSet, representations);
const codec = resolveCodec(adaptationSet, representations);
const id = `${type}:${codec}`;

if (type === MediaType.VIDEO) {
  return { id, type, codec, tracks: [] };
}
if (type === MediaType.AUDIO) {
  const language = LanguageUtils.toBCP47(
    XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
  );
  return { id: `${id}:${language}`, type, codec, language, tracks: [] };
}
if (type === MediaType.SUBTITLE) {
  const language = LanguageUtils.toBCP47(
    XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
  );
  return { id: `${id}:${language}`, type, codec, language, tracks: [] };
}
throw new Error("Unsupported media type");
```

`getAdaptationSetId` mirrors the same shape:

```ts
const type = resolveType(adaptationSet, representations);
const codec = resolveCodec(adaptationSet, representations);
const id = `${type}:${codec}`;
if (type === MediaType.VIDEO) {
  return id;
}
const language = LanguageUtils.toBCP47(
  XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
);
return `${id}:${language}`;
```

`parseRepresentation` follows the same shape: read `Representation@id`
inline, resolve shared fields (`baseUrl`, `bandwidth`, `segmentData`),
then dispatch per type. Each of video / audio / subtitle has its own
explicit branch. Returns a non-nullable `Track` — the unsupported-type
case is handled once inside `resolveType`, which throws.

```ts
const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
asserts.assertExists(id, "Representation@id is mandatory");

const baseUrl = resolveBaseUrl(sourceUrl, mpd, period, adaptationSet, representation);
const bandwidth = XmlUtils.attr(representation, "bandwidth", XmlUtils.parseNumber);
asserts.assertExists(bandwidth, "bandwidth is mandatory");
const segmentData = parseSegmentData(period, adaptationSet, representation, baseUrl, bandwidth, duration);

if (type === MediaType.VIDEO) {
  const width = Functional.findMap([representation, adaptationSet], (n) =>
    XmlUtils.attr(n, "width", XmlUtils.parseNumber),
  );
  asserts.assertExists(width, "width is mandatory");
  const height = Functional.findMap([representation, adaptationSet], (n) =>
    XmlUtils.attr(n, "height", XmlUtils.parseNumber),
  );
  asserts.assertExists(height, "height is mandatory");
  return { id, type, width, height, bandwidth, ...segmentData };
}
if (type === MediaType.AUDIO) {
  return { id, type, bandwidth, ...segmentData };
}
if (type === MediaType.SUBTITLE) {
  return { id, type, bandwidth, ...segmentData };
}
throw new Error("Unsupported media type");
```

`get*Id` and `parse*` are independent: both derive identity directly from
the XML, with no argument coupling. The id-string format appears in both
— a minor template-string duplication, caught immediately by any test
asserting on `SwitchingSet.id`. In exchange, each function is
self-sufficient and the orchestration does the minimum work.

### Resolvers (single-value XML readers)

Named by what they return. Each has one job.

- `resolveType(adaptationSet, representations): MediaType` — renamed from
  `inferMediaType`.
- `resolveCodec(adaptationSet, representations): string` — unchanged.
- `resolveBaseUrl(sourceUrl, mpd, period, adaptationSet, representation): string`
  — **new**. Walks the `[mpd, period, adaptationSet, representation]`
  chain, collecting `<BaseURL>` children and resolving them against
  `sourceUrl`. Extracted out of `parseRepresentation` for clarity.
- `resolvePeriodDuration(mpd, periods, index): number | null` — unchanged.

Language is read inline in the audio and subtitle branches (a single
`LanguageUtils.toBCP47(XmlUtils.attr(..., "lang", ...))` expression).

### Track merging helpers

Small, named helpers for the hit/miss paths. Each does exactly one thing.

```ts
function mergeTrackSegments(target: Track, incoming: Track): void {
  target.segments.push(...incoming.segments);
  target.maxSegmentDuration = Math.max(
    target.maxSegmentDuration,
    incoming.maxSegmentDuration,
  );
}

function mergeTrack(
  tracksById: Map<string, Track>,
  set: SwitchingSet,
  track: Track,
): void {
  const key = `${set.id}:${track.id}`;
  const existing = tracksById.get(key);
  if (existing) {
    mergeTrackSegments(existing, track);
    return;
  }
  tracksById.set(key, track);
  asserts.assert(
    track.type === set.type,
    "Track type must match SwitchingSet type",
  );
  (set.tracks as Track[]).push(track);
}
```

- `mergeTrackSegments` — appends segments, updates `maxSegmentDuration`.
  No knowledge of maps or switching sets.
- `mergeTrack` — the orchestration glue: dedup in `tracksById`, either
  extend the existing track or register the new one on both the map and
  the switching set. Asserts `track.type === set.type` defensively before
  the cast — catches any future regression that would otherwise silently
  corrupt the switching set. The cast itself remains because TS cannot
  narrow two independent discriminated unions from a cross-equality check.

## Orchestration

`flattenPeriods` owns two accumulation maps as locals: `switchingSetsById`
keyed by `SwitchingSet.id`, and `tracksById` keyed by
`${set.id}:${track.id}`. Both lookups are O(1), independent of manifest
size. The loop body is short — per-representation dedup and merge logic
lives in `mergeTrack`.

```ts
export function flattenPeriods(
  sourceUrl: string,
  mpd: txml.TNode,
  periods: txml.TNode[],
): SwitchingSet[] {
  const switchingSetsById = new Map<string, SwitchingSet>();
  const tracksById = new Map<string, Track>();

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    asserts.assertExists(period, "Period not found");
    const duration = resolvePeriodDuration(mpd, periods, i);

    for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
      const representations = XmlUtils.children(adaptationSet, "Representation");
      if (representations.length === 0) {
        continue;
      }

      const setId = getAdaptationSetId(adaptationSet, representations);
      let set = switchingSetsById.get(setId);
      if (!set) {
        set = parseAdaptationSet(adaptationSet, representations);
        switchingSetsById.set(setId, set);
      }

      for (const representation of representations) {
        const track = parseRepresentation(
          sourceUrl,
          mpd,
          period,
          adaptationSet,
          representation,
          set.type,
          duration,
        );
        mergeTrack(tracksById, set, track);
      }
    }
  }

  return [...switchingSetsById.values()];
}
```

### Flow summary

- **Period loop**: resolve duration, iterate adaptation sets.
- **AdaptationSet**: derive id; on miss, parse and insert into
  `switchingSetsById`.
- **Representation loop**: always parse (need per-period segments); hand
  the result to `mergeTrack`, which either extends an
  existing track's segments or registers a new one on both
  `tracksById` and the switching set.

## Deletions

- `lib/utils/manifest_utils.ts` — remove `getSwitchingSetKey`.
- `test/utils/manifest_utils.test.ts` — remove the `getSwitchingSetKey`
  describe block (its current assertion uses the stale 3-arg signature).
- `dash_periods.ts` — remove `PeriodContext`, `processAdaptationSet`,
  `addTrack` (old dedup helper), `getOrCreateSwitchingSet`, and the
  `parseTrack` null return path.

## Testing

Existing `test/dash/dash_parser.test.ts` covers end-to-end manifest parse
for video and audio. It must keep passing; assertions should gain checks
for the new `id` fields on `SwitchingSet` and `Track`.

New coverage:

- Subtitle: a DASH manifest fixture with a text/subtitle `AdaptationSet`
  (e.g. `contentType="text"`, WebVTT or TTML mime type) parses into a
  `SubtitleSwitchingSet` carrying `language` and at least one
  `SubtitleTrack`.
- Language parity: audio and subtitle adaptation sets with matching
  `(codec, language)` but across different periods merge into a single
  switching set with segments concatenated in order.
- Identity: `SwitchingSet.id` follows the documented format
  (`video:avc`, `audio:mp4a:en`); `Track.id` equals `Representation@id`.

Test naming follows project convention — each test name describes the
behavior that breaks if the test fails.

## Before / After at a Glance

| Concern | Before | After |
|---|---|---|
| Mutable orchestration state | `PeriodContext` struct threaded through helpers | Two `Map` locals inside `flattenPeriods` (`switchingSetsById`, `tracksById`) |
| Identity | Composite map keys computed ad hoc; no field on entities | `SwitchingSet.id` and `Track.id` are public fields |
| Identity derivation | Build throwaway `SwitchingSet`, pass to `getSwitchingSetKey` | `getAdaptationSetId` reads XML directly; `Track.id` read inline in `parseRepresentation` |
| Unsupported media type | `parseAdaptationSet` throws, `parseTrack` returns `null` | `resolveType` throws; downstream always returns a real value |
| Subtitle | Half-supported (type inferred, never constructed) | Parsed end-to-end with `language` |
| Type-union bridging | Inline `as Track[]` cast inside `addTrack` with no runtime check | Single cast inside `mergeTrack`, guarded by a defensive `track.type === set.type` assertion |
| Track dedup | Composite-string map + push + cast folded into one helper | `tracksById` map (O(1)) + `mergeTrack`/`mergeTrackSegments` each doing one job |
| `ManifestUtils.getSwitchingSetKey` | DASH-specific helper in a shared module | Deleted; logic lives with DASH parsing |
