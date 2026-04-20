# DASH Period Flattening Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `packages/cmaf-lite/lib/dash/dash_periods.ts` into a clear lookup-first flow with single-purpose helpers, add public `id` fields to `SwitchingSet` and `Track`, and fully support subtitle parsing end-to-end.

**Architecture:** `flattenPeriods` owns two O(1) Maps (`switchingSetsById`, `tracksById`). Identity is derived straight from XML via `getAdaptationSetId`; objects are only constructed on cache miss via `parseAdaptationSet` / `parseRepresentation`. Track dedup and merge logic lives in small, named helpers (`mergeTrack`, `mergeTrackSegments`).

**Tech Stack:** TypeScript, Vitest, `txml`, `@svta/cml-dash`, `@svta/cml-utils`

**Reference spec:** [docs/superpowers/specs/2026-04-20-dash-periods-restructure-design.md](../specs/2026-04-20-dash-periods-restructure-design.md)

---

### Task 1: Add `id` to `BaseSwitchingSet`/`BaseTrack` and `language` to `SubtitleSwitchingSet`

**Files:**
- Modify: `packages/cmaf-lite/lib/types/manifest.ts`
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts`
- Modify: `packages/cmaf-lite/test/__framework__/factories.ts`

This task adds the new fields to the public type system and updates the **current** (pre-restructure) `parseAdaptationSet` and `parseTrack` in `dash_periods.ts` just enough to populate `id`. The big orchestration rewrite happens in Task 4 — here we only want types + existing parser + factories to compile cleanly and tests to keep passing.

- [ ] **Step 1: Add `id` to `BaseSwitchingSet` and `BaseTrack`, `language` to `SubtitleSwitchingSet`**

In [packages/cmaf-lite/lib/types/manifest.ts](../../packages/cmaf-lite/lib/types/manifest.ts), update the three interfaces:

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

- [ ] **Step 2: Populate `id` in the existing `parseAdaptationSet`**

In [packages/cmaf-lite/lib/dash/dash_periods.ts](../../packages/cmaf-lite/lib/dash/dash_periods.ts), update the current `parseAdaptationSet` so the returned `SwitchingSet` includes `id`. The current version throws on `SUBTITLE` — leave that behavior for now; subtitle support arrives in Task 4.

```ts
function parseAdaptationSet(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const type = inferMediaType(adaptationSet, representations);
  const codec = resolveCodec(adaptationSet, representations);
  const id = `${type}:${codec}`;

  if (type === MediaType.VIDEO) {
    return { id, type: MediaType.VIDEO, codec, tracks: [] };
  }
  if (type === MediaType.AUDIO) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return {
      id: `${id}:${language}`,
      type: MediaType.AUDIO,
      codec,
      language,
      tracks: [],
    };
  }

  throw new Error("Invalid adataptionSet");
}
```

- [ ] **Step 3: Populate `id` in the existing `parseTrack`**

In the same file, update `parseTrack` to include the `Representation@id` on the returned `Track`. The id is already read further up in `processAdaptationSet`; make `parseTrack` read it itself so Task 4's removal of `processAdaptationSet` is clean.

Add at the top of `parseTrack`, after the existing `bandwidth` read:

```ts
const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
asserts.assertExists(id, "Representation@id is mandatory");
```

Then update the two returns (inside the VIDEO and AUDIO branches) to include `id`:

```ts
// VIDEO branch
return {
  id,
  type: MediaType.VIDEO,
  width,
  height,
  bandwidth,
  ...segmentData,
};

