# Manifest Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the DASH parser so a fresh MPD can either build a new `Manifest` or update an existing one in place, via a shared core. Preserve identity (`Manifest`, `SwitchingSet`, `Track`, `Segment` references) across updates.

**Architecture:** Four-file DASH module. `dash_parser.ts` exposes `parseManifest` and `updateManifest` backed by a shared `applyMpd`. `dash_periods.ts` owns period iteration. `dash_adaptations.ts` (new) owns SwitchingSet/Track construction + upsert, keyed by a per-call `ApplyContext` (lookup Maps that hydrate from the existing Manifest on the update path). `dash_segments.ts` owns segment materialization: `appendSegments` pushes into a caller-provided target array via pure slot generators (`getTimelineSlots`, `getDurationSlots`) behind a single URL/timing loop.

**Tech Stack:** TypeScript, Vitest (happy-dom), Biome, pnpm. Existing DASH parser fixtures are the regression harness; all current tests must stay green end-to-end.

**Spec:** [docs/superpowers/specs/2026-04-21-manifest-apply-design.md](../specs/2026-04-21-manifest-apply-design.md)

---

## File structure

| File | Role after refactor |
|---|---|
| `packages/cmaf-lite/lib/dash/dash_parser.ts` | Entry points `parseManifest`, `updateManifest`; shared `applyMpd`, `resolveDuration` |
| `packages/cmaf-lite/lib/dash/dash_periods.ts` | `applyPeriods` (iteration), `resolvePeriodDuration` |
| `packages/cmaf-lite/lib/dash/dash_adaptations.ts` *(new)* | `ApplyContext`, `createContext`, `upsertSwitchingSet`, `upsertTrack`, `buildTrack`, `parseAdaptationSet`, `getAdaptationSetId`, `resolveType`, `resolveCodec` |
| `packages/cmaf-lite/lib/dash/dash_segments.ts` | `appendSegments`, `getTimelineSlots`, `getDurationSlots`, `resolveSegmentTemplate`, `resolveBaseUrl` |
| `packages/cmaf-lite/test/dash/dash_parser.test.ts` | Existing behavior tests (unchanged) + new `updateManifest` behavior tests |
| `packages/cmaf-lite/test/dash/dash_segments.test.ts` | Existing behavior tests (unchanged) |

Dependency graph (acyclic, leaves at right):

```
dash_parser → dash_periods → dash_adaptations
                   ↓
              dash_segments
```

---

## Task 1: Segments layer rewrite

Rewrite `dash_segments.ts` to expose `appendSegments` instead of `parseSegmentData`. Introduce pure slot generators. Absorb `resolveBaseUrl` from `dash_periods.ts`. Temporarily adapt the single callsite in `dash_periods.ts`; structural changes to periods land in later tasks.

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_segments.ts`
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts` (callsite only)

- [ ] **Step 1: Replace `dash_segments.ts` contents**

Overwrite the file with:

```ts
import { processUriTemplate } from "@svta/cml-dash";
import type * as txml from "txml";
import type { InitSegment, Segment } from "../types/manifest";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";

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

  const st = resolveSegmentTemplate(period, adaptationSet, representation);

  const initialization = XmlUtils.attr(
    st,
    "initialization",
    XmlUtils.parseString,
  );
  asserts.assertExists(initialization, "initialization is mandatory");
  const media = XmlUtils.attr(st, "media", XmlUtils.parseString);
  asserts.assertExists(media, "media is mandatory");

  const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  const timescale = XmlUtils.attr(st, "timescale", XmlUtils.parseNumber) ?? 1;
  const startNumber =
    XmlUtils.attr(st, "startNumber", XmlUtils.parseNumber) ?? 1;
  const pto =
    XmlUtils.attr(st, "presentationTimeOffset", XmlUtils.parseNumber) ?? 0;
  const periodStart =
    XmlUtils.attr(period, "start", XmlUtils.parseDuration) ?? 0;

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

export function resolveBaseUrl(
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

function getTimelineSlots(
  timeline: txml.TNode,
  startNumber: number,
): Slot[] {
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

function resolveSegmentTemplate(
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): txml.TNode {
  const templates = [
    XmlUtils.child(representation, "SegmentTemplate"),
    XmlUtils.child(adaptationSet, "SegmentTemplate"),
    XmlUtils.child(period, "SegmentTemplate"),
  ].filter((t): t is txml.TNode => t !== undefined);

  if (templates.length === 0) {
    throw new Error("We've got to have some sort of templating");
  }

  const attributes: Record<string, string | null> = {};
  for (const t of templates.slice().reverse()) {
    Object.assign(attributes, t.attributes);
  }

  const segmentTimeline = Functional.findMap(templates, (t) =>
    XmlUtils.child(t, "SegmentTimeline"),
  );

  return {
    tagName: "SegmentTemplate",
    attributes,
    children: segmentTimeline ? [segmentTimeline] : [],
  };
}
```

