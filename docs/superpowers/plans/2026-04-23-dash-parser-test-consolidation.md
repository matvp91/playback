# DASH Parser Test Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate DASH parser tests into a single integration-only suite driven by MPD fixtures, fill audit-surfaced coverage gaps, and document the multi-period update pruning bug as a skipped test.

**Architecture:** All tests parse MPD fixtures through the public API (`DashParser.create` / `DashParser.update`) and assert on the resulting `Manifest`. Fixtures live under `packages/cmaf-lite/test/fixtures/dash-parser/` with `vod-` / `live-` prefixes and `-N` suffixes for update sequences. Pure helpers (`packages/cmaf-lite/test/dash/helpers.ts`) keep individual tests terse.

**Tech Stack:** TypeScript, Vitest, Biome, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-04-23-dash-parser-test-consolidation-design.md](../specs/2026-04-23-dash-parser-test-consolidation-design.md)

---

## Testing Commands

Run from repo root:

- All tests: `pnpm test -- --run`
- DASH tests only: `pnpm -F cmaf-lite test -- --run dash_parser`
- Type check: `pnpm tsc`
- Lint/format: `pnpm format`

---

## File Structure

**Create:**
- `packages/cmaf-lite/test/dash/helpers.ts`
- `packages/cmaf-lite/test/fixtures/dash-parser/` directory + 26 `.mpd` files

**Modify:**
- `packages/cmaf-lite/test/dash/dash_parser.test.ts`
- `packages/cmaf-lite/lib/dash/dash_parser.ts` (un-export `appendSegments`)

**Delete:**
- `packages/cmaf-lite/test/dash/dash_segments.test.ts`
- Existing fixtures under `packages/cmaf-lite/test/fixtures/*.mpd` (moved/renamed)

---

## Notes on executing

- Every task ends in a working green build of `pnpm test -- --run` **except** Task 20 which adds an `it.skip` (still green because skipped).
- Use `git mv` for file renames so history is preserved.
- When writing MPD fixtures, keep indentation to 2 spaces and include the `<?xml version="1.0" encoding="UTF-8"?>` declaration and the `xmlns="urn:mpeg:dash:schema:mpd:2011"` namespace.
- Fixture content blocks in this plan are complete — paste them verbatim.

---

## Task 1: Create `helpers.ts`

**Files:**
- Create: `packages/cmaf-lite/test/dash/helpers.ts`

- [ ] **Step 1: Write the helpers file**

`packages/cmaf-lite/test/dash/helpers.ts`:

```ts
import type { Manifest, SwitchingSet } from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";

export function findVideo(
  manifest: Manifest,
): SwitchingSet & { type: MediaType.VIDEO } {
  const ss = manifest.switchingSets.find(
    (s): s is SwitchingSet & { type: MediaType.VIDEO } =>
      s.type === MediaType.VIDEO,
  );
  if (!ss) throw new Error("No video switching set found");
  return ss;
}

export function findAudio(
  manifest: Manifest,
): SwitchingSet & { type: MediaType.AUDIO } {
  const ss = manifest.switchingSets.find(
    (s): s is SwitchingSet & { type: MediaType.AUDIO } =>
      s.type === MediaType.AUDIO,
  );
  if (!ss) throw new Error("No audio switching set found");
  return ss;
}

export function findSubtitle(
  manifest: Manifest,
): SwitchingSet & { type: MediaType.SUBTITLE } {
  const ss = manifest.switchingSets.find(
    (s): s is SwitchingSet & { type: MediaType.SUBTITLE } =>
      s.type === MediaType.SUBTITLE,
  );
  if (!ss) throw new Error("No subtitle switching set found");
  return ss;
}
```

- [ ] **Step 2: Type check**