// AUDIO branch
return {
  id,
  type: MediaType.AUDIO,
  bandwidth,
  ...segmentData,
};
```

- [ ] **Step 4: Update factories to include `id` defaults**

In [packages/cmaf-lite/test/__framework__/factories.ts](../../packages/cmaf-lite/test/__framework__/factories.ts), add `id` to every switching-set and track factory:

```ts
export function createVideoTrack(
  overrides?: Partial<Track<MediaType.VIDEO>>,
): Track<MediaType.VIDEO> {
  return {
    id: "video-track-1",
    type: MediaType.VIDEO,
    bandwidth: 2_000_000,
    width: 1920,
    height: 1080,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createAudioTrack(
  overrides?: Partial<Track<MediaType.AUDIO>>,
): Track<MediaType.AUDIO> {
  return {
    id: "audio-track-1",
    type: MediaType.AUDIO,
    bandwidth: 128_000,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createVideoSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.VIDEO>>,
): SwitchingSet<MediaType.VIDEO> {
  return {
    id: "video:avc1.64001f",
    type: MediaType.VIDEO,
    codec: "avc1.64001f",
    tracks: [createVideoTrack()],
    ...overrides,
  };
}

export function createAudioSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.AUDIO>>,
): SwitchingSet<MediaType.AUDIO> {
  return {
    id: "audio:mp4a.40.2:unk",
    type: MediaType.AUDIO,
    codec: "mp4a.40.2",
    tracks: [createAudioTrack()],
    ...overrides,
  };
}
```

- [ ] **Step 5: Type check and run the full test suite**

```bash
cd packages/cmaf-lite && pnpm tsc && pnpm test --run
```

Expected: all tests pass, zero TypeScript errors. Existing tests don't assert on `id` yet, so they should still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/types/manifest.ts packages/cmaf-lite/lib/dash/dash_periods.ts packages/cmaf-lite/test/__framework__/factories.ts
git commit -m "$(cat <<'EOF'
feat: add id to SwitchingSet/Track and language to SubtitleSwitchingSet

Introduces stable, public id fields on BaseSwitchingSet and BaseTrack,
plus a language field on SubtitleSwitchingSet (symmetric with audio).
The existing DASH parser now populates these fields; the orchestration
restructure follows in a separate commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rename `inferMediaType` → `resolveType`

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts`

Mechanical rename aligning with `resolveCodec` / `resolvePeriodDuration`.

- [ ] **Step 1: Rename the function and all call sites**

In [packages/cmaf-lite/lib/dash/dash_periods.ts](../../packages/cmaf-lite/lib/dash/dash_periods.ts), rename `inferMediaType` to `resolveType` at the declaration and at both call sites inside `parseAdaptationSet` and wherever else it appears (currently one declaration + calls inside `parseAdaptationSet` and potentially `parseTrack`).

Use your editor's rename-symbol or search-and-replace for the literal identifier `inferMediaType` → `resolveType` within this single file.

- [ ] **Step 2: Type check and run tests**

```bash
cd packages/cmaf-lite && pnpm tsc && pnpm test --run
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_periods.ts
git commit -m "$(cat <<'EOF'
refactor: rename inferMediaType to resolveType

Aligns with resolveCodec and resolvePeriodDuration naming.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract `resolveBaseUrl` helper

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts`

Pull the baseUrl-chain collection out of `parseTrack` (current name) into a named single-value resolver.

- [ ] **Step 1: Add `resolveBaseUrl` helper at the bottom of the file**

In [packages/cmaf-lite/lib/dash/dash_periods.ts](../../packages/cmaf-lite/lib/dash/dash_periods.ts), append (near the other `resolve*` helpers at the bottom):

```ts
function resolveBaseUrl(
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): string {
  const baseUrls = [mpd, period, adaptationSet, representation].flatMap(
    (node) => XmlUtils.children(node, "BaseURL").map(XmlUtils.text),
  );
  return UrlUtils.resolveUrls([
    sourceUrl,
    ...baseUrls.filter((u): u is string => u != null),
  ]);
}
```

- [ ] **Step 2: Replace the inline chain in `parseTrack` with the helper call**

In `parseTrack`, delete these lines:

```ts
const baseUrls = [ctx.mpd, period, adaptationSet, representation].flatMap(
  (node) => XmlUtils.children(node, "BaseURL").map(XmlUtils.text),
);
const baseUrl = UrlUtils.resolveUrls([
  ctx.sourceUrl,
  ...baseUrls.filter((u): u is string => u != null),
]);
```

Replace with:

```ts
const baseUrl = resolveBaseUrl(
  ctx.sourceUrl,
  ctx.mpd,
  period,
  adaptationSet,
  representation,
);
```

- [ ] **Step 3: Type check and run tests**

```bash
cd packages/cmaf-lite && pnpm tsc && pnpm test --run
```

Expected: all green. The baseUrl resolution is behavior-preserving.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_periods.ts
git commit -m "$(cat <<'EOF'
refactor: extract resolveBaseUrl helper

Pulls the [mpd, period, adaptationSet, representation] BaseURL chain
out of parseTrack into a named single-value resolver. Behavior
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Restructure orchestration in `dash_periods.ts`

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts`

The core refactor. Replaces `PeriodContext` + `processAdaptationSet` + `addTrack` with: `getAdaptationSetId`, a rewritten `parseAdaptationSet` (all three types), a renamed-and-rewritten `parseRepresentation` (all three types, non-nullable), `mergeTrackSegments`, `mergeTrack`, and a flat `flattenPeriods` loop owning two Maps.

- [ ] **Step 1: Write the orchestration from scratch**

Replace the **entire contents** of [packages/cmaf-lite/lib/dash/dash_periods.ts](../../packages/cmaf-lite/lib/dash/dash_periods.ts) with:

```ts
import type * as txml from "txml";
import type { SwitchingSet, Track } from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as LanguageUtils from "../utils/language_utils";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";
import { parseSegmentData } from "./dash_segments";

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
      const representations = XmlUtils.children(
        adaptationSet,
        "Representation",
      );
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

function getAdaptationSetId(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const type = resolveType(adaptationSet, representations);
  const codec = resolveCodec(adaptationSet, representations);
  const id = `${type}:${codec}`;

  if (type === MediaType.VIDEO) {
    return id;
  }
  if (type === MediaType.AUDIO) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return `${id}:${language}`;
  }
  if (type === MediaType.SUBTITLE) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return `${id}:${language}`;
  }
  throw new Error("Unsupported media type");
}