- [ ] **Step 2: Update the callsite in `dash_periods.ts`**

Inside `parseRepresentation` (currently at `lib/dash/dash_periods.ts:127`), replace the block that computed `baseUrl`, extracted `bandwidth`, and called `parseSegmentData` with a call to `appendSegments` on a fresh array. The rest of `parseRepresentation` (building the Track) is unchanged in this task; it keeps returning a full Track that `mergeTrack` then merges.

Change the file-level import at the top of `dash_periods.ts` from:

```ts
import { parseSegmentData } from "./dash_segments";
```

to:

```ts
import { appendSegments } from "./dash_segments";
```

Also remove the now-unused imports that lived only to support `resolveBaseUrl` in this file — keep the ones still used by the remaining `parseRepresentation` / resolver code. Inspect the imports block after edits and drop any newly-unused names.

Replace the body of `parseRepresentation` (from the `const id = ...` through the final `return` statements) with:

```ts
function parseRepresentation(
  type: MediaType,
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  duration: number | null,
): Track {
  const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  asserts.assertExists(id, "Representation@id is mandatory");

  const bandwidth = XmlUtils.attr(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );
  asserts.assertExists(bandwidth, "bandwidth is mandatory");

  const segments: Segment[] = [];
  const maxSegmentDuration = appendSegments(
    segments,
    sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
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
    return {
      id,
      type,
      width,
      height,
      bandwidth,
      segments,
      maxSegmentDuration,
    };
  }
  if (type === MediaType.AUDIO) {
    return { id, type, bandwidth, segments, maxSegmentDuration };
  }
  if (type === MediaType.SUBTITLE) {
    return { id, type, bandwidth, segments, maxSegmentDuration };
  }
  throw new Error("Unsupported media type");
}
```

Add the missing `Segment` import at the top of the file:

```ts
import type { Segment, SwitchingSet, Track } from "../types/manifest";
```

Delete the `resolveBaseUrl` function from `dash_periods.ts` (it now lives in `dash_segments.ts`).

- [ ] **Step 3: Run all DASH tests**

Run from the repo root:

```bash
pnpm --filter cmaf-lite test -- dash
```

Expected: all tests pass. The refactor is behavior-preserving, so the existing fixture tests in `dash_parser.test.ts` and `dash_segments.test.ts` are the regression harness.

- [ ] **Step 4: Run format + type check**

```bash
pnpm format
pnpm tsc
```

Expected: no diagnostics, no file rewrites.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_segments.ts packages/cmaf-lite/lib/dash/dash_periods.ts
git commit -m "refactor(dash): appendSegments with slot generators

Replace parseSegmentData with appendSegments that pushes into a
caller-provided target and returns maxSegmentDuration. Extract pure
slot generators (getTimelineSlots, getDurationSlots) behind a single
URL/timing loop. Move resolveBaseUrl into dash_segments.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `dash_adaptations.ts` and split `buildTrack`

Move skeleton constructors and ID/type/codec resolution to a new module. Split `parseRepresentation` into a skeleton-only `buildTrack` (no segment parsing) — `dash_periods.ts` still calls the segments layer separately for now.

