# Manifest Apply — Parse and Update on a Shared Core

## Goal

Restructure DASH parsing so a fresh MPD can either **build** a new
`Manifest` or **update** an existing one in place, through the same
core. Identity — of `Manifest`, `SwitchingSet`, `Track`, and `Segment`
objects — is preserved across updates.

This is the segments-append prerequisite called out in the
[roadmap](../../../ROADMAP.md) live-manifest item, with the API shaped
so the live refresh layer can sit directly on top without further
restructuring of the parser.

## Non-goals

- Live scheduling, `minimumUpdatePeriod`, refresh backoff.
- Segment pruning (expired-segment rolloff, `timeShiftBufferDepth`).
- Period removal across refreshes.
- `UTCTiming`, LL-DASH, MPD patching.
- Dynamic-MPD-specific duration handling.

Today only `parseManifest` has a caller. `updateManifest` ships as a
working entry point that lets the live work layer on without touching
the parser again.

## Shape

### Two entry points, shared core — `dash_parser.ts`

```ts
export function parseManifest(text: string, sourceUrl: string): Manifest {
  const manifest: Manifest = { duration: 0, switchingSets: [] };
  applyMpd(manifest, text, sourceUrl);
  return manifest;
}

export function updateManifest(
  manifest: Manifest,
  text: string,
  sourceUrl: string,
): void {
  applyMpd(manifest, text, sourceUrl);
}

function applyMpd(manifest: Manifest, text: string, sourceUrl: string): void {
  const mpd = XmlUtils.parseXml(text, "MPD");
  const periods = XmlUtils.children(mpd, "Period");
  if (periods.length === 0) {
    throw new Error("No Period found in manifest");
  }
  const ctx = createContext(manifest);
  applyPeriods(ctx, sourceUrl, mpd, periods);
  manifest.duration = resolveDuration(mpd, manifest.switchingSets);
}
```

`resolveDuration` is unchanged.

Parse path: empty `manifest` → empty maps → apply populates both.
Update path: existing `manifest` → maps hydrated from it → apply
extends both. Same downstream code; the only difference between parse
and merge is what `createContext` starts with.

### Context — `dash_adaptations.ts`

`ApplyContext` holds the transient upsert index for a single
`applyMpd` call. `ctx.sets` is the same array reference as
`manifest.switchingSets`, so any push through `ctx` mutates the
manifest directly.

```ts
export type ApplyContext = {
  sets: SwitchingSet[];
  switchingSetsById: Map<string, SwitchingSet>;
  tracksById: Map<string, Track>;
};

export function createContext(manifest: Manifest): ApplyContext {
  const ctx: ApplyContext = {
    sets: manifest.switchingSets,
    switchingSetsById: new Map(),
    tracksById: new Map(),
  };
  for (const set of manifest.switchingSets) {
    ctx.switchingSetsById.set(set.id, set);
    for (const track of set.tracks) {
      ctx.tracksById.set(`${set.id}:${track.id}`, track);
    }
  }
  return ctx;
}
```

For the parse path, `manifest.switchingSets` is empty — hydration is a
no-op. For the update path, the walk rebuilds the maps from the
existing manifest: ~25 ops at typical DASH scale, trivial.

### Iteration — `dash_periods.ts`

`flattenPeriods` is replaced by `applyPeriods`, which takes the
context and mutates it (and by reference, the underlying manifest
arrays). The internal two-map bookkeeping of the original
`flattenPeriods` is promoted to `ApplyContext`, constructed
per-call.