function parseAdaptationSet(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
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
    return {
      id: `${id}:${language}`,
      type,
      codec,
      language,
      tracks: [],
    };
  }
  if (type === MediaType.SUBTITLE) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return {
      id: `${id}:${language}`,
      type,
      codec,
      language,
      tracks: [],
    };
  }
  throw new Error("Unsupported media type");
}

function parseRepresentation(
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  type: MediaType,
  duration: number | null,
): Track {
  const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  asserts.assertExists(id, "Representation@id is mandatory");

  const baseUrl = resolveBaseUrl(
    sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
  );
  const bandwidth = XmlUtils.attr(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );
  asserts.assertExists(bandwidth, "bandwidth is mandatory");

  const segmentData = parseSegmentData(
    period,
    adaptationSet,
    representation,
    baseUrl,
    bandwidth,
    duration,
  );

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

function mergeTrackSegments(target: Track, incoming: Track): void {
  target.segments.push(...incoming.segments);
  target.maxSegmentDuration = Math.max(
    target.maxSegmentDuration,
    incoming.maxSegmentDuration,
  );
}

function resolveType(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): MediaType {
  const contentType = XmlUtils.attr(
    adaptationSet,
    "contentType",
    XmlUtils.parseString,
  );
  if (contentType === "video") {
    return MediaType.VIDEO;
  }
  if (contentType === "audio") {
    return MediaType.AUDIO;
  }
  if (contentType === "text") {
    return MediaType.SUBTITLE;
  }
  const mimeType =
    XmlUtils.attr(adaptationSet, "mimeType", XmlUtils.parseString) ??
    (representations[0]
      ? XmlUtils.attr(representations[0], "mimeType", XmlUtils.parseString)
      : undefined);
  if (mimeType?.startsWith("video/")) {
    return MediaType.VIDEO;
  }
  if (mimeType?.startsWith("audio/")) {
    return MediaType.AUDIO;
  }
  if (mimeType?.startsWith("text/") || mimeType?.startsWith("application/")) {
    return MediaType.SUBTITLE;
  }
  throw new Error("Failed to infer media type");
}

function resolveCodec(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const firstRep = representations[0];
  asserts.assertExists(firstRep, "No Representation found");

  const codec = Functional.findMap([firstRep, adaptationSet], (n) =>
    XmlUtils.attr(n, "codecs", XmlUtils.parseString),
  );
  asserts.assertExists(codec, "codecs is mandatory");

  return codec;
}

function resolveBaseUrl(
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): string {
  const baseUrls = [mpd, period, adaptationSet, representation].flatMap(
    (node) => XmlUtils.children(node, "BaseURL").map(XmlUtils.text),
  );
  return UrlUtils.resolveUrls([
    sourceUrl,
    ...baseUrls.filter((u): u is string => u != null),
  ]);
}

function resolvePeriodDuration(
  mpd: txml.TNode,
  periods: txml.TNode[],
  periodIndex: number,
): number | null {
  const period = periods[periodIndex];
  asserts.assertExists(period, "Period not found");

  const duration = XmlUtils.attr(period, "duration", XmlUtils.parseDuration);
  if (duration != null) {
    return duration;
  }

  const start = XmlUtils.attr(period, "start", XmlUtils.parseDuration) ?? 0;

  const nextPeriod = periods[periodIndex + 1];
  const nextStart = nextPeriod
    ? XmlUtils.attr(nextPeriod, "start", XmlUtils.parseDuration)
    : undefined;
  if (nextStart != null) {
    return nextStart - start;
  }

  const mpdDuration = XmlUtils.attr(
    mpd,
    "mediaPresentationDuration",
    XmlUtils.parseDuration,
  );
  if (mpdDuration != null) {
    return mpdDuration - start;
  }

  return null;
}
```

Key things to verify after pasting:

- No import from `../utils/manifest_utils` (deleted below).
- `PeriodContext`, `processAdaptationSet`, `addTrack`, `parseTrack`, `getOrCreateSwitchingSet`, and `inferMediaType` are all gone.
- Exactly one `export` — `flattenPeriods`.

- [ ] **Step 2: Type check and run the full test suite**

```bash
cd packages/cmaf-lite && pnpm tsc && pnpm test --run
```

Expected: `tsc` clean, **all existing DashParser tests still pass** (basic.mpd / multi-period.mpd / mimetype-fallback.mpd / timeline.mpd / inherited-template.mpd / timeline-reset.mpd round-trip unchanged).

If any test fails, fix the parser — don't change the test. The restructure is behavior-preserving for video and audio.

- [ ] **Step 3: Format**

```bash
cd packages/cmaf-lite && pnpm format
```

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_periods.ts
git commit -m "$(cat <<'EOF'
refactor: restructure dash_periods into lookup-first flow

Replaces the PeriodContext mutable-state pattern with a flat
flattenPeriods loop owning two Maps (switchingSetsById, tracksById).
Identity derivation lives in getAdaptationSetId; construction lives in
parseAdaptationSet / parseRepresentation (each handling video, audio,
and subtitle explicitly). Track dedup and merge logic is split into
named helpers (mergeTrack, mergeTrackSegments). The type-union bridge
in mergeTrack is guarded by a defensive runtime assertion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Delete `ManifestUtils.getSwitchingSetKey` and its test

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/manifest_utils.ts`
- Modify: `packages/cmaf-lite/test/utils/manifest_utils.test.ts`

The helper's only consumer (`dash_periods.ts`) was reworked in Task 4. No other callers remain.

- [ ] **Step 1: Delete the function and its `SwitchingSet` import**

Replace [packages/cmaf-lite/lib/utils/manifest_utils.ts](../../packages/cmaf-lite/lib/utils/manifest_utils.ts) with:

```ts
import type { InitSegment, Segment } from "../types/manifest";

export function isMediaSegment(
  segment: Segment | InitSegment,
): segment is Segment {
  return "initSegment" in segment;
}

export function isInitSegment(
  segment: Segment | InitSegment,
): segment is InitSegment {
  return !isMediaSegment(segment);
}
```

- [ ] **Step 2: Remove the `getSwitchingSetKey` describe block from the test file**

In [packages/cmaf-lite/test/utils/manifest_utils.test.ts](../../packages/cmaf-lite/test/utils/manifest_utils.test.ts), delete the `describe("getSwitchingSetKey", ...)` block and remove `getSwitchingSetKey`, `MediaType` from the imports if they become unused (they will).

Final file:

```ts
import { describe, expect, it } from "vitest";
import { isInitSegment, isMediaSegment } from "../../lib/utils/manifest_utils";
import { createInitSegment, createSegment } from "../__framework__/factories";

describe("ManifestUtils", () => {
  describe("isMediaSegment", () => {
    it("returns true for a media segment", () => {
      expect(isMediaSegment(createSegment())).toBe(true);
    });

    it("returns false for an init segment", () => {
      expect(isMediaSegment(createInitSegment())).toBe(false);
    });
  });

  describe("isInitSegment", () => {
    it("returns true for an init segment", () => {
      expect(isInitSegment(createInitSegment())).toBe(true);
    });

    it("returns false for a media segment", () => {
      expect(isInitSegment(createSegment())).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Type check and run tests**

```bash
cd packages/cmaf-lite && pnpm tsc && pnpm test --run
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/utils/manifest_utils.ts packages/cmaf-lite/test/utils/manifest_utils.test.ts
git commit -m "$(cat <<'EOF'
refactor: drop ManifestUtils.getSwitchingSetKey

The helper's single consumer (dash_periods.ts) now derives identity
directly from the XML via getAdaptationSetId. Nothing else imports it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add subtitle fixture and end-to-end subtitle tests

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/subtitle.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

Exercise the newly-added SUBTITLE branches in `parseAdaptationSet` and `parseRepresentation`.

- [ ] **Step 1: Write the failing subtitle tests**

In [packages/cmaf-lite/test/dash/dash_parser.test.ts](../../packages/cmaf-lite/test/dash/dash_parser.test.ts), add inside the existing `DashParser` describe block:

```ts
it("parses a subtitle AdaptationSet into a subtitle switching set with language", () => {
  const manifest = parseManifest(loadFixture("subtitle.mpd"), sourceUrl);
  const subtitle = manifest.switchingSets.find(
    (ss) => ss.type === MediaType.SUBTITLE,
  );
  expect(subtitle).toBeDefined();
  expect(subtitle!.codec).toBe("wvtt");
  expect(subtitle!.type).toBe(MediaType.SUBTITLE);
  if (subtitle!.type === MediaType.SUBTITLE) {
    expect(subtitle!.language).toBe("en");
  }
  expect(subtitle!.tracks).toHaveLength(1);
});

it("builds subtitle track segments from the SegmentTemplate", () => {
  const manifest = parseManifest(loadFixture("subtitle.mpd"), sourceUrl);
  const subtitle = manifest.switchingSets.find(
    (ss) => ss.type === MediaType.SUBTITLE,
  )!;
  const track = subtitle.tracks[0]!;
  expect(track.segments.length).toBeGreaterThan(0);
  expect(track.segments[0]!.url).toContain("subtitle-");
  expect(track.segments[0]!.initSegment.url).toContain("subtitle-init.mp4");
});
```

- [ ] **Step 2: Run the tests to verify they fail (fixture missing)**

```bash
cd packages/cmaf-lite && pnpm test --run -t "subtitle"
```

Expected: FAIL — `ENOENT: no such file or directory … subtitle.mpd`.

- [ ] **Step 3: Create the subtitle fixture**

Create [packages/cmaf-lite/test/fixtures/subtitle.mpd](../../packages/cmaf-lite/test/fixtures/subtitle.mpd) with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/mp4" codecs="wvtt" lang="en">
      <SegmentTemplate timescale="1000" media="subtitle-$Number$.m4s" initialization="subtitle-init.mp4" startNumber="1" duration="4000" />
      <Representation id="sub-en" bandwidth="1000" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd packages/cmaf-lite && pnpm test --run -t "subtitle"
```

Expected: both new subtitle tests pass.

- [ ] **Step 5: Run the full suite**

```bash
cd packages/cmaf-lite && pnpm test --run
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/test/fixtures/subtitle.mpd packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "$(cat <<'EOF'
test: cover subtitle AdaptationSet parsing end-to-end

Adds a subtitle fixture (WebVTT in fragmented MP4) and two tests:
one asserting the SubtitleSwitchingSet is emitted with its BCP-47
language, and one asserting subtitle track segments are built from
the SegmentTemplate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add cross-period audio merge and identity tests

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

The existing multi-period test only exercises video cross-period merge. The current branch's point was to unlock audio merging across periods; add an explicit test. Also pin down the new `id` field conventions.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `DashParser` describe block:

```ts
it("concatenates audio segments across periods into a single track", () => {
  const manifest = parseManifest(loadFixture("multi-period.mpd"), sourceUrl);
  const audio = manifest.switchingSets.find(
    (ss) => ss.type === MediaType.AUDIO,
  )!;
  expect(audio.tracks).toHaveLength(1);
  const segments = audio.tracks[0]!.segments;
  const p1Segments = segments.filter((s) => s.url.includes("p1-audio-"));
  const p2Segments = segments.filter((s) => s.url.includes("p2-audio-"));
  expect(p1Segments.length).toBeGreaterThan(0);
  expect(p2Segments.length).toBeGreaterThan(0);
  expect(p2Segments[0]!.start).toBeGreaterThanOrEqual(30);
});

it("assigns SwitchingSet.id as type:codec for video and type:codec:language for audio", () => {
  const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
  const video = manifest.switchingSets.find(
    (ss) => ss.type === MediaType.VIDEO,
  )!;
  const audio = manifest.switchingSets.find(
    (ss) => ss.type === MediaType.AUDIO,
  )!;
  expect(video.id).toBe("video:avc1.64001f");
  expect(audio.id).toBe("audio:mp4a.40.2:unk");
});

it("assigns Track.id from Representation@id", () => {
  const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
  const video = manifest.switchingSets.find(
    (ss) => ss.type === MediaType.VIDEO,
  )!;
  const ids = video.tracks.map((t) => t.id).sort();
  expect(ids).toEqual(["1", "2"]);
});
```

Note on the audio id format: `basic.mpd` has no `lang` attribute on the audio `AdaptationSet`, so `LanguageUtils.toBCP47(undefined)` returns `LANGUAGE_UNKNOWN` (`"unk"`). That's why the expected id is `audio:mp4a.40.2:unk`.

- [ ] **Step 2: Run the tests and verify they pass**

```bash
cd packages/cmaf-lite && pnpm test --run -t "across periods|SwitchingSet.id|Track.id"
```

Expected: all three pass. Task 4's orchestration already produces this output; these tests are assertions, not new behavior.

- [ ] **Step 3: Run the full suite**

```bash
cd packages/cmaf-lite && pnpm test --run
```

Expected: all green.

- [ ] **Step 4: Format and type check one final time**

```bash
cd packages/cmaf-lite && pnpm format && pnpm tsc
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "$(cat <<'EOF'
test: pin cross-period audio merge and id field conventions

Covers three previously untested behaviors: audio tracks concatenate
segments across periods (the feature this branch unlocks),
SwitchingSet.id follows the documented type:codec[:language] format,
and Track.id equals the DASH Representation@id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation verification

After all tasks complete:

- [ ] `cd packages/cmaf-lite && pnpm tsc && pnpm test --run && pnpm format`
- [ ] `git log --oneline feat/map-language-on-audio..HEAD` — review the commit sequence
- [ ] Skim [dash_periods.ts](../../packages/cmaf-lite/lib/dash/dash_periods.ts) top-to-bottom: `flattenPeriods` → `getAdaptationSetId` → `parseAdaptationSet` → `parseRepresentation` → `mergeTrack` → `mergeTrackSegments` → resolvers. Each function should read as one clear responsibility.