**Files:**
- Create: `packages/cmaf-lite/lib/dash/dash_adaptations.ts`
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts`

- [ ] **Step 1: Create `dash_adaptations.ts`**

Write the new file:

```ts
import type * as txml from "txml";
import type { SwitchingSet, Track } from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as LanguageUtils from "../utils/language_utils";
import * as XmlUtils from "../utils/xml_utils";

export function getAdaptationSetId(
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

export function parseAdaptationSet(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const id = getAdaptationSetId(adaptationSet, representations);
  const type = resolveType(adaptationSet, representations);
  const codec = resolveCodec(adaptationSet, representations);

  if (type === MediaType.VIDEO) {
    return {
      id,
      type,
      codec,
      tracks: [],
    };
  }
  if (type === MediaType.AUDIO) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return {
      id,
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
      id,
      type,
      codec,
      language,
      tracks: [],
    };
  }
  throw new Error("Unsupported media type");
}

export function buildTrack(
  type: MediaType,
  id: string,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const bandwidth = XmlUtils.attr(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );
  asserts.assertExists(bandwidth, "bandwidth is mandatory");

  if (type === MediaType.VIDEO) {
    const width = Functional.findMap([representation, adaptationSet], (n) =>
      XmlUtils.attr(n, "width", XmlUtils.parseNumber),
    );
    asserts.assertExists(width, "width is mandatory");
    const height = Functional.findMap([representation, adaptationSet], (n) =>
      XmlUtils.attr(n, "height", XmlUtils.parseNumber),
    );
    asserts.assertExists(height, "height is mandatory");
    return {
      id,
      type,
      width,
      height,
      bandwidth,
      segments: [],
      maxSegmentDuration: 0,
    };
  }
  if (type === MediaType.AUDIO) {
    return { id, type, bandwidth, segments: [], maxSegmentDuration: 0 };
  }
  if (type === MediaType.SUBTITLE) {
    return { id, type, bandwidth, segments: [], maxSegmentDuration: 0 };
  }
  throw new Error("Unsupported media type");
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
```

- [ ] **Step 2: Rewrite `dash_periods.ts` to delegate**

Open `packages/cmaf-lite/lib/dash/dash_periods.ts`. Replace the whole file contents with:

```ts
import type * as txml from "txml";
import type { Segment, SwitchingSet, Track } from "../types/manifest";
import * as asserts from "../utils/asserts";
import * as XmlUtils from "../utils/xml_utils";
import {
  buildTrack,
  getAdaptationSetId,
  parseAdaptationSet,
} from "./dash_adaptations";
import { appendSegments } from "./dash_segments";

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
      let switchingSet = switchingSetsById.get(setId);
      if (!switchingSet) {
        switchingSet = parseAdaptationSet(adaptationSet, representations);
        switchingSetsById.set(setId, switchingSet);
      }

      for (const representation of representations) {
        const trackId = XmlUtils.attr(
          representation,
          "id",
          XmlUtils.parseString,
        );
        asserts.assertExists(trackId, "Representation@id is mandatory");
        const key = `${setId}:${trackId}`;

        let track = tracksById.get(key);
        if (!track) {
          track = buildTrack(
            switchingSet.type,
            trackId,
            adaptationSet,
            representation,
          );
          asserts.assert(
            track.type === switchingSet.type,
            "Track type must match SwitchingSet type",
          );
          tracksById.set(key, track);
          (switchingSet.tracks as Track[]).push(track);
        }

        const max = appendSegments(
          track.segments,
          sourceUrl,
          mpd,
          period,
          adaptationSet,
          representation,
          duration,
        );
        track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
      }
    }
  }

  return [...switchingSetsById.values()];
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

This already pre-stages Task 3's upsert flow inside `flattenPeriods`: a local `tracksById` short-circuits the "track already exists" case by appending directly, and `mergeTrack` / `mergeTrackSegments` / old `parseRepresentation` are gone.

Notice that the `Segment` import is retained — even though the current file doesn't directly use `Segment[]` outside of the transitive `track.segments`, future edits will. If Biome complains about an unused import, remove it.

- [ ] **Step 3: Run all DASH tests**

```bash
pnpm --filter cmaf-lite test -- dash
```