`applyPeriods` lives in `dash_periods.ts`; the `upsertSwitchingSet`
and `upsertTrack` helpers it calls live in `dash_adaptations.ts`
(see [File layout](#file-layout)).

```ts
export function applyPeriods(
  ctx: ApplyContext,
  sourceUrl: string,
  mpd: txml.TNode,
  periods: txml.TNode[],
): void {
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    asserts.assertExists(period, "Period not found");
    const periodDuration = resolvePeriodDuration(mpd, periods, i);

    for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
      const representations = XmlUtils.children(adaptationSet, "Representation");
      if (representations.length === 0) continue;

      const switchingSet = upsertSwitchingSet(ctx, adaptationSet, representations);

      for (const representation of representations) {
        const track = upsertTrack(ctx, switchingSet, adaptationSet, representation);
        const max = appendSegments(
          track.segments, sourceUrl, mpd, period, adaptationSet, representation, periodDuration,
        );
        track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
      }
    }
  }
}
```

The inner loop carries no per-representation locals — just the XML
hierarchy `period → adaptationSet → representation`, plus the
per-period duration. Each callee extracts only what it needs.

The upsert helpers live in `dash_adaptations.ts`:

```ts
export function upsertSwitchingSet(
  ctx: ApplyContext,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const id = getAdaptationSetId(adaptationSet, representations);
  let set = ctx.switchingSetsById.get(id);
  if (!set) {
    set = parseAdaptationSet(adaptationSet, representations);
    ctx.switchingSetsById.set(id, set);
    ctx.sets.push(set);
  }
  return set;
}

export function upsertTrack(
  ctx: ApplyContext,
  switchingSet: SwitchingSet,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const trackId = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  asserts.assertExists(trackId, "Representation@id is mandatory");
  const key = `${switchingSet.id}:${trackId}`;
  let track = ctx.tracksById.get(key);
  if (!track) {
    track = buildTrack(switchingSet.type, trackId, adaptationSet, representation);
    asserts.assert(track.type === switchingSet.type, "Track type must match SwitchingSet type");
    ctx.tracksById.set(key, track);
    (switchingSet.tracks as Track[]).push(track);
  }
  return track;
}
```

`buildTrack` is `parseRepresentation` reshaped as a skeleton-only
constructor: `segments: []`, `maxSegmentDuration: 0`, with
`width`/`height` for video. It extracts `bandwidth` internally. It
does not parse segments.

Sharing `ApplyContext` across both upsert helpers keeps lookups O(1)
on both paths (parse and update) and makes the upsert index visible as
a first-class concept instead of threading Maps through argument
lists.

Deleted: `mergeTrack`, `mergeTrackSegments`, `parseRepresentation` (in
its old form).

### Append + slot split — `dash_segments.ts`

`parseSegmentData` is replaced by `appendSegments`, which pushes
segments directly into a caller-provided target and returns the
contributed `maxSegmentDuration`. `SegmentData`, `mapTemplateTimeline`,
and `mapTemplateDuration` are removed.

The template-addressing split is preserved, but collapsed to the one
place the two modes actually differ — *slot generation*. The segment
construction formula (URI templating, start/end math, push,
maxSegmentDuration tracking) lives in a single loop.

```ts
type Slot = { time: number; duration: number; number: number };

export function appendSegments(
  target: Segment[],
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodDuration: number | null,
): number {
  const baseUrl = resolveBaseUrl(sourceUrl, mpd, period, adaptationSet, representation);
  const bandwidth = XmlUtils.attr(representation, "bandwidth", XmlUtils.parseNumber);
  asserts.assertExists(bandwidth, "bandwidth is mandatory");
  const st = resolveSegmentTemplate(period, adaptationSet, representation);

  const initialization = XmlUtils.attr(st, "initialization", XmlUtils.parseString);
  asserts.assertExists(initialization, "initialization is mandatory");
  const media = XmlUtils.attr(st, "media", XmlUtils.parseString);
  asserts.assertExists(media, "media is mandatory");

  const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  const timescale = XmlUtils.attr(st, "timescale", XmlUtils.parseNumber) ?? 1;
  const startNumber = XmlUtils.attr(st, "startNumber", XmlUtils.parseNumber) ?? 1;
  const pto = XmlUtils.attr(st, "presentationTimeOffset", XmlUtils.parseNumber) ?? 0;
  const periodStart = XmlUtils.attr(period, "start", XmlUtils.parseDuration) ?? 0;

  const initSegment: InitSegment = {
    url: UrlUtils.resolveUrl(
      processUriTemplate(initialization, id, null, null, bandwidth, null),
      baseUrl,
    ),
  };

  const timeline = XmlUtils.child(st, "SegmentTimeline");
  const slots = timeline
    ? getTimelineSlots(timeline, startNumber)
    : getDurationSlots(st, startNumber, timescale, periodDuration);

  let maxSegmentDuration = 0;
  for (const { time, duration, number } of slots) {
    const url = UrlUtils.resolveUrl(
      processUriTemplate(media, id, number, null, bandwidth, time),
      baseUrl,
    );
    const start = (time - pto) / timescale + periodStart;
    const end = (time - pto + duration) / timescale + periodStart;
    target.push({ url, start, end, initSegment });
    maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
  }
  return maxSegmentDuration;
}

function getTimelineSlots(timeline: txml.TNode, startNumber: number): Slot[] {
  const slots: Slot[] = [];
  let time = 0;
  let number = startNumber;
  for (const s of XmlUtils.children(timeline, "S")) {
    const duration = XmlUtils.attr(s, "d", XmlUtils.parseNumber);
    asserts.assertExists(duration, "segment duration is mandatory");
    const r = XmlUtils.attr(s, "r", XmlUtils.parseNumber) ?? 0;
    time = XmlUtils.attr(s, "t", XmlUtils.parseNumber) ?? time;
    for (let i = 0; i <= r; i++) {
      slots.push({ time, duration, number });
      time += duration;
      number++;
    }
  }
  return slots;
}

function getDurationSlots(
  st: txml.TNode,
  startNumber: number,
  timescale: number,
  periodDuration: number | null,
): Slot[] {
  const duration = XmlUtils.attr(st, "duration", XmlUtils.parseNumber);
  asserts.assertExists(
    duration,
    "SegmentTemplate requires either SegmentTimeline or @duration",
  );
  asserts.assertExists(
    periodDuration,
    "Duration-based addressing requires a resolvable period duration",
  );
  const count = Math.ceil(periodDuration / (duration / timescale));
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    slots.push({ time: i * duration, duration, number: startNumber + i });
  }
  return slots;
}
```

`getTimelineSlots` and `getDurationSlots` are pure — same inputs, same
output, no side effects.

## Identity guarantees

After `updateManifest(manifest, newText, sourceUrl)`:

- `manifest` is the same object reference (mutated in place).
- `manifest.switchingSets` is the same array reference.
- Every `SwitchingSet` present before and after is the same reference.
  Its `tracks` array is the same reference. New switching sets append
  to the array.
- Every `Track` present before and after is the same reference. Its
  `segments` array is the same reference. New segments append to the
  array.
- Existing `Segment` objects are unchanged. New segments append.
- `manifest.duration` is reassigned (primitive field).

Within a single call, multi-period continuations of the same
representation likewise append onto the same `Track.segments` array —
the same path that cross-call refreshes use.

## Why this works for live later

The live refresh boils down to: "on refresh, call `updateManifest`
with the new MPD body." The roadmap items that follow this one
(expired pruning, period removal, refresh scheduler, events) all
layer on a `Manifest` whose identity is already preserved through
updates — none of them require further parser changes.

Deduplication across refreshes is currently implicit: a segment is
added only if the representation's current slot set extends beyond
what was appended before. For typical refresh cadence
(`minimumUpdatePeriod`-spaced, overlapping windows), this would push
duplicates. A `start`-keyed dedup on append is the natural next step
when live work begins — added inside the unified loop in
`appendSegments`, without shape changes. **Out of scope here.**

## File layout

Four files, one responsibility each. `dash_periods.ts` today is a
kitchen sink (iteration + upsert + skeleton construction + ID/type/
codec resolution + period helpers); the split pulls node
construction into a dedicated file.

| File | Responsibility | Exports |
|---|---|---|
| `lib/dash/dash_parser.ts` | Entry points — DASH text to/into `Manifest` | `parseManifest`, `updateManifest`; internal `applyMpd`, `resolveDuration` |
| `lib/dash/dash_periods.ts` | Iteration — walk periods, orchestrate upserts | `applyPeriods`, `resolvePeriodDuration` |
| `lib/dash/dash_adaptations.ts` *(new)* | Node construction — build/upsert `SwitchingSet` and `Track` from AdaptationSet/Representation XML | `ApplyContext`, `createContext`, `upsertSwitchingSet`, `upsertTrack`, `parseAdaptationSet`, `buildTrack`, `getAdaptationSetId`, `resolveType`, `resolveCodec` |
| `lib/dash/dash_segments.ts` | Segment materialization — expand templates into segments | `appendSegments`, `getTimelineSlots`, `getDurationSlots`, `resolveSegmentTemplate`, `resolveBaseUrl` |

Dependency graph — acyclic and layered:

```
dash_parser  →  dash_periods  →  dash_adaptations
                      ↓
                dash_segments
```

`dash_adaptations` and `dash_segments` are leaves (types + utils
only). `dash_periods` glues node construction and segment
materialization together for each representation. `dash_parser` is
the top.

## File-level change list

| File | Change |
|---|---|
| `lib/dash/dash_parser.ts` | Refactor `parseManifest` onto a shared `applyMpd`; add `updateManifest` export |
| `lib/dash/dash_periods.ts` | Replace `flattenPeriods` with `applyPeriods`; move skeleton construction (`parseAdaptationSet`, `getAdaptationSetId`, `resolveType`, `resolveCodec`) and track upsert out to `dash_adaptations.ts`; move `resolveBaseUrl` out to `dash_segments.ts`; delete `mergeTrack`, `mergeTrackSegments`, old `parseRepresentation` |
| `lib/dash/dash_adaptations.ts` *(new)* | `ApplyContext` type, `createContext`, `upsertSwitchingSet`, `upsertTrack`, `buildTrack`, `parseAdaptationSet`, `getAdaptationSetId`, `resolveType`, `resolveCodec` |
| `lib/dash/dash_segments.ts` | Replace `parseSegmentData` with `appendSegments`; pull `bandwidth` and `baseUrl` extraction into `appendSegments`; add `getTimelineSlots`, `getDurationSlots`; absorb `resolveBaseUrl` from `dash_periods.ts`; delete `mapTemplateTimeline`, `mapTemplateDuration`, `SegmentData` |

## Testing

Existing DASH parser tests cover the static-parse path end-to-end —
they continue to pass unchanged (byte-identical output from
`parseManifest`). Add:

- `updateManifest` applied twice to the same MPD is a no-op for
  segment contents (same count, same values) and preserves all
  references.
- `updateManifest` with a second MPD that adds a new `<S>` at the tail
  of the timeline appends new segments onto the existing
  `track.segments` array; the existing `Segment` objects are
  untouched.
- `updateManifest` across a pair of manifests that add a new
  `Representation` attaches a new `Track` to the existing
  `SwitchingSet.tracks` array.
- `updateManifest` across a pair of manifests that add a new
  `AdaptationSet` appends a new `SwitchingSet` to
  `manifest.switchingSets`.
- `getTimelineSlots` / `getDurationSlots` unit tests — pure functions,
  exercised through `appendSegments` indirectly; direct tests only if
  a corner case motivates them.

## Known limitations

Identity derivation for SwitchingSet (`getAdaptationSetId`) and Track
(`Representation@id` scoped to its switching set) is a pragmatic
heuristic, not MPEG-DASH / CMAF spec-faithful. It ignores
`AdaptationSet@id`, the `Role` descriptor, and period-continuity /
period-switchable descriptors, and over-merges on codec alone for
video and codec+lang for audio. This refactor does not change
identity logic — the same `getAdaptationSetId` string keying is
preserved. Tracked as its own roadmap entry
([ROADMAP.md](../../../ROADMAP.md) — "Spec-faithful AdaptationSet /
Representation identity") and must land before live work that relies
on cross-refresh identity stability across commentary / alternate
audio and HDR video.

## Open decisions

None blocking. Deferred:

- Duplicate-suppressing append — deferred to the live work pass,
  where the refresh cadence creates the need.
- Dynamic-MPD duration handling — deferred; current
  `resolveDuration` fallback on last-segment-end covers static usage.