Run: `pnpm tsc`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/dash/helpers.ts
git commit -m "test(dash): add shared test helpers"
```

---

## Task 2: Move + rename existing fixtures to `dash-parser/` subdir

This task only moves files; content is unchanged. Test references update in the same commit.

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/` directory
- Move + rename 10 existing `.mpd` files
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`
- Modify: `packages/cmaf-lite/test/dash/dash_segments.test.ts`

**Rename mapping:**
- `basic.mpd` → `dash-parser/vod-basic.mpd`
- `subtitle.mpd` → `dash-parser/vod-subtitle.mpd`
- `mimetype-fallback.mpd` → `dash-parser/vod-mimetype-fallback.mpd`
- `inherited-template.mpd` → `dash-parser/vod-inherited-template.mpd`
- `timeline.mpd` → `dash-parser/vod-timeline.mpd`
- `timeline-reset.mpd` → `dash-parser/vod-timeline-reset.mpd`
- `multi-period.mpd` → `dash-parser/vod-multi-period.mpd`
- `live-timeline-1.mpd` → `dash-parser/live-timeline-sliding-1.mpd`
- `live-timeline-2.mpd` → `dash-parser/live-timeline-sliding-2.mpd`

Note: `vod-timeline.mpd` and `vod-timeline-reset.mpd` are distinct fixtures. `vod-timeline.mpd` is retained and used by the migrated timeline tests (Task 6).

- [ ] **Step 1: Create subdir and `git mv` each fixture**

```bash
mkdir -p packages/cmaf-lite/test/fixtures/dash-parser
cd packages/cmaf-lite/test/fixtures
git mv basic.mpd                dash-parser/vod-basic.mpd
git mv subtitle.mpd             dash-parser/vod-subtitle.mpd
git mv mimetype-fallback.mpd    dash-parser/vod-mimetype-fallback.mpd
git mv inherited-template.mpd   dash-parser/vod-inherited-template.mpd
git mv timeline.mpd             dash-parser/vod-timeline.mpd
git mv timeline-reset.mpd       dash-parser/vod-timeline-reset.mpd
git mv multi-period.mpd         dash-parser/vod-multi-period.mpd
git mv live-timeline-1.mpd      dash-parser/live-timeline-sliding-1.mpd
git mv live-timeline-2.mpd      dash-parser/live-timeline-sliding-2.mpd
cd -
```

- [ ] **Step 2: Update all `loadFixture` callsites**

In `packages/cmaf-lite/test/dash/dash_parser.test.ts` — replace the fixture paths throughout:
- `"basic.mpd"` → `"dash-parser/vod-basic.mpd"`
- `"subtitle.mpd"` → `"dash-parser/vod-subtitle.mpd"`
- `"mimetype-fallback.mpd"` → `"dash-parser/vod-mimetype-fallback.mpd"`
- `"multi-period.mpd"` → `"dash-parser/vod-multi-period.mpd"`
- `"timeline.mpd"` → `"dash-parser/vod-timeline.mpd"`
- `"live-timeline-1.mpd"` → `"dash-parser/live-timeline-sliding-1.mpd"`
- `"live-timeline-2.mpd"` → `"dash-parser/live-timeline-sliding-2.mpd"`

In `packages/cmaf-lite/test/dash/dash_segments.test.ts` — same renames:
- `"basic.mpd"` → `"dash-parser/vod-basic.mpd"`
- `"inherited-template.mpd"` → `"dash-parser/vod-inherited-template.mpd"`
- `"timeline.mpd"` → `"dash-parser/vod-timeline.mpd"`
- `"timeline-reset.mpd"` → `"dash-parser/vod-timeline-reset.mpd"`

- [ ] **Step 3: Run tests — verify still green (same set of passes/failures as before)**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: same results as pre-move — `dash_parser.test.ts` 24 passing, `dash_segments.test.ts` 7 passing + 3 failing (the known-broken `appendSegments`-signature tests).

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "test(dash): move fixtures into dash-parser/ with vod-/live- prefixes"
```

---

## Task 3: Refactor existing `dash_parser.test.ts` to use helpers

Reduces churn in later tasks. No fixture or test additions — just pattern swaps.

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Add helper import**

Add to the top of `packages/cmaf-lite/test/dash/dash_parser.test.ts` (after existing imports):

```ts
import { findAudio, findSubtitle, findVideo } from "../dash/helpers";
```

- [ ] **Step 2: Replace every `manifest.switchingSets.find(...)` with the helper**

Search for every occurrence of:
```ts
manifest.switchingSets.find((ss) => ss.type === MediaType.VIDEO)!
```
→ `findVideo(manifest)`

```ts
manifest.switchingSets.find((ss) => ss.type === MediaType.AUDIO)!
```
→ `findAudio(manifest)`

```ts
manifest.switchingSets.find((ss) => ss.type === MediaType.SUBTITLE)!
```
→ `findSubtitle(manifest)` (preserve any follow-up `type === MediaType.SUBTITLE` narrowing if still needed)

- [ ] **Step 3: Run tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: same test count, all previously passing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "test(dash): adopt findVideo/findAudio/findSubtitle helpers"
```

---

## Task 4: Create `vod-no-periods.mpd` and fixture-ize the inline test

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-no-periods.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-no-periods.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
</MPD>
```

- [ ] **Step 2: Replace the inline-MPD test**

In `packages/cmaf-lite/test/dash/dash_parser.test.ts`, replace the existing "throws when MPD contains no Period elements" test body (currently using an inline `emptyMpd` string) with:

```ts
it("throws when MPD contains no Period elements", () => {
  expect(() =>
    DashParser.create(loadFixture("dash-parser/vod-no-periods.mpd"), sourceUrl),
  ).toThrow();
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: same passing count.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/test/fixtures/dash-parser/vod-no-periods.mpd packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "test(dash): move no-periods MPD to fixture file"
```

---

## Task 5: Create `live-basic.mpd` and fixture-ize the inline dynamic test

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/live-basic.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/live-basic.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 2: Replace the inline "dynamic MPD" test**

In `packages/cmaf-lite/test/dash/dash_parser.test.ts`, replace the existing "sets isLive to true for a dynamic MPD" test body with:

```ts
it("sets isLive to true for a dynamic MPD", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/live-basic.mpd"),
    sourceUrl,
  );
  expect(manifest.isLive).toBe(true);
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: same passing count.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/test/fixtures/dash-parser/live-basic.mpd packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "test(dash): move dynamic MPD sample to live-basic.mpd"
```

---

## Task 6: Migrate `dash_segments.test.ts` tests into `dash_parser.test.ts`

Add the 7 working tests from `dash_segments.test.ts` (skipping the 3 broken `appendSegments` tests) into `dash_parser.test.ts` under appropriate `describe` blocks.

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Reorganize top-level `describe` into sub-sections**

In `packages/cmaf-lite/test/dash/dash_parser.test.ts`, wrap the existing top-level `describe("DashParser", ...)` body with nested describes. The final shape:

```ts
describe("DashParser", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  describe("structure", () => {
    // existing: parses basic MPD, extracts video/audio SS, dimensions,
    // mimeType fallback, maxSegmentDuration, subtitle AS, SS.id scheme,
    // Track.id, isLive false, isLive true
  });

  describe("segments", () => {
    // existing: segment URLs, segment count, multi-period flattening,
    // multi-period ordering, multi-period audio concat, subtitle segments
    // (NEW tests will be added in later tasks)
  });

  describe("errors", () => {
    // existing: throws when no Period
  });

  describe("update", () => { /* existing update tests */ });
  describe("update — live reconciliation", () => { /* existing */ });
});
```

Move each existing `it(...)` block into the appropriate sub-describe. Keep all test bodies unchanged. The `sourceUrl` constant stays at the outer scope.

- [ ] **Step 2: Add the 7 migrated tests**

Inside `describe("segments")`, append (these come from `dash_segments.test.ts`):

```ts
it("last segment covers the full presentation duration", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-basic.mpd"),
    sourceUrl,
  );
  const track = findVideo(manifest).tracks[0]!;
  expect(track.segments.at(-1)!.end).toBeCloseTo(60, 0);
});

it("produces contiguous segments with no gaps between them", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-basic.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  for (let i = 1; i < segments.length; i++) {
    expect(segments[i]!.start).toBeCloseTo(segments[i - 1]!.end, 5);
  }
});

it("attaches an init segment to every media segment", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-basic.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  for (const seg of segments) {
    expect(seg.initSegment).toBeDefined();
    expect(seg.initSegment.url).toContain("init");
  }
});

it("merges SegmentTemplate attributes from period, adaptation set, and representation levels", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-inherited-template.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // 12s / 4s = 3 segments
  expect(segments).toHaveLength(3);
  expect(segments[0]!.initSegment.url).toContain("video-init.mp4");
  expect(segments[0]!.url).toContain("video-");
});

it("generates the correct number of segments from SegmentTimeline with repeat count", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-timeline.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // r="2" means 3 total segments (original + 2 repeats)
  expect(segments).toHaveLength(3);
});

it("calculates correct start and end times from timeline entries", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-timeline.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  expect(segments[0]!.start).toBeCloseTo(0, 5);
  expect(segments[0]!.end).toBeCloseTo(4, 5);
  expect(segments[1]!.start).toBeCloseTo(4, 5);
  expect(segments[2]!.start).toBeCloseTo(8, 5);
});

it("resets segment time when S entry has explicit @t attribute", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-timeline-reset.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  expect(segments).toHaveLength(3);
  expect(segments[0]!.start).toBeCloseTo(0, 5);
  expect(segments[0]!.end).toBeCloseTo(4, 5);
  expect(segments[1]!.start).toBeCloseTo(4, 5);
  expect(segments[1]!.end).toBeCloseTo(8, 5);
  // Third segment: time reset to 900000/90000 = 10s
  expect(segments[2]!.start).toBeCloseTo(10, 5);
  expect(segments[2]!.end).toBeCloseTo(12, 5);
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: 7 more tests passing inside `dash_parser.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "test(dash): migrate dash_segments integration tests"
```

---

## Task 7: Delete `dash_segments.test.ts`

**Files:**
- Delete: `packages/cmaf-lite/test/dash/dash_segments.test.ts`

- [ ] **Step 1: Delete the file**

```bash
git rm packages/cmaf-lite/test/dash/dash_segments.test.ts
```

- [ ] **Step 2: Run tests**

Run: `pnpm -F cmaf-lite test -- --run`
Expected: all tests pass; the 3 previously-broken `appendSegments` tests are gone.

- [ ] **Step 3: Commit**

```bash
git commit -m "test(dash): delete dash_segments.test.ts (migrated to dash_parser.test.ts)"
```

---

## Task 8: Un-export `appendSegments`

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts`

