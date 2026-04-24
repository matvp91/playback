# Live Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support live DASH presentations end-to-end: periodic manifest refreshes with identity-preserving segment reconciliation, initial playback positioned behind the live edge, and MSE duration set to `Infinity` for unbounded presentations.

**Architecture:** `ManifestController` grows a unified `Timer`-driven `fetchAndApply_` method that either creates (first call) or updates (subsequent) the manifest, rescheduling when `manifest.isLive`. `DashParser.appendSegments` gains a `startAfter` watermark and returns `firstAvailableStart` so refreshes only materialize new segments; `ManifestUtils.pruneSegments` trims the expired head. `StreamController` caches `isLive_` to suppress EOS, extracts `getInitialTime_` for live-edge positioning, and rebuilds streams on `MANIFEST_UPDATED`. `BufferController` replaces its `manifest_` ref with a plain `duration_: number | null` computed as `Infinity` for live.

**Tech Stack:** TypeScript, Vitest (happy-dom), Biome, pnpm.

**Spec:** [docs/superpowers/specs/2026-04-23-live-playback-design.md](../specs/2026-04-23-live-playback-design.md)

---

## File structure

| File | Role after change |
|---|---|
| `packages/cmaf-lite/lib/types/manifest.ts` | `Manifest` gains `isLive: boolean` field |
| `packages/cmaf-lite/lib/events.ts` | `MANIFEST_PARSED` renamed to `MANIFEST_CREATED`; new `MANIFEST_UPDATED` event |
| `packages/cmaf-lite/lib/config.ts` | Adds `liveDelay` (default 20), `liveUpdateTime` (default 2) |
| `packages/cmaf-lite/lib/utils/manifest_utils.ts` | Adds `pruneSegments(target, firstKeptStart)` |
| `packages/cmaf-lite/lib/dash/dash_parser.ts` | `appendSegments` takes `startAfter`, returns `{maxSegmentDuration, firstAvailableStart}`; `create` reads `MPD@type` to set `isLive`; `readRepresentation` threads `startAfter` from track tail and calls `pruneSegments` |
| `packages/cmaf-lite/lib/manifest/manifest_controller.ts` | Unified `fetchAndApply_` + `Timer` scheduler (VOD shares the same path, just doesn't reschedule) |
| `packages/cmaf-lite/lib/media/buffer_controller.ts` | Replace `manifest_` with `duration_: number \| null`; set to `Infinity` for live |
| `packages/cmaf-lite/lib/media/stream_controller.ts` | `isLive_` cache, `getInitialTime_`, EOS suppression, `MANIFEST_UPDATED` listener |
| `packages/cmaf-lite/test/fixtures/live-timeline-1.mpd` *(new)* | Initial snapshot for live reconciliation tests |
| `packages/cmaf-lite/test/fixtures/live-timeline-2.mpd` *(new)* | Shifted-timeline snapshot for live reconciliation tests |
| `packages/cmaf-lite/test/utils/manifest_utils.test.ts` | Adds `pruneSegments` tests |
| `packages/cmaf-lite/test/dash/dash_parser.test.ts` | Adds `isLive` + `update`-reconciliation tests |
| `packages/cmaf-lite/test/dash/dash_segments.test.ts` | Adds `startAfter` behavior tests |

---

## Conventions for this plan

- Commands are run from the repo root `/Users/matvp/Development/cmaf-lite` unless otherwise stated.
- `pnpm test` runs all tests across workspaces; `pnpm -C packages/cmaf-lite test path/to/file.test.ts` runs a single file.
- `pnpm tsc` runs type-check across workspaces.
- Commit at the end of each task with a Conventional Commits message (see prior commits for style).
- No controller-layer integration tests exist in this codebase; we follow that convention and verify controller wiring via type-check + manual demo-app validation rather than inventing a mocking framework. Unit-testable behavior (parser, utils) gets real tests.

---

## Task 1: Rename `MANIFEST_PARSED` → `MANIFEST_CREATED`

Mechanical rename across events + three controllers. Keeps behavior identical; reserves the name `MANIFEST_CREATED` for the (forthcoming) symmetry with `MANIFEST_UPDATED`.

**Files:**
- Modify: `packages/cmaf-lite/lib/events.ts`
- Modify: `packages/cmaf-lite/lib/manifest/manifest_controller.ts`
- Modify: `packages/cmaf-lite/lib/media/buffer_controller.ts`
- Modify: `packages/cmaf-lite/lib/media/stream_controller.ts`

- [ ] **Step 1: Confirm green baseline**

Run: `pnpm test && pnpm tsc`
Expected: all tests pass, no type errors.

- [ ] **Step 2: Rename in `events.ts`**

In `packages/cmaf-lite/lib/events.ts`:

- Rename the const entry: `MANIFEST_PARSED: "manifestParsed"` → `MANIFEST_CREATED: "manifestCreated"`.
- Rename the interface: `ManifestParsedEvent` → `ManifestCreatedEvent` (body unchanged).
- Rename the JSDoc title `Fired when a manifest has been fetched and parsed.` → `Fired when a manifest has been fetched and parsed for the first time.`
- Rename the EventMap key: `[Events.MANIFEST_PARSED]: (event: ManifestParsedEvent) => void;` → `[Events.MANIFEST_CREATED]: (event: ManifestCreatedEvent) => void;`.

- [ ] **Step 3: Update `manifest_controller.ts`**

In `packages/cmaf-lite/lib/manifest/manifest_controller.ts`, update the emit call:

```ts
this.player_.emit(Events.MANIFEST_CREATED, { manifest });
```

- [ ] **Step 4: Update `buffer_controller.ts`**

In `packages/cmaf-lite/lib/media/buffer_controller.ts`:

- Import rename: `ManifestParsedEvent` → `ManifestCreatedEvent`.
- Handler rename: `onManifestParsed_` → `onManifestCreated_` (method body unchanged beyond the parameter type).
- Event-bus `on`/`off`: `Events.MANIFEST_PARSED` → `Events.MANIFEST_CREATED` in both `constructor` and `destroy`.

- [ ] **Step 5: Update `stream_controller.ts`**

In `packages/cmaf-lite/lib/media/stream_controller.ts`:

- Import rename: `ManifestParsedEvent` → `ManifestCreatedEvent`.
- Handler rename: `onManifestParsed_` → `onManifestCreated_`.
- Event-bus `on`/`off`: `Events.MANIFEST_PARSED` → `Events.MANIFEST_CREATED` in both `constructor` and `destroy`.

- [ ] **Step 6: Run tests and type-check**

Run: `pnpm test && pnpm tsc`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cmaf-lite/lib/events.ts \
        packages/cmaf-lite/lib/manifest/manifest_controller.ts \
        packages/cmaf-lite/lib/media/buffer_controller.ts \
        packages/cmaf-lite/lib/media/stream_controller.ts
git commit -m "refactor: Rename MANIFEST_PARSED to MANIFEST_CREATED"
```

---

## Task 2: Add `MANIFEST_UPDATED` event

Add the event constant, payload interface, and `EventMap` entry. No listeners yet — they land with the ManifestController task.

**Files:**
- Modify: `packages/cmaf-lite/lib/events.ts`

- [ ] **Step 1: Add to `events.ts`**

In `packages/cmaf-lite/lib/events.ts`:

Add to the `Events` const (directly after `MANIFEST_CREATED`):

```ts
MANIFEST_UPDATED: "manifestUpdated",
```

Add the interface next to `ManifestCreatedEvent`:

```ts
/**
 * Fired when a live manifest has been refreshed and reconciled in place.
 * Carries the same mutated manifest reference that consumers already hold.
 *
 * @public
 */
export interface ManifestUpdatedEvent {
  manifest: Manifest;
}
```

Add to `EventMap`:

```ts
[Events.MANIFEST_UPDATED]: (event: ManifestUpdatedEvent) => void;
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/lib/events.ts
git commit -m "feat: Add MANIFEST_UPDATED event"
```

---

## Task 3: Add `isLive` to `Manifest` + parse `MPD@type`

Adds the single new field on the public `Manifest` type and teaches `DashParser.create` to populate it from `MPD@type`. Static → `false`, `dynamic` → `true`. Missing `@type` defaults to `static` per spec.

**Files:**
- Modify: `packages/cmaf-lite/lib/types/manifest.ts`
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`
- Modify: `packages/cmaf-lite/test/__framework__/factories.ts`

- [ ] **Step 1: Write failing test — isLive false for static**

Append to `packages/cmaf-lite/test/dash/dash_parser.test.ts` (inside the top-level `describe("DashParser")`):

```ts
  it("sets isLive to false for a static MPD", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    expect(manifest.isLive).toBe(false);
  });

  it("sets isLive to true for a dynamic MPD", () => {
    const dynamicMpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>`;
    const manifest = DashParser.create(dynamicMpd, sourceUrl);
    expect(manifest.isLive).toBe(true);
  });
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/cmaf-lite test test/dash/dash_parser.test.ts`
Expected: FAIL. Both new tests fail on `manifest.isLive` (property does not exist on type `Manifest`).

- [ ] **Step 3: Add `isLive` to `Manifest` type**

In `packages/cmaf-lite/lib/types/manifest.ts`, modify the `Manifest` interface:

```ts
export interface Manifest {
  /** Total duration in seconds. For live, ignored — see {@link Manifest.isLive}. */
  duration: number;
  /** True if the presentation is live (dynamic); false for on-demand (static). */
  isLive: boolean;
  /** Groups of switchable tracks. */
  switchingSets: SwitchingSet[];
}
```

- [ ] **Step 4: Populate `isLive` in `DashParser.create`**

In `packages/cmaf-lite/lib/dash/dash_parser.ts`:

Change the `create` function so the initial manifest includes `isLive: false`, and update `readMpd` to read `MPD@type`:

```ts
export function create(text: string, sourceUrl: string): Manifest {
  const manifest: Manifest = { duration: 0, isLive: false, switchingSets: [] };
  const mpd = XmlUtils.parseXml(text, "MPD");
  readMpd(manifest, mpd, sourceUrl);
  return manifest;
}
```

In `readMpd`, after parsing periods and before the `manifest.duration` assignment at the end, add:

```ts
  const type = XmlUtils.attr(mpd, "type", XmlUtils.parseString);
  manifest.isLive = type === "dynamic";