Expected: all tests pass.

- [ ] **Step 4: Run format + type check**

```bash
pnpm format
pnpm tsc
```

Expected: no diagnostics. If Biome removes the unused `Segment` import, accept the fix.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_adaptations.ts packages/cmaf-lite/lib/dash/dash_periods.ts
git commit -m "refactor(dash): extract dash_adaptations and split buildTrack

Move SwitchingSet / Track skeleton construction and ID/type/codec
resolvers into a new dash_adaptations module. Split parseRepresentation
into a skeleton-only buildTrack; segments are appended separately via
appendSegments. Merge the track-already-exists path directly into
flattenPeriods (mergeTrack / mergeTrackSegments deleted).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `ApplyContext` + upsert helpers

Introduce the transient upsert index. Add `createContext`, `upsertSwitchingSet`, `upsertTrack` to `dash_adaptations.ts`. Rewrite `flattenPeriods` as `applyPeriods(ctx, …)` operating on the context.

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_adaptations.ts`
- Modify: `packages/cmaf-lite/lib/dash/dash_periods.ts`

- [ ] **Step 1: Add `ApplyContext`, `createContext`, `upsertSwitchingSet`, `upsertTrack` to `dash_adaptations.ts`**

Add at the top of the file (below the existing imports), a new `Manifest` type import plus the new exports. The new imports line:

```ts
import type { Manifest, SwitchingSet, Track } from "../types/manifest";
```

(Replace the existing `import type { SwitchingSet, Track } from "../types/manifest";` line.)

Add these exports directly after the imports and before `getAdaptationSetId`:

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
    track = buildTrack(
      switchingSet.type,
      trackId,
      adaptationSet,
      representation,
    );
    asserts.assert(
      track.type === switchingSet.type,
      "Track type must match SwitchingSet type",
    );
    ctx.tracksById.set(key, track);
    (switchingSet.tracks as Track[]).push(track);
  }
  return track;
}
```

- [ ] **Step 2: Rewrite `flattenPeriods` as `applyPeriods` in `dash_periods.ts`**

Replace the whole file with:

```ts
import type * as txml from "txml";
import * as asserts from "../utils/asserts";
import * as XmlUtils from "../utils/xml_utils";
import {
  type ApplyContext,
  upsertSwitchingSet,
  upsertTrack,
} from "./dash_adaptations";
import { appendSegments } from "./dash_segments";

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
      const representations = XmlUtils.children(
        adaptationSet,
        "Representation",
      );
      if (representations.length === 0) {
        continue;
      }

      const switchingSet = upsertSwitchingSet(
        ctx,
        adaptationSet,
        representations,
      );

      for (const representation of representations) {
        const track = upsertTrack(
          ctx,
          switchingSet,
          adaptationSet,
          representation,
        );
        const max = appendSegments(
          track.segments,
          sourceUrl,
          mpd,
          period,
          adaptationSet,
          representation,
          periodDuration,
        );
        track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
      }
    }
  }
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

- [ ] **Step 3: Type check to find all broken callers**

```bash
pnpm tsc
```

Expected: `dash_parser.ts` fails because `flattenPeriods` no longer exists. That's the next task's wiring — leave the failure for now. Do NOT commit yet.

(If there are other unexpected failures, diagnose before moving on.)

---

## Task 4: Entry points — `parseManifest` + `updateManifest`

Wire `applyMpd` through the context and expose the public API. Once this lands, `pnpm tsc` is clean again.

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts`

- [ ] **Step 1: Replace `dash_parser.ts` contents**