- [ ] **Step 1: Remove the `export` keyword**

In `packages/cmaf-lite/lib/dash/dash_parser.ts`, change:

```ts
export function appendSegments(
```

to:

```ts
function appendSegments(
```

- [ ] **Step 2: Type check + run tests**

Run: `pnpm tsc`
Expected: passes.

Run: `pnpm -F cmaf-lite test -- --run`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "refactor(dash): make appendSegments internal"
```

---

## Task 9: Refit "idempotent update" test to use a live fixture

The existing test updates `vod-basic.mpd` (VOD) — semantically wrong since VOD manifests don't refresh. Switch to `live-timeline-sliding-1.mpd` fed twice.

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Swap the fixture in the idempotent test**

In `describe("update")`, the first test. Replace its body with:

```ts
it("preserves manifest, switching set, track, and segment references when applied twice to the same MPD", () => {
  const text = loadFixture("dash-parser/live-timeline-sliding-1.mpd");
  const manifest = DashParser.create(text, sourceUrl);

  const switchingSetsRef = manifest.switchingSets;
  const firstSet = switchingSetsRef[0]!;
  const firstTrack = firstSet.tracks[0]!;
  const tracksRef = firstSet.tracks;
  const segmentsRef = firstTrack.segments;
  const firstSegment = segmentsRef[0]!;
  const segmentCount = segmentsRef.length;

  DashParser.update(manifest, text, sourceUrl);

  expect(manifest.switchingSets).toBe(switchingSetsRef);
  expect(manifest.switchingSets[0]).toBe(firstSet);
  expect(firstSet.tracks).toBe(tracksRef);
  expect(firstSet.tracks[0]).toBe(firstTrack);
  expect(firstTrack.segments).toBe(segmentsRef);
  expect(firstTrack.segments[0]).toBe(firstSegment);
  expect(firstTrack.segments.length).toBe(segmentCount);
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: the idempotent update test still passes.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "test(dash): use live fixture for idempotent update test"
```

---

## Task 10: Create `live-timeline-growing-1.mpd` and `live-timeline-growing-2.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/live-timeline-growing-1.mpd`
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/live-timeline-growing-2.mpd`

- [ ] **Step 1: Create snapshot 1 (small window)**

`packages/cmaf-lite/test/fixtures/dash-parser/live-timeline-growing-1.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="dynamic"
     availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

→ produces segments at starts `[0, 4, 8]`.

- [ ] **Step 2: Create snapshot 2 (extended tail; head unchanged)**

`packages/cmaf-lite/test/fixtures/dash-parser/live-timeline-growing-2.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="dynamic"
     availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S">
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

→ produces segments at starts `[0, 4, 8, 12, 16]`. First three identical to snapshot 1.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/test/fixtures/dash-parser/live-timeline-growing-1.mpd packages/cmaf-lite/test/fixtures/dash-parser/live-timeline-growing-2.mpd
git commit -m "test(dash): add live-timeline-growing fixtures"
```

---

## Task 11: Refit "extends segments" test; drop the regex hack and `vod-timeline.mpd`

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

`vod-timeline.mpd` is retained — the migrated timeline tests (Task 6) still use it as a standalone VOD fixture.

- [ ] **Step 1: Rewrite "extends an existing track's segments" test**

In `describe("update")`, replace the second test body with:

```ts
it("extends an existing track's segments when a new snapshot adds tail segments", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/live-timeline-growing-1.mpd"),
    sourceUrl,
  );
  const track = findVideo(manifest).tracks[0]!;
  const originalSegments = track.segments;
  const originalCount = originalSegments.length;
  const originalFirst = originalSegments[0]!;
  const originalLast = originalSegments.at(-1)!;

  DashParser.update(
    manifest,
    loadFixture("dash-parser/live-timeline-growing-2.mpd"),
    sourceUrl,
  );

  expect(track.segments).toBe(originalSegments);
  expect(track.segments.length).toBeGreaterThan(originalCount);
  expect(track.segments[0]).toBe(originalFirst);
  expect(track.segments[originalCount - 1]).toBe(originalLast);
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: all tests pass; no regex-hacked MPDs anywhere.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "test(dash): rewrite extends-segments test with real live snapshots"
```

---

## Task 12: Add codec-fallback test + `vod-codec-on-adaptation-set.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-codec-on-adaptation-set.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("structure")`, add:

```ts
it("falls back to AdaptationSet codecs when Representation omits it", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-codec-on-adaptation-set.mpd"),
    sourceUrl,
  );
  expect(findVideo(manifest).codec).toBe("avc1.64001f");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "falls back to AdaptationSet codecs"`
Expected: FAIL (fixture doesn't exist).

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-codec-on-adaptation-set.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

Note: `codecs` is only on the AdaptationSet, not on the Representation.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "falls back to AdaptationSet codecs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover codec fallback from AdaptationSet to Representation"
```

---

## Task 13: Add multi-language audio test + `vod-multi-language-audio.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-language-audio.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("structure")`, add:

```ts
it("creates separate audio switching sets per language and normalizes lang='und' to 'unk'", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-multi-language-audio.mpd"),
    sourceUrl,
  );
  const audios = manifest.switchingSets.filter(
    (ss) => ss.type === MediaType.AUDIO,
  );
  const ids = audios.map((ss) => ss.id).sort();
  expect(ids).toEqual([
    "audio:mp4a.40.2:en",
    "audio:mp4a.40.2:fr",
    "audio:mp4a.40.2:unk",
  ]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "creates separate audio switching sets"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-language-audio.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
      <SegmentTemplate timescale="48000" media="audio-en-$Number$.m4s" initialization="audio-en-init.mp4" startNumber="1" duration="192000" />
      <Representation id="a-en" bandwidth="128000" />
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="fr">
      <SegmentTemplate timescale="48000" media="audio-fr-$Number$.m4s" initialization="audio-fr-init.mp4" startNumber="1" duration="192000" />
      <Representation id="a-fr" bandwidth="128000" />
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="und">
      <SegmentTemplate timescale="48000" media="audio-und-$Number$.m4s" initialization="audio-und-init.mp4" startNumber="1" duration="192000" />
      <Representation id="a-und" bandwidth="128000" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "creates separate audio switching sets"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover multi-language audio and und->unk normalization"
```

---

## Task 14: Add empty-AS test + `vod-no-representations.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-no-representations.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("structure")`, add:

```ts
it("drops AdaptationSets with zero Representations", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-no-representations.mpd"),
    sourceUrl,
  );
  // One valid video AS + one empty audio AS; only video survives.
  expect(manifest.switchingSets).toHaveLength(1);
  expect(manifest.switchingSets[0]!.type).toBe(MediaType.VIDEO);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "drops AdaptationSets with zero"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-no-representations.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="video-$Number$.m4s" initialization="video-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
      <SegmentTemplate timescale="48000" media="audio-$Number$.m4s" initialization="audio-init.mp4" startNumber="1" duration="192000" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "drops AdaptationSets with zero"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover AdaptationSet with zero Representations"
```

---

## Task 15: Add multi-period SegmentTimeline test + `vod-multi-period-timeline.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-period-timeline.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("flattens a multi-period SegmentTimeline manifest into one track with concatenated segments", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-multi-period-timeline.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // Period 1: [0, 4, 8] (3 segments); Period 2: [12, 16, 20] (3 segments)
  expect(segments.map((s) => s.start)).toEqual([0, 4, 8, 12, 16, 20]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "flattens a multi-period SegmentTimeline"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-period-timeline.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT24S">
  <Period duration="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="p1-video-$Number$.m4s" initialization="video-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
  <Period start="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="p2-video-$Number$.m4s" initialization="video-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "flattens a multi-period SegmentTimeline"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover multi-period SegmentTimeline static parse"
```

---

## Task 16: Add asymmetric-representations test + `vod-multi-period-asymmetric.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-period-asymmetric.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("accepts asymmetric Representations across periods (Period 2 adds a new track)", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-multi-period-asymmetric.mpd"),
    sourceUrl,
  );
  const video = findVideo(manifest);
  // Period 1 has id=1; Period 2 has id=1 and id=2. Expect 2 tracks total.
  expect(video.tracks).toHaveLength(2);
  const ids = video.tracks.map((t) => t.id).sort();
  expect(ids).toEqual(["1", "2"]);
  // The extra track (id=2) has only Period 2 segments.
  const extra = video.tracks.find((t) => t.id === "2")!;
  expect(extra.segments.length).toBeGreaterThan(0);
  expect(extra.segments[0]!.start).toBeGreaterThanOrEqual(30);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "accepts asymmetric Representations"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-period-asymmetric.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period duration="PT30S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="p1-v$RepresentationID$-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
  <Period start="PT30S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="p2-v$RepresentationID$-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
      <Representation id="2" bandwidth="1000000" width="1280" height="720" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "accepts asymmetric Representations"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover asymmetric representations across periods"
```

---

## Task 17: Add startNumber continuity test + `vod-multi-period-startnumber.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-period-startnumber.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("continues segment numbering across periods via @startNumber", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-multi-period-startnumber.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // Period 1 starts at number 1, segment URL "v-1.m4s".
  // Period 2 starts at number 8, so first p2 URL is "v-8.m4s".
  const p2First = segments.find((s) => s.start >= 30);
  expect(p2First).toBeDefined();
  expect(p2First!.url).toContain("v-8.m4s");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "continues segment numbering"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-multi-period-startnumber.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period duration="PT30S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
  <Period start="PT30S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="8" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "continues segment numbering"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover @startNumber continuity across periods"
```

---

## Task 18: Add `$Bandwidth$` and `$RepresentationID$` placeholder tests + `vod-url-placeholders.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-url-placeholders.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing tests**

In `describe("segments")`, add:

```ts
it("expands $Bandwidth$ placeholder in segment URLs", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-url-placeholders.mpd"),
    sourceUrl,
  );
  const track = findVideo(manifest).tracks[0]!;
  expect(track.segments[0]!.url).toContain("2000000");
});

it("expands $RepresentationID$ placeholder in segment URLs", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-url-placeholders.mpd"),
    sourceUrl,
  );
  const track = findVideo(manifest).tracks[0]!;
  expect(track.segments[0]!.url).toContain("rep-1");
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "expands \\$Bandwidth"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-url-placeholders.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="$RepresentationID$-$Bandwidth$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" startNumber="1" duration="360000" />
      <Representation id="rep-1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "expands"`
Expected: PASS.

Also assert init segment URL includes `rep-1` (already produced by this fixture — can add as an extra assertion inside either test if you want).

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover \\$Bandwidth\\$ and \\$RepresentationID\\$ URL placeholders"
```

---

## Task 19: Add presentationTimeOffset test + `vod-presentation-time-offset.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-presentation-time-offset.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("applies @presentationTimeOffset to segment start and end times", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-presentation-time-offset.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // timescale=1000, pto=10000, duration=4000
  // First S: t=10000 → start = (10000 - 10000) / 1000 = 0; end = 4.
  expect(segments[0]!.start).toBeCloseTo(0, 5);
  expect(segments[0]!.end).toBeCloseTo(4, 5);
  expect(segments[1]!.start).toBeCloseTo(4, 5);
  expect(segments[2]!.start).toBeCloseTo(8, 5);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "presentationTimeOffset"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-presentation-time-offset.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" presentationTimeOffset="10000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="10000" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "presentationTimeOffset"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover @presentationTimeOffset arithmetic"
```

---

## Task 20: Add template-inheritance tests + expand `vod-inherited-template.mpd`

The current `vod-inherited-template.mpd` already covers `initialization` and `media` inheritance. Expand it so `startNumber`, `duration`, and `presentationTimeOffset` are also inherited from the Period-level SegmentTemplate.

**Files:**
- Modify: `packages/cmaf-lite/test/fixtures/dash-parser/vod-inherited-template.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Expand the fixture**

Replace the content of `packages/cmaf-lite/test/fixtures/dash-parser/vod-inherited-template.mpd` with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S">
  <Period>
    <SegmentTemplate timescale="1000" startNumber="5" duration="4000" presentationTimeOffset="8000" />
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

Note: `timescale`, `startNumber`, `duration`, `presentationTimeOffset` live on the Period-level `SegmentTemplate`; `media` and `initialization` on the AdaptationSet level.

- [ ] **Step 2: Update the already-migrated template-inheritance test to match the new URL prefix**

The migrated test (from Task 6) asserts the URL contains `video-`. With the updated fixture the URL now contains `v-`. Segment count stays at 3 (duration/timescale still yields 4s per segment and the period is 12s).

Find in `describe("segments")`:

```ts
it("merges SegmentTemplate attributes from period, adaptation set, and representation levels", () => {
```

Replace body with:

```ts
it("merges SegmentTemplate attributes from period, adaptation set, and representation levels", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-inherited-template.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // periodDuration=12s, pto=8s, timescale=1000, duration=4000
  // Segment count = ceil(12 / (4000/1000)) = 3
  expect(segments).toHaveLength(3);
  expect(segments[0]!.initSegment.url).toContain("v-init.mp4");
  expect(segments[0]!.url).toContain("v-");
});
```

- [ ] **Step 3: Write the 3 new inheritance tests**

Append to `describe("segments")`:

```ts
it("inherits @startNumber from a Period-level SegmentTemplate", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-inherited-template.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // startNumber=5 on Period template → first segment URL contains "v-5.m4s"
  expect(segments[0]!.url).toContain("v-5.m4s");
});

it("inherits @duration from a Period-level SegmentTemplate", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-inherited-template.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // duration=4000/timescale=1000 → 4s per segment
  expect(segments[0]!.end - segments[0]!.start).toBeCloseTo(4, 5);
});

it("inherits @presentationTimeOffset from a Period-level SegmentTemplate", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-inherited-template.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // pto=8000, timescale=1000. Duration-based addressing uses time=i*duration,
  // so start = (0 - 8000)/1000 = -8 for the first segment.
  expect(segments[0]!.start).toBeCloseTo(-8, 5);
});
```

Note: the third test verifies pto is *applied*, even when negative start results. If the engineer finds this assertion surprising — that's correct parser behavior per the spec (see `dash_parser.ts` lines computing `start = (time - presentationTimeOffset) / timescale`).

- [ ] **Step 4: Run all tests**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: all previously-passing tests + 3 new inheritance tests pass.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover inherited @startNumber/@duration/@presentationTimeOffset"
```

---

## Task 21: Add BaseURL test + `vod-base-url.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-base-url.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("resolves <BaseURL> at every level (MPD / Period / AdaptationSet / Representation)", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-base-url.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  const url = segments[0]!.url;
  // Final URL should resolve through all four BaseURL levels:
  // mpd/ + period/ + as/ + rep/ + v-1.m4s
  expect(url).toContain("mpd/");
  expect(url).toContain("period/");
  expect(url).toContain("as/");
  expect(url).toContain("rep/");
  expect(url).toContain("v-1.m4s");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "BaseURL"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-base-url.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S">
  <BaseURL>mpd/</BaseURL>
  <Period>
    <BaseURL>period/</BaseURL>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <BaseURL>as/</BaseURL>
      <SegmentTemplate timescale="1000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="4000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080">
        <BaseURL>rep/</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "BaseURL"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover hierarchical BaseURL resolution"
```

---

## Task 22: Add timeline-wins test + `vod-timeline-with-duration.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-timeline-with-duration.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("uses SegmentTimeline when both @duration and <SegmentTimeline> are present", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-timeline-with-duration.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // SegmentTimeline has r=2 → 3 segments. @duration is ignored.
  expect(segments).toHaveLength(3);
  expect(segments[0]!.end - segments[0]!.start).toBeCloseTo(4, 5);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "both @duration and"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-timeline-with-duration.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="9999999">
        <SegmentTimeline>
          <S t="0" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

`@duration` is a deliberately-absurd value to make clear the timeline is winning.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "both @duration and"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover SegmentTimeline precedence over @duration"
```

---

## Task 23: Add no-template error test + `vod-no-template.mpd`

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/vod-no-template.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("errors")`, add:

```ts
it("throws when no SegmentTemplate is declared at any level", () => {
  expect(() =>
    DashParser.create(
      loadFixture("dash-parser/vod-no-template.mpd"),
      sourceUrl,
    ),
  ).toThrow();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "no SegmentTemplate"`
Expected: FAIL.

- [ ] **Step 3: Create the fixture**

`packages/cmaf-lite/test/fixtures/dash-parser/vod-no-template.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "no SegmentTemplate"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): cover missing-SegmentTemplate error"
```

---

## Task 24: Add explicit `$Time$` placeholder assertion on existing fixture

The `vod-timeline-reset.mpd` fixture already uses `$Time$` in its media template (`video-$Number$-$Time$.m4s`). Pin the behavior with an explicit test.

**Files:**
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Write the failing test**

In `describe("segments")`, add:

```ts
it("expands $Time$ placeholder in segment URLs", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/vod-timeline-reset.mpd"),
    sourceUrl,
  );
  const segments = findVideo(manifest).tracks[0]!.segments;
  // Timeline: t=0 d=360000 r=1, then t=900000 d=180000.
  // First segment time=0, third time=900000.
  expect(segments[0]!.url).toContain("-0.m4s");
  expect(segments[2]!.url).toContain("-900000.m4s");
});
```

- [ ] **Step 2: Run the test — should already pass (behavior exists, fixture is unchanged)**

Run: `pnpm -F cmaf-lite test -- --run dash_parser -t "\\$Time\\$"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "test(dash): assert \\$Time\\$ placeholder expansion"
```

---

## Task 25: Add multi-period-update skip test + `live-multi-period-timeline-1/-2.mpd`

This documents the known pruning bug. The test is `it.skip` and will flip to `it` when the fix lands.

**Files:**
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/live-multi-period-timeline-1.mpd`
- Create: `packages/cmaf-lite/test/fixtures/dash-parser/live-multi-period-timeline-2.mpd`
- Modify: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

- [ ] **Step 1: Create snapshot 1**

`packages/cmaf-lite/test/fixtures/dash-parser/live-multi-period-timeline-1.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="dynamic"
     availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S">
  <Period duration="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="p1-v-$Number$.m4s" initialization="v-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
  <Period start="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="p2-v-$Number$.m4s" initialization="v-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="1" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

Segments: Period 1 at starts `[0, 4, 8]`, Period 2 at starts `[12, 16]`. Total 5.

- [ ] **Step 2: Create snapshot 2 (DVR slid forward by one segment duration)**

`packages/cmaf-lite/test/fixtures/dash-parser/live-multi-period-timeline-2.mpd`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="dynamic"
     availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S">
  <Period duration="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="p1-v-$Number$.m4s" initialization="v-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="4000" d="4000" r="1" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
  <Period start="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="1000" media="p2-v-$Number$.m4s" initialization="v-init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="2" />
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>
```

Segments: Period 1 at starts `[4, 8]` (start=0 dropped), Period 2 at starts `[12, 16, 20]` (new tail). Total 5.

- [ ] **Step 3: Add the skipped test**

In `describe("update")`, append:

```ts
// SKIPPED: multi-period update currently wipes all Period 1 segments because
// Period 2's firstAvailableStart (>= 30s equivalent) is fed through
// pruneSegments, which truncates everything below it. Fix tracked in a
// follow-up brainstorm. When fixed, flip `it.skip` to `it`.
// See: docs/superpowers/specs/2026-04-23-dash-parser-test-consolidation-design.md
it.skip("preserves references for every segment across a multi-period update", () => {
  const manifest = DashParser.create(
    loadFixture("dash-parser/live-multi-period-timeline-1.mpd"),
    sourceUrl,
  );
  const track = findVideo(manifest).tracks[0]!;
  const originalSegments = track.segments;
  const snapshot = [...originalSegments];

  DashParser.update(
    manifest,
    loadFixture("dash-parser/live-multi-period-timeline-2.mpd"),
    sourceUrl,
  );

  // After a real sliding update: [4, 8, 12, 16, 20].
  // Expected preserved identities at indices 0..3 (old [4, 8, 12, 16]).
  expect(track.segments).toBe(originalSegments);
  expect(track.segments.map((s) => s.start)).toEqual([4, 8, 12, 16, 20]);
  expect(track.segments[0]).toBe(snapshot[1]); // old start=4
  expect(track.segments[1]).toBe(snapshot[2]); // old start=8
  expect(track.segments[2]).toBe(snapshot[3]); // old start=12
  expect(track.segments[3]).toBe(snapshot[4]); // old start=16
});
```

- [ ] **Step 4: Run tests — verify skipped test is reported as skipped**

Run: `pnpm -F cmaf-lite test -- --run dash_parser`
Expected: suite still green; the skipped test shows up in vitest output as skipped.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "test(dash): document multi-period update pruning bug (skipped)"
```

---

## Task 26: Final sweep — type check + format

- [ ] **Step 1: Type check**

Run: `pnpm tsc`
Expected: passes.

- [ ] **Step 2: Lint/format**

Run: `pnpm format`
Expected: no residual formatting changes. If Biome rewrites anything (line breaks, quote style), inspect and commit.

- [ ] **Step 3: Run full suite**

Run: `pnpm test -- --run`
Expected: all tests green across the monorepo.

- [ ] **Step 4: Final commit if format changed anything**

```bash
git add -u
git commit -m "test(dash): format final"
```

---

## Verification checklist

After all tasks, confirm:

- [ ] `packages/cmaf-lite/test/dash/dash_segments.test.ts` does not exist.
- [ ] `packages/cmaf-lite/test/dash/helpers.ts` exists.
- [ ] `packages/cmaf-lite/test/fixtures/dash-parser/` contains exactly 26 `.mpd` files (19 `vod-*`, 7 `live-*`).
- [ ] `packages/cmaf-lite/test/fixtures/` has no `.mpd` files at the top level.
- [ ] `packages/cmaf-lite/lib/dash/dash_parser.ts` does not `export` `appendSegments`.
- [ ] `pnpm test -- --run` passes with exactly one skipped test.
- [ ] `pnpm tsc` passes.
- [ ] `pnpm format` makes no changes.