```

(Place this *before* `manifest.duration = resolveDuration(...)` so both writes happen on every call, not just first.)

- [ ] **Step 5: Update the test factory**

In `packages/cmaf-lite/test/__framework__/factories.ts`, update `createManifest`:

```ts
export function createManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    duration: 60,
    isLive: false,
    switchingSets: [createVideoSwitchingSet(), createAudioSwitchingSet()],
    ...overrides,
  };
}
```

- [ ] **Step 6: Run — expect pass**

Run: `pnpm -C packages/cmaf-lite test && pnpm tsc`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cmaf-lite/lib/types/manifest.ts \
        packages/cmaf-lite/lib/dash/dash_parser.ts \
        packages/cmaf-lite/test/dash/dash_parser.test.ts \
        packages/cmaf-lite/test/__framework__/factories.ts
git commit -m "feat: Add isLive to Manifest and parse MPD@type"
```

---

## Task 4: Add `liveDelay` + `liveUpdateTime` to config

Pure config additions. No behavior change; consumed in later tasks.

**Files:**
- Modify: `packages/cmaf-lite/lib/config.ts`

- [ ] **Step 1: Add fields to `PlayerConfig`**

In `packages/cmaf-lite/lib/config.ts`, add to the `PlayerConfig` interface (after `maxSegmentLookupTolerance`):