```ts
import type * as txml from "txml";
import type { Manifest, SwitchingSet } from "../types/manifest";
import * as asserts from "../utils/asserts";
import * as XmlUtils from "../utils/xml_utils";
import { createContext } from "./dash_adaptations";
import { applyPeriods } from "./dash_periods";

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

function applyMpd(
  manifest: Manifest,
  text: string,
  sourceUrl: string,
): void {
  const mpd = XmlUtils.parseXml(text, "MPD");

  const periods = XmlUtils.children(mpd, "Period");
  if (periods.length === 0) {
    throw new Error("No Period found in manifest");
  }

  const ctx = createContext(manifest);
  applyPeriods(ctx, sourceUrl, mpd, periods);
  manifest.duration = resolveDuration(mpd, manifest.switchingSets);
}

function resolveDuration(
  mpd: txml.TNode,
  switchingSets: SwitchingSet[],
): number {
  const mpdDuration = XmlUtils.attr(
    mpd,
    "mediaPresentationDuration",
    XmlUtils.parseDuration,
  );
  if (mpdDuration != null) {
    return mpdDuration;
  }

  const lastSegmentEnd = switchingSets[0]?.tracks[0]?.segments.at(-1)?.end;
  asserts.assertExists(lastSegmentEnd, "Cannot resolve duration");
  return lastSegmentEnd;
}
```

- [ ] **Step 2: Run all DASH tests**

```bash
pnpm --filter cmaf-lite test -- dash
```

Expected: all tests pass. The public `parseManifest` signature is unchanged; the rewrite is behavior-preserving.

- [ ] **Step 3: Run format + type check**

```bash
pnpm format
pnpm tsc
```

Expected: clean.

- [ ] **Step 4: Run the full package test suite as a wider safety net**

```bash
pnpm --filter cmaf-lite test
```

Expected: all tests pass. Any failure elsewhere means a downstream consumer of the Manifest tree broke — investigate before proceeding.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_adaptations.ts packages/cmaf-lite/lib/dash/dash_periods.ts packages/cmaf-lite/lib/dash/dash_parser.ts
git commit -m "refactor(dash): ApplyContext and updateManifest entry point

Introduce ApplyContext as the transient per-call upsert index,
populated from the existing Manifest on the update path. Rewrite
flattenPeriods as applyPeriods over the context. Expose updateManifest
alongside parseManifest; both share applyMpd. Manifest / SwitchingSet
/ Track / Segment identity is preserved across updates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `updateManifest` behavior tests

Verify identity preservation and extension semantics with a dedicated test suite. Fixture-based, leveraging the existing `loadFixture` helper.

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test suite**

Append this `describe` block to the end of `dash_parser.test.ts` (inside the module scope, after the existing `describe("DashParser", …)` block):

```ts
describe("DashParser.updateManifest", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  it("preserves manifest, switching set, track, and segment references when applied twice to the same MPD", () => {
    const text = loadFixture("basic.mpd");
    const manifest = parseManifest(text, sourceUrl);

    const switchingSetsRef = manifest.switchingSets;
    const firstSet = switchingSetsRef[0]!;
    const firstTrack = firstSet.tracks[0]!;
    const tracksRef = firstSet.tracks;
    const segmentsRef = firstTrack.segments;
    const firstSegment = segmentsRef[0]!;
    const segmentCount = segmentsRef.length;

    updateManifest(manifest, text, sourceUrl);

    expect(manifest.switchingSets).toBe(switchingSetsRef);
    expect(manifest.switchingSets[0]).toBe(firstSet);
    expect(firstSet.tracks).toBe(tracksRef);
    expect(firstSet.tracks[0]).toBe(firstTrack);
    expect(firstTrack.segments).toBe(segmentsRef);
    expect(firstTrack.segments[0]).toBe(firstSegment);
    expect(firstTrack.segments.length).toBeGreaterThanOrEqual(segmentCount);
  });

  it("extends an existing track's segments when a second MPD adds tail segments", () => {
    const sourceText = loadFixture("timeline.mpd");
    const manifest = parseManifest(sourceText, sourceUrl);

    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const track = video.tracks[0]!;
    const originalSegments = track.segments;
    const originalCount = originalSegments.length;
    const originalFirst = originalSegments[0]!;
    const originalLast = originalSegments.at(-1)!;

    const extendedText = sourceText.replace(
      /<S t="0" d="90000" r="\d+" \/>/,
      (match) => {
        const rMatch = /r="(\d+)"/.exec(match);
        const nextR = rMatch ? Number(rMatch[1]) + 5 : 5;
        return `<S t="0" d="90000" r="${nextR}" />`;
      },
    );
    updateManifest(manifest, extendedText, sourceUrl);

    expect(track.segments).toBe(originalSegments);
    expect(track.segments.length).toBeGreaterThan(originalCount);
    expect(track.segments[0]).toBe(originalFirst);
    expect(track.segments[originalCount - 1]).toBe(originalLast);
  });
});
```