```ts
  /**
   * Seconds behind the live edge to start playback for live presentations.
   * Ignored for on-demand manifests.
   */
  liveDelay: number;
  /**
   * Seconds between manifest refreshes for live presentations. Actual
   * cadence is `liveUpdateTime + fetchDuration` because refreshes are
   * scheduled after each response lands.
   */
  liveUpdateTime: number;
```

- [ ] **Step 2: Add defaults to `DEFAULT_CONFIG`**

In the same file, add to `DEFAULT_CONFIG` (after `maxSegmentLookupTolerance`):

```ts
  liveDelay: 20,
  liveUpdateTime: 2,
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/config.ts
git commit -m "feat: Add liveDelay and liveUpdateTime config"
```

---

## Task 5: Add live SegmentTimeline fixtures

Two MPD snapshots used by the reconciliation tests. Together they model a DVR window that advances by two segments between refreshes: segments with `start=0,4` roll off, `start=20,24` are new.

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/live-timeline-1.mpd`
- Create: `packages/cmaf-lite/test/fixtures/live-timeline-2.mpd`

- [ ] **Step 1: Create `live-timeline-1.mpd` (initial snapshot)**

File `packages/cmaf-lite/test/fixtures/live-timeline-1.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="dynamic"
     availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S"
     timeShiftBufferDepth="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="4" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

Segments: 5 total at `start=0,4,8,12,16`, each 4s long, `end=4,8,12,16,20`.

- [ ] **Step 2: Create `live-timeline-2.mpd` (shifted snapshot)**

File `packages/cmaf-lite/test/fixtures/live-timeline-2.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="dynamic"
     availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S"
     timeShiftBufferDepth="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="3">
        <SegmentTimeline>
          <S t="8000" d="4000" r="4" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

Segments: 5 total at `start=8,12,16,20,24`.

Overlap with fixture 1: `start=8,12,16` (kept across refresh). Expired head: `start=0,4`. New tail: `start=20,24`.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/fixtures/live-timeline-1.mpd \
        packages/cmaf-lite/test/fixtures/live-timeline-2.mpd
git commit -m "test: Add live SegmentTimeline fixtures"
```

---

## Task 6: Add `pruneSegments` to `manifest_utils`

Pure head-trim primitive keyed on `start`. No DASH knowledge.

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/manifest_utils.ts`
- Modify: `packages/cmaf-lite/test/utils/manifest_utils.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/cmaf-lite/test/utils/manifest_utils.test.ts` inside the top-level `describe("ManifestUtils")`:

```ts
  describe("pruneSegments", () => {
    it("removes segments with start below the threshold", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        createSegment({ start: 8, end: 12 }),
      ];
      pruneSegments(segments, 8);
      expect(segments).toHaveLength(1);
      expect(segments[0]!.start).toBe(8);
    });

    it("preserves object identity for kept segments", () => {
      const kept = createSegment({ start: 8, end: 12 });
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        kept,
      ];
      pruneSegments(segments, 8);
      expect(segments[0]).toBe(kept);
    });

    it("is a no-op when threshold is below the first segment", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
      ];
      pruneSegments(segments, -Infinity);
      expect(segments).toHaveLength(2);
    });

    it("is a no-op on an empty array", () => {
      const segments: Segment[] = [];
      pruneSegments(segments, 5);
      expect(segments).toHaveLength(0);
    });

    it("empties the array when threshold exceeds all starts", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
      ];
      pruneSegments(segments, 10);
      expect(segments).toHaveLength(0);
    });
  });