Add `updateManifest` to the imports at the top of the file:

```ts
import { parseManifest, updateManifest } from "../../lib/dash/dash_parser";
```

- [ ] **Step 2: Verify the tests fail for the right reason**

Before Task 4's wiring landed they wouldn't build at all; after Task 4 they should build but the second test may or may not already pass. Run:

```bash
pnpm --filter cmaf-lite test -- dash_parser
```

Expected: if any test fails, inspect the failure message before editing. The first test (double-apply of the same MPD) should pass immediately. The second test depends on the `timeline.mpd` fixture having a pattern that matches the regex.

- [ ] **Step 3: Confirm `timeline.mpd` matches the regex**

```bash
grep -n '<S t="0" d="90000" r=' packages/cmaf-lite/test/fixtures/timeline.mpd
```

Expected: at least one line found. If no line matches, open the fixture, read the first `<S>` element, and adjust the regex in the test to match the actual shape (keep the same semantic: extend the repeat count).

- [ ] **Step 4: Rerun the new test suite**

```bash
pnpm --filter cmaf-lite test -- dash_parser
```

Expected: all tests pass, including both new cases.

- [ ] **Step 5: Acknowledge the append-only caveat**

The spec documents that duplicate-suppression on append is deferred. The `expect(…).toBeGreaterThanOrEqual(segmentCount)` in the first test intentionally tolerates duplication (static `basic.mpd` will parse identically both times — count stays equal). Do NOT add a `.toBe(segmentCount)` assertion; that would lock in a contract the spec explicitly defers.

- [ ] **Step 6: Run format + type check + full suite**

```bash
pnpm format
pnpm tsc
pnpm --filter cmaf-lite test
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "test(dash): updateManifest identity preservation

Covers the two primary guarantees: applying the same MPD twice keeps
every Manifest, SwitchingSet, Track, and Segment reference; applying
an MPD with additional tail slots extends the existing segments array
in place.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Final step: Top-level scripts**

```bash
pnpm format
pnpm tsc
pnpm test
```

Expected: clean across all packages.

---

## Self-review

### Spec coverage

- Two entry points, shared core → Task 4 (`applyMpd` under `parseManifest` / `updateManifest`).
- `ApplyContext` + `createContext` → Task 3.
- `applyPeriods` over a context → Task 3.
- `upsertSwitchingSet` / `upsertTrack` → Task 3.
- `buildTrack` skeleton-only → Task 2.
- `appendSegments` with `getTimelineSlots` / `getDurationSlots` → Task 1.
- Bandwidth / baseUrl extraction pushed down into `appendSegments` → Task 1.
- `resolveBaseUrl` moved to `dash_segments.ts` → Task 1.
- File layout split (`dash_adaptations.ts` new) → Task 2.
- Deletions (`mergeTrack`, `mergeTrackSegments`, old `parseRepresentation`, `parseSegmentData`, `mapTemplateTimeline`, `mapTemplateDuration`, `SegmentData`) → across Tasks 1–3.
- Identity guarantees under update → Task 5 (tests).

### Type consistency

- `ApplyContext` type used identically in all three functions (`createContext`, `upsertSwitchingSet`, `upsertTrack`, `applyPeriods`).
- `appendSegments` signature `(target, sourceUrl, mpd, period, adaptationSet, representation, periodDuration): number` used identically in `dash_periods.ts` and tests.
- `buildTrack(type, id, adaptationSet, representation)` — no `bandwidth` parameter (extracted internally); consistent between Task 2 and Task 3's `upsertTrack` call.

### Scope of known limitations

Identity derivation (`getAdaptationSetId`) is preserved byte-identical by this plan. The spec's "Known limitations" section points at the follow-up roadmap entry; no task here changes identity logic.