```

Update the import block at the top of the file to include `pruneSegments` and `Segment`:

```ts
import { describe, expect, it } from "vitest";
import type { Segment } from "../../lib/types/manifest";
import {
  isInitSegment,
  isMediaSegment,
  pruneSegments,
} from "../../lib/utils/manifest_utils";
import { createInitSegment, createSegment } from "../__framework__/factories";
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/cmaf-lite test test/utils/manifest_utils.test.ts`
Expected: FAIL on import — `pruneSegments` does not exist.

- [ ] **Step 3: Implement `pruneSegments`**

In `packages/cmaf-lite/lib/utils/manifest_utils.ts`, append:

```ts
/**
 * Remove segments from the head of `target` whose `start` is below
 * `firstKeptStart`. O(k) where k is the number removed — bounded by
 * the DVR window shift per refresh. Preserves object identity for
 * all kept segments.
 */
export function pruneSegments(
  target: Segment[],
  firstKeptStart: number,
): void {
  let count = 0;
  while (count < target.length && target[count]!.start < firstKeptStart) {
    count++;
  }
  if (count > 0) {
    target.splice(0, count);
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm -C packages/cmaf-lite test test/utils/manifest_utils.test.ts`
Expected: all new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/utils/manifest_utils.ts \
        packages/cmaf-lite/test/utils/manifest_utils.test.ts
git commit -m "feat: Add pruneSegments to manifest_utils"
```

---

## Task 7: `DashParser.appendSegments` takes `startAfter` + returns `firstAvailableStart`

Signature change. `appendSegments` stops materializing segments that are at or below the `startAfter` watermark (allocation-free fast-forward through skipped timeline entries) and reports the first `start` the MPD advertises back to the caller.

This task also updates the one caller (`readRepresentation`) with a minimal change — passes `-Infinity` as `startAfter` and destructures the new return. Actual reconciliation wiring lands in Task 8.

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts`
- Modify: `packages/cmaf-lite/test/dash/dash_segments.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/cmaf-lite/test/dash/dash_segments.test.ts` inside the top-level `describe("DashSegments")`:

```ts
  describe("startAfter delta behavior", () => {
    it("emits all segments when startAfter is -Infinity", () => {
      // timeline.mpd: <S t="0" d="360000" r="2"/> with timescale=90000 → 3 segments
      //   at start = 0, 4, 8
      const segments: Segment[] = [];
      const mpd = XmlUtils.parseXml(loadFixture("timeline.mpd"), "MPD");
      const period = XmlUtils.child(mpd, "Period")!;
      const adaptationSet = XmlUtils.child(period, "AdaptationSet")!;
      const representation = XmlUtils.child(adaptationSet, "Representation")!;

      const { firstAvailableStart } = DashParser.appendSegments(
        segments, sourceUrl, mpd, period, adaptationSet, representation,
        /* periodDuration */ 12,
        /* startAfter */ -Infinity,
      );

      expect(segments).toHaveLength(3);
      expect(segments.map((s) => s.start)).toEqual([0, 4, 8]);
      expect(firstAvailableStart).toBe(0);
    });

    it("skips segments at or below startAfter and emits only newer ones", () => {
      const segments: Segment[] = [];
      const mpd = XmlUtils.parseXml(loadFixture("timeline.mpd"), "MPD");
      const period = XmlUtils.child(mpd, "Period")!;
      const adaptationSet = XmlUtils.child(period, "AdaptationSet")!;
      const representation = XmlUtils.child(adaptationSet, "Representation")!;

      const { firstAvailableStart } = DashParser.appendSegments(
        segments, sourceUrl, mpd, period, adaptationSet, representation,
        12,
        /* startAfter */ 4,
      );

      // segments with start <= 4 are skipped (start=0 and start=4)
      expect(segments).toHaveLength(1);
      expect(segments[0]!.start).toBe(8);
      // firstAvailableStart reports the MPD's earliest segment, not the emitted one
      expect(firstAvailableStart).toBe(0);
    });
  });
```

Add the necessary imports at the top of the file (if not already present):

```ts
import type { Segment } from "../../lib/types/manifest";
import * as XmlUtils from "../../lib/utils/xml_utils";
```

Note: `DashParser.appendSegments` is currently not exported. Make it exported in Step 3.

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/cmaf-lite test test/dash/dash_segments.test.ts`
Expected: FAIL — either `DashParser.appendSegments` is not exported, or the new signature doesn't match.

- [ ] **Step 3: Export and reshape `appendSegments`**

In `packages/cmaf-lite/lib/dash/dash_parser.ts`:

Replace the current `appendSegments` function with the new signature + implementation:

```ts
export function appendSegments(
  target: Segment[],
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodDuration: number | null,
  startAfter: number,
): { maxSegmentDuration: number; firstAvailableStart: number } {
  const baseUrl = resolveBaseUrl(
    sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
  );
  const bandwidth = XmlUtils.attrRequired(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );

  const segmentTemplate = resolveSegmentTemplate(
    period,
    adaptationSet,
    representation,
  );

  const initialization = XmlUtils.attrRequired(
    segmentTemplate,
    "initialization",
    XmlUtils.parseString,
  );
  const media = XmlUtils.attrRequired(
    segmentTemplate,
    "media",
    XmlUtils.parseString,
  );
  const id = XmlUtils.attrRequired(representation, "id", XmlUtils.parseString);

  const timescale = XmlUtils.attr(
    segmentTemplate,
    "timescale",
    XmlUtils.parseNumber,
    1,
  );
  const startNumber = XmlUtils.attr(
    segmentTemplate,
    "startNumber",
    XmlUtils.parseNumber,
    1,
  );
  const presentationTimeOffset = XmlUtils.attr(
    segmentTemplate,
    "presentationTimeOffset",
    XmlUtils.parseNumber,
    0,
  );
  const periodStart = XmlUtils.attr(period, "start", XmlUtils.parseDuration, 0);

  const uri = processUriTemplate(
    initialization,
    id,
    null,
    null,
    bandwidth,
    null,
  );
  const initSegment: InitSegment = {
    url: UrlUtils.resolveUrl(uri, baseUrl),
  };

  let maxSegmentDuration = 0;
  let firstAvailableStart = Number.POSITIVE_INFINITY;

  const timeline = XmlUtils.child(segmentTemplate, "SegmentTimeline");
  if (timeline) {
    let time = 0;
    let number = startNumber;
    for (const timelineEntry of XmlUtils.children(timeline, "S")) {
      const duration = XmlUtils.attrRequired(
        timelineEntry,
        "d",
        XmlUtils.parseNumber,
      );
      const repeat = XmlUtils.attr(timelineEntry, "r", XmlUtils.parseNumber, 0);
      time = XmlUtils.attr(timelineEntry, "t", XmlUtils.parseNumber, time);

      // Record the first segment start this MPD advertises (in presentation seconds)
      if (firstAvailableStart === Number.POSITIVE_INFINITY) {
        firstAvailableStart =
          (time - presentationTimeOffset) / timescale + periodStart;
      }

      for (let i = 0; i <= repeat; i++) {
        const start = (time - presentationTimeOffset) / timescale + periodStart;
        const end =
          (time - presentationTimeOffset + duration) / timescale + periodStart;

        // Skip segments already materialized (start <= startAfter). Advance
        // time/number arithmetically without invoking URL templating.
        if (start <= startAfter) {
          time += duration;
          number++;
          continue;
        }

        const uri = processUriTemplate(
          media,
          id,
          number,
          null,
          bandwidth,
          time,
        );
        const url = UrlUtils.resolveUrl(uri, baseUrl);

        target.push({ url, start, end, initSegment });

        maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
        time += duration;
        number++;
      }
    }

    if (firstAvailableStart === Number.POSITIVE_INFINITY) {
      firstAvailableStart = periodStart;
    }
    return { maxSegmentDuration, firstAvailableStart };
  }

  asserts.assertExists(
    periodDuration,
    "Duration-based addressing requires a resolvable period duration",
  );

  const duration = XmlUtils.attrRequired(
    segmentTemplate,
    "duration",
    XmlUtils.parseNumber,
  );

  const count = Math.ceil(periodDuration / (duration / timescale));
  for (let i = 0; i < count; i++) {
    const number = startNumber + i;
    const time = i * duration;
    const start = (time - presentationTimeOffset) / timescale + periodStart;
    const end =
      (time - presentationTimeOffset + duration) / timescale + periodStart;

    if (i === 0) {
      firstAvailableStart = start;
    }

    if (start <= startAfter) {
      continue;
    }

    const uri = processUriTemplate(media, id, number, null, bandwidth, time);
    const url = UrlUtils.resolveUrl(uri, baseUrl);
    target.push({ url, start, end, initSegment });
    maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
  }

  if (firstAvailableStart === Number.POSITIVE_INFINITY) {
    firstAvailableStart = periodStart;
  }
  return { maxSegmentDuration, firstAvailableStart };
}
```

Note: the function gains the `export` keyword so the tests can reach it directly.

- [ ] **Step 4: Update the in-file caller (`readRepresentation`)**

Still in `packages/cmaf-lite/lib/dash/dash_parser.ts`, update `readRepresentation` to thread `-Infinity` and destructure the new return shape:

```ts
function readRepresentation(
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  switchingSet: SwitchingSet,
  periodDuration: number | null,
): void {
  const track = upsertTrack(ctx, switchingSet, adaptationSet, representation);
  const { maxSegmentDuration } = appendSegments(
    track.segments,
    ctx.sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
    periodDuration,
    /* startAfter */ -Infinity,
  );
  track.maxSegmentDuration = Math.max(
    track.maxSegmentDuration,
    maxSegmentDuration,
  );
}
```

Note: the positional `ctx` → `sourceUrl` change — `appendSegments` now takes `sourceUrl` directly instead of receiving `ctx`. Drop the `ctx` parameter from `appendSegments`'s signature (done in Step 3) and pass `ctx.sourceUrl` at the callsite.

- [ ] **Step 5: Run — expect pass**

Run: `pnpm -C packages/cmaf-lite test && pnpm tsc`
Expected: all existing tests stay green (initial-parse behavior unchanged when `startAfter = -Infinity`); new `startAfter` tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_parser.ts \
        packages/cmaf-lite/test/dash/dash_segments.test.ts
git commit -m "feat: DashParser appendSegments accepts startAfter watermark"
```

---

## Task 8: Reconciliation in `readRepresentation` (tail append + head prune)

Wire the `startAfter` watermark and `pruneSegments` into the update path. After this task, `DashParser.update` on a shifted-timeline MPD preserves overlapping segment identity, appends new tail segments, and prunes expired head segments.

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/cmaf-lite/test/dash/dash_parser.test.ts` inside the top-level `describe("DashParser")`:

```ts
  describe("update — live reconciliation", () => {
    it("appends new tail segments and prunes expired head segments", () => {
      const manifest = DashParser.create(
        loadFixture("live-timeline-1.mpd"),
        sourceUrl,
      );
      const track = manifest.switchingSets[0]!.tracks[0]!;
      expect(track.segments.map((s) => s.start)).toEqual([0, 4, 8, 12, 16]);

      DashParser.update(manifest, loadFixture("live-timeline-2.mpd"), sourceUrl);

      // After update: DVR window shifted — start=0,4 pruned, start=20,24 appended
      expect(track.segments.map((s) => s.start)).toEqual([8, 12, 16, 20, 24]);
    });

    it("preserves object identity for overlapping segments across an update", () => {
      const manifest = DashParser.create(
        loadFixture("live-timeline-1.mpd"),
        sourceUrl,
      );
      const track = manifest.switchingSets[0]!.tracks[0]!;
      const kept = [track.segments[2]!, track.segments[3]!, track.segments[4]!];

      DashParser.update(manifest, loadFixture("live-timeline-2.mpd"), sourceUrl);

      // Segments that straddle both MPD snapshots must remain the same object references.
      expect(track.segments[0]).toBe(kept[0]);
      expect(track.segments[1]).toBe(kept[1]);
      expect(track.segments[2]).toBe(kept[2]);
    });

    it("preserves Track and SwitchingSet identity across an update", () => {
      const manifest = DashParser.create(
        loadFixture("live-timeline-1.mpd"),
        sourceUrl,
      );
      const switchingSet = manifest.switchingSets[0]!;
      const track = switchingSet.tracks[0]!;

      DashParser.update(manifest, loadFixture("live-timeline-2.mpd"), sourceUrl);

      expect(manifest.switchingSets[0]).toBe(switchingSet);
      expect(switchingSet.tracks[0]).toBe(track);
      expect(switchingSet.tracks[0]!.segments).toBe(track.segments);
    });
  });
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/cmaf-lite test test/dash/dash_parser.test.ts`
Expected: FAIL. After update, the segments list will still contain segments 0 and 4 (not pruned), and may double up on overlap (not deduped).

- [ ] **Step 3: Wire `startAfter` + `pruneSegments` in `readRepresentation`**

In `packages/cmaf-lite/lib/dash/dash_parser.ts`:

Add the `ManifestUtils` import at the top:

```ts
import * as ManifestUtils from "../utils/manifest_utils";
```

Update `readRepresentation` to derive `startAfter` from the existing tail and prune after the append:

```ts
function readRepresentation(
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  switchingSet: SwitchingSet,
  periodDuration: number | null,
): void {
  const track = upsertTrack(ctx, switchingSet, adaptationSet, representation);
  const startAfter = track.segments.at(-1)?.start ?? -Infinity;
  const { maxSegmentDuration, firstAvailableStart } = appendSegments(
    track.segments,
    ctx.sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
    periodDuration,
    startAfter,
  );
  ManifestUtils.pruneSegments(track.segments, firstAvailableStart);
  track.maxSegmentDuration = Math.max(
    track.maxSegmentDuration,
    maxSegmentDuration,
  );
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm -C packages/cmaf-lite test && pnpm tsc`
Expected: all existing + new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_parser.ts \
        packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "feat: Reconcile segments on manifest update via startAfter and pruneSegments"
```

---

## Task 9: `BufferController` — replace `manifest_` with `duration_`

Decouple BufferController from the full `Manifest` object. It only needs the final MSE `duration` value — `Infinity` for live, `manifest.duration` for VOD.

**Files:**
- Modify: `packages/cmaf-lite/lib/media/buffer_controller.ts`

- [ ] **Step 1: Replace `manifest_` field with `duration_`**

In `packages/cmaf-lite/lib/media/buffer_controller.ts`:

Replace the `private manifest_: Manifest | null = null;` declaration with:

```ts
  private duration_: number | null = null;
```

Remove the now-unused `Manifest` import if TypeScript flags it after the rest of this task.

- [ ] **Step 2: Update `onManifestCreated_` handler**

Replace the body of `onManifestCreated_`:

```ts
  private onManifestCreated_ = (event: ManifestCreatedEvent) => {
    this.duration_ = event.manifest.isLive
      ? Infinity
      : event.manifest.duration;
    this.updateDuration_();
  };
```

- [ ] **Step 3: Update `updateDuration_`**

Replace the body:

```ts
  private updateDuration_() {
    if (this.duration_ === null || this.mediaSource_?.readyState !== "open") {
      return;
    }
    if (this.mediaSource_.duration === this.duration_) {
      return;
    }
    const duration = this.duration_;
    this.blockUntil(() => {
      if (this.mediaSource_?.readyState === "open") {
        this.mediaSource_.duration = duration;
        log.info("Duration updated", duration);
      }
    });
  }
```

(Capture `duration` locally before `blockUntil` so the closure doesn't need the non-null assertion or re-check.)

- [ ] **Step 4: Update `destroy`**

In `destroy()`, replace `this.manifest_ = null;` with `this.duration_ = null;`.

- [ ] **Step 5: Run tests + type-check**

Run: `pnpm test && pnpm tsc`
Expected: all green. No tests changed, but type-check must pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/media/buffer_controller.ts
git commit -m "refactor: BufferController holds duration_ instead of manifest_"
```

---

## Task 10: `ManifestController` — unified `Timer`-driven fetch loop

Growth: `Manifest` held across the controller's lifetime, `Timer` drives both initial load (via `tickNow`) and live refresh (via `tickAfter`), unified `fetchAndApply_` branches on `manifest_` presence.

**Files:**
- Modify: `packages/cmaf-lite/lib/manifest/manifest_controller.ts`

- [ ] **Step 1: Rewrite `manifest_controller.ts`**

Replace the entire file with:

```ts
import * as DashParser from "../dash/dash_parser";
import type { ManifestLoadingEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import type { Manifest } from "../types/manifest";
import { ABORTED, NetworkRequestType } from "../types/net";
import * as asserts from "../utils/asserts";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";

const log = Log.create("ManifestController");

export class ManifestController {
  private manifest_: Manifest | null = null;
  private sourceUrl_: string | null = null;
  private request_: NetworkRequest | null = null;
  private timer_ = new Timer(() => this.fetchAndApply_());

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  destroy() {
    const networkService = this.player_.getNetworkService();
    if (this.request_) {
      networkService.cancel(this.request_);
    }
    this.timer_.stop();
    this.player_.off(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  private onManifestLoading_ = (event: ManifestLoadingEvent) => {
    this.sourceUrl_ = event.url;
    this.timer_.tickNow();
  };

  private fetchAndApply_ = async () => {
    asserts.assertExists(this.sourceUrl_, "No source URL");

    const networkService = this.player_.getNetworkService();
    const config = this.player_.getConfig();
    this.request_ = networkService.request(
      NetworkRequestType.MANIFEST,
      this.sourceUrl_,
      config.manifestRequestOptions,
    );

    const response = await this.request_.promise;
    if (response === ABORTED) {
      this.scheduleNext_();
      return;
    }

    if (!this.manifest_) {
      this.manifest_ = DashParser.create(response.text, response.request.url);
      log.info("Manifest created", this.manifest_);
      this.player_.emit(Events.MANIFEST_CREATED, { manifest: this.manifest_ });
    } else {
      DashParser.update(this.manifest_, response.text, response.request.url);
      log.info("Manifest updated", this.manifest_);
      this.player_.emit(Events.MANIFEST_UPDATED, { manifest: this.manifest_ });
    }

    this.scheduleNext_();
  };

  private scheduleNext_() {
    if (this.manifest_?.isLive) {
      this.timer_.tickAfter(this.player_.getConfig().liveUpdateTime);
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no type errors.

- [ ] **Step 3: Run existing tests**

Run: `pnpm test`
Expected: all existing tests still pass. No ManifestController tests exist; behavior is covered by downstream tests and the DashParser update-reconciliation tests from Task 8.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/manifest/manifest_controller.ts
git commit -m "feat: Live manifest refresh via Timer in ManifestController"
```

---

## Task 11: `StreamController` — live positioning, EOS suppression, update listener

Three behavioral additions:

1. Cache `isLive_` from `MANIFEST_CREATED`.
2. Extract `getInitialTime_` and use it to set `media.currentTime` before the tick loop starts (returns 0 for VOD, `liveEdge - liveDelay` for live).
3. Suppress EOS for live (reaching end of `track.segments` means "wait for next refresh") and rebuild streams on `MANIFEST_UPDATED`.

**Files:**
- Modify: `packages/cmaf-lite/lib/media/stream_controller.ts`

- [ ] **Step 1: Add `isLive_` field and cache on `MANIFEST_CREATED`**

In `packages/cmaf-lite/lib/media/stream_controller.ts`:

Add the field near the other private state:

```ts
  private isLive_ = false;
```

Update `onManifestCreated_` to cache it (keep existing logic, just add the line at the top):

```ts
  private onManifestCreated_ = (event: ManifestCreatedEvent) => {
    this.isLive_ = event.manifest.isLive;
    this.streamsMap_ = StreamUtils.buildStreams(event.manifest);
    log.info("Streams", this.streamsMap_);
    this.player_.emit(Events.STREAMS_UPDATED);
    this.tryStart_();
  };
```

- [ ] **Step 2: Add `getInitialTime_` and call it in `tryStart_`**

Add the helper near the private methods section:

```ts
  private getInitialTime_(stream: Stream): number {
    if (!this.isLive_) {
      return 0;
    }
    const { segments } = stream.hierarchy.track;
    const liveEdge = segments.at(-1)?.end ?? 0;
    const firstSegmentStart = segments[0]?.start ?? 0;
    const { liveDelay } = this.player_.getConfig();
    return Math.max(liveEdge - liveDelay, firstSegmentStart);
  }
```

In `tryStart_`, after the media-state construction loop and before `mediaState.timer.tickEvery(TICK_INTERVAL)` runs, set the initial time if live using the video stream when present (else the first available stream):

Replace the tail of `tryStart_` (the current trailing loop that starts timers):

```ts
    if (this.isLive_ && this.media_) {
      const videoStream = this.streams_.get(MediaType.VIDEO);
      const referenceStream = videoStream ?? this.streams_.values().next().value;
      if (referenceStream) {
        this.media_.currentTime = this.getInitialTime_(referenceStream);
      }
    }

    for (const mediaState of this.mediaStates_.values()) {
      mediaState.timer.tickEvery(TICK_INTERVAL);
    }
```

(The loop that fills `this.streams_` must run *before* this block — it already does in the existing code.)

- [ ] **Step 3: Suppress EOS when live**

Update `isEnded_`:

```ts
  private isEnded_(mediaState: MediaState, stream: Stream): boolean {
    if (this.isLive_) {
      return false;
    }
    if (!mediaState.lastSegment) {
      return false;
    }
    const { segments } = stream.hierarchy.track;
    return segments.indexOf(mediaState.lastSegment) === segments.length - 1;
  }
```

- [ ] **Step 4: Listen for `MANIFEST_UPDATED`**

Add a handler and wire it in `constructor` + `destroy`:

Constructor, after existing `.on` calls:

```ts
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
```

Destroy, after existing `.off` calls:

```ts
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
```

New handler:

```ts
  private onManifestUpdated_ = (event: ManifestUpdatedEvent) => {
    this.streamsMap_ = StreamUtils.buildStreams(event.manifest);
    this.player_.emit(Events.STREAMS_UPDATED);
  };
```

Update imports at the top of the file to include `ManifestUpdatedEvent`:

```ts
import type {
  AdaptationEvent,
  BufferFlushedEvent,
  ManifestCreatedEvent,
  ManifestUpdatedEvent,
  MediaAttachedEvent,
} from "../events";
```

- [ ] **Step 5: Type-check + tests**

Run: `pnpm test && pnpm tsc`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/media/stream_controller.ts
git commit -m "feat: StreamController live positioning and EOS suppression"
```

---

## Task 12: Manual verification via demo app

No controller-level integration tests exist; verify the end-to-end live flow by pointing the demo app at a live stream.

**Files:** none (manual verification).

- [ ] **Step 1: Run the demo**

Run from repo root: `pnpm dev`
Expected: demo app serves on localhost.

- [ ] **Step 2: Load a live manifest**

Navigate to the demo page. Point the player at a dynamic DASH manifest. The repo already includes a test live-stream URL in the branch — inspect `packages/demo/` for existing examples, or use any public live DASH source.

- [ ] **Step 3: Verify live behavior**

Confirm:
- Playback starts near the live edge (~`liveDelay` seconds behind `segments.at(-1).end`).
- `MANIFEST_UPDATED` events fire at roughly `liveUpdateTime` cadence (observable via `player.on(Events.MANIFEST_UPDATED, ...)` or log output).
- Playback continues across refreshes without stalling at the end of the initial segment list (EOS suppression).
- Video element's reported duration is `Infinity`.
- Reloading the page and loading a VOD manifest still works (regression check).

- [ ] **Step 4: If issues surface, fix and commit separately**

Any issues found during manual verification get their own commit(s) with a `fix:` prefix.

---

## Self-review checklist

Spec coverage:
- `Manifest.isLive` added — Task 3 ✓
- `timeShiftBufferDepth` absent from `Manifest` — confirmed ✓
- Parser `startAfter` + `firstAvailableStart` — Task 7 ✓
- `manifest_utils.pruneSegments` — Task 6 ✓
- Reconciliation in `readRepresentation` — Task 8 ✓
- `ManifestController` Timer refresh loop — Task 10 ✓
- `MANIFEST_CREATED` rename + `MANIFEST_UPDATED` — Tasks 1, 2 ✓
- `liveDelay`, `liveUpdateTime` config — Task 4 ✓
- `StreamController.getInitialTime_`, EOS suppression, update listener — Task 11 ✓
- `BufferController` `duration_` refactor — Task 9 ✓
- Live SegmentTimeline fixture — Task 5 ✓

Deliberately out of scope (from spec non-goals):
- Drift correction
- `seekToLive()` / `isLiveEdge()` APIs
- `setLiveSeekableRange`
- Empty-track / empty-switching-set cleanup
- `MANIFEST_ERROR` event
- `backBufferLength` auto-tuning
- Live `SegmentTemplate + @duration`
- LL-DASH, MPD patching, `UTCTiming`, dynamic→static handoff
