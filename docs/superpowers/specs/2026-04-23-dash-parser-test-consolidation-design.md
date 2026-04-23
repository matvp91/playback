# DASH Parser Test Consolidation

## Goal

Replace the current split between `dash_parser.test.ts` and
`dash_segments.test.ts` with a single integration test file that parses
MPD fixtures through the public API. Every behavior is verified by
feeding an MPD (a file on disk) into `DashParser.create` or
`DashParser.update` and asserting on the resulting `Manifest`.

Along the way: fill coverage gaps surfaced by an exhaustive audit of
`dash_parser.ts`, make fixture filenames self-describing, and remove
the internal `appendSegments` export that only the now-dead
`dash_segments` tests consumed.

The long-standing multi-period-update pruning bug (Period 2's
`firstAvailableStart` truncates all of Period 1) gets a failing test
documented as `it.skip`. The fix is a separate brainstorm.

## Non-goals

- Fixing the multi-period-update bug. Tracked as the skipped test.
- Reworking the parser's public API.
- Unit-testing internal helpers (`appendSegments`, `resolveCodec`,
  etc.). Integration tests cover their observable effects.
- HLS or other formats.
- Performance, fuzzing, or malformed-XML resilience beyond the
  specific error paths listed below.

## Shape

### Files after

```
test/
  dash/
    dash_parser.test.ts          # single test file
    helpers.ts                   # new, pure helpers
    dash_segments.test.ts        # DELETED
  fixtures/
    dash-parser/                 # moved + new; 25 fixtures
      vod-*.mpd
      live-*.mpd
    index.ts                     # existing loadFixture, unchanged signature
```

`loadFixture` stays generic — callsites use
`loadFixture("dash-parser/vod-basic.mpd")`. Scales if other parser
families (HLS) arrive later.

### Source change

In `lib/dash/dash_parser.ts`:

```ts
// before
export function appendSegments(...)
// after
function appendSegments(...)
```

Nothing outside the parser consumes it after the test consolidation.

## Fixtures

All fixtures live in `test/fixtures/dash-parser/`. Naming rules:

- **`vod-` prefix** for static manifests (no `@type` or `type="static"`).
- **`live-` prefix** for dynamic manifests (`type="dynamic"`).
- **`-N` suffix** when the fixture participates in an update sequence.
  `-1` is the starting snapshot, `-2`, `-3`, … are subsequent refreshes.

### VOD (static parse only — never fed to `update()`)

| File | What it exercises |
| --- | --- |
| `vod-basic.mpd` | Canonical VOD: multi-bitrate video (1080p, 720p) + audio, duration-based SegmentTemplate, 60s. |
| `vod-subtitle.mpd` | WVTT subtitle AdaptationSet with `@lang`. |
| `vod-mimetype-fallback.mpd` | `contentType` absent; media type inferred from `mimeType`. |
| `vod-inherited-template.mpd` | `SegmentTemplate` at Period level carrying `initialization`, `media`, `timescale`, `startNumber`, `duration`, `presentationTimeOffset` — all inherited by AdaptationSet/Representation. |
| `vod-codec-on-adaptation-set.mpd` | `codecs` attribute on `AdaptationSet`, absent on `Representation` — verifies fallback. |
| `vod-timeline-reset.mpd` | `SegmentTimeline` with explicit `@t` resetting time; `$Time$` placeholder in media URL. |
| `vod-timeline-with-duration.mpd` | `SegmentTemplate` declares both `@duration` **and** `<SegmentTimeline>` — timeline wins, `@duration` ignored. |
| `vod-url-placeholders.mpd` | Media template uses `$Bandwidth$` and `$RepresentationID$`. |
| `vod-base-url.mpd` | `<BaseURL>` declared at MPD, Period, AdaptationSet, and Representation levels — verifies hierarchical resolution. |
| `vod-multi-period.mpd` | Two periods, duration-based (existing fixture, moved). |
| `vod-multi-period-timeline.mpd` | Two periods, both using `SegmentTimeline`. |
| `vod-multi-period-asymmetric.mpd` | Period 2 introduces a Representation (`id="3"`) that doesn't exist in Period 1 — verifies upsert creates a new track. |
| `vod-multi-period-startnumber.mpd` | Period 2 `@startNumber` continues from where Period 1 left off (e.g., 1→8→15). |
| `vod-multi-language-audio.mpd` | Three audio AdaptationSets, same codec, `@lang="en"`, `@lang="fr"`, and `@lang="und"` (verifies "und" → "unk" normalization). |
| `vod-presentation-time-offset.mpd` | Non-zero `@presentationTimeOffset` — segment start times must be `(time − pto) / timescale`. |
| `vod-no-periods.mpd` | Malformed: `<MPD>` contains zero `<Period>` elements. |
| `vod-no-representations.mpd` | Malformed: an `<AdaptationSet>` contains zero `<Representation>` children. Parser silently drops it. |
| `vod-no-template.mpd` | Malformed: no `<SegmentTemplate>` at any level. Parser throws. |

### LIVE (static parse and/or update sequences)

| File | What it exercises |
| --- | --- |
| `live-basic.mpd` | Minimal `type="dynamic"` MPD — `isLive === true` sanity. |
| `live-timeline-sliding-1.mpd` / `live-timeline-sliding-2.mpd` | DVR window **slides**: between snapshots, head segments drop off and new tail segments appear. (Existing `live-timeline-1.mpd` / `-2.mpd`, renamed.) |
| `live-timeline-growing-1.mpd` / `live-timeline-growing-2.mpd` | DVR window **grows**: tail extends, head unchanged (early in the stream before the window fills). |
| `live-multi-period-timeline-1.mpd` / `live-multi-period-timeline-2.mpd` | Two-period live manifest, both periods using `SegmentTimeline`; snapshot 2 shifts the DVR window forward. Used exclusively by the skipped multi-period-update bug test. |

**Total: 25 fixtures** (18 VOD + 7 LIVE).

## Helpers (`test/dash/helpers.ts`)

Pure, dependency-free helpers kept small. No test framework coupling
beyond `expect` re-export where needed.

```ts
import { expect } from "vitest";
import type {
  Manifest,
  Segment,
  SwitchingSet,
} from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";

/** Returns the sole video switching set or throws. */
export function findVideo(manifest: Manifest): SwitchingSet & {
  type: MediaType.VIDEO;
}

/** Returns the first audio switching set or throws. */
export function findAudio(manifest: Manifest): SwitchingSet & {
  type: MediaType.AUDIO;
}

/** Returns the first subtitle switching set or throws. */
export function findSubtitle(manifest: Manifest): SwitchingSet & {
  type: MediaType.SUBTITLE;
}

/**
 * Assert actual[i] === expected[i] (reference equality) for all i.
 * Used by update tests that snapshot segment arrays before an update
 * and verify every segment object survived.
 */
export function expectSegmentIdentities(
  actual: readonly Segment[],
  expected: readonly Segment[],
): void
```

The identity helper keeps update tests terse: snapshot before, call
`update()`, call `expectSegmentIdentities(track.segments, snapshot)`.

## Test inventory

Organized in `dash_parser.test.ts` as:

```
describe("DashParser") {
  describe("structure")    { ... }
  describe("segments")     { ... }
  describe("errors")       { ... }
  describe("update")       { ... }
  describe("update — live reconciliation") { ... }
}
```

**E** = existing, **M** = migrated from `dash_segments.test.ts`,
**N** = new.

### `describe("structure")` — 14 tests

- (E) parses a basic MPD with correct duration and switching-set count
- (E) extracts a video switching set with the declared codec
- (E) extracts an audio switching set with the declared codec and language
- (E) resolves video track dimensions from Representations
- (E) infers media type from `mimeType` when `contentType` is absent
- (E) computes `maxSegmentDuration` per track
- (E) parses a subtitle AdaptationSet with language
- (E) assigns `SwitchingSet.id` as `type:codec` for video and
  `type:codec:language` for audio/subtitle
- (E) assigns `Track.id` from `Representation@id`
- (E) sets `isLive=false` for a static MPD (uses `vod-basic.mpd`)
- (E, fixture-ized) sets `isLive=true` for a dynamic MPD (uses `live-basic.mpd`)
- (N) drops AdaptationSets with zero Representations
- (N) creates separate audio switching sets per language and normalizes
  `@lang="und"` to `"unk"`
- (N) falls back to AdaptationSet `codecs` when Representation omits it

### `describe("segments")` — 25 tests

- (E) generates segment URLs derived from the SegmentTemplate
- (E) generates the correct segment count for the presentation duration
- (M) last segment covers the full presentation duration
- (M) segments are contiguous with no gaps
- (M) every media segment has an `initSegment`
- (M) `SegmentTimeline` `@r` repeat count produces the correct segment count
- (M) calculates correct start/end times from timeline entries
- (M) resets segment time when an `<S>` entry has an explicit `@t` attribute
- (M) merges SegmentTemplate attributes from Period / AdaptationSet / Representation levels
- (N) expands `$Time$` placeholder in segment URLs (assertion on `vod-timeline-reset.mpd`)
- (N) expands `$Bandwidth$` placeholder in segment URLs
- (N) expands `$RepresentationID$` placeholder in segment URLs
- (N) applies `@presentationTimeOffset` to segment start/end times
- (N) inherits `@startNumber` from Period-level SegmentTemplate
- (N) inherits `@duration` from Period-level SegmentTemplate
- (N) inherits `@presentationTimeOffset` from Period-level SegmentTemplate
- (N) resolves `<BaseURL>` at every level (MPD / Period / AS / Representation)
- (N) SegmentTimeline takes precedence when both `@duration` and `<SegmentTimeline>` are present
- (E) builds subtitle track segments from SegmentTemplate
- (E) multi-period: flattens into single manifest with concatenated segments
- (E) multi-period: segments appear in timeline order across periods
- (E) multi-period: audio segments concatenated across periods
- (N) multi-period: static parse with SegmentTimeline in both periods
- (N) multi-period: accepts asymmetric Representations (Period 2 adds a new track)
- (N) multi-period: segment numbering continues across periods via `@startNumber`

### `describe("errors")` — 2 tests

- (E, fixture-ized) throws when `<MPD>` has no `<Period>` elements
- (N) throws when no `SegmentTemplate` is declared at any level

### `describe("update")` — 3 tests

- (E, refitted) idempotent update preserves all references
  (uses `live-timeline-sliding-1.mpd` fed twice, not `vod-basic.mpd`)
- (E, refitted) extends segments when a new snapshot adds tail
  (uses `live-timeline-growing-1/-2.mpd`, replaces the runtime regex hack)
- (N, `it.skip`) preserves every segment reference across a multi-period
  update (uses `live-multi-period-timeline-1/-2.mpd`; comment documents
  the prune bug and references this spec)

### `describe("update — live reconciliation")` — 4 tests

All existing, updated to use `live-timeline-sliding-1/-2.mpd`:

- (E) appends new tail segments and prunes expired head segments
- (E) preserves object identity for overlapping segments
- (E) preserves Track and SwitchingSet identity across an update
- (E) uses the refreshed MPD's first-segment start as the prune watermark

**Total: 48 tests** (24 E refitted + 7 M + 17 N, one skipped).

## Coverage mapping

Every item from the branch audit is either **covered** by the test
inventory above or explicitly **deferred** to a follow-up.

Deferred (not worth pinning for this pass):

- Various missing-required-attribute throws individually (`@id`,
  `@bandwidth`, `@width`, `@height`, `@initialization`, `@media`,
  `@d` on `<S>`) — they all route through `attrRequired`; one error
  path (`vod-no-template.mpd`) proves the contract.
- `@type` with unexpected non-"dynamic" value — behaves identically to
  absent `@type`.
- Undefined-behavior inputs: negative `@r`, `timescale=0`,
  `bandwidth=0`, `width/height=0`, malformed ISO 8601.
- Integer overflow / very large durations.
- `MPD@mediaPresentationDuration` absent (falls back to last segment
  end) — not exercised by any realistic flow yet.

## Migration order

This design does not prescribe an execution order. The writing-plans
phase will sequence the work so every commit leaves `pnpm test` green.

## Risks

1. **Fixture bloat.** 25 `.mpd` files is a lot. Mitigated by the
   `vod-` / `live-` / `-N` naming convention and the dedicated
   subdirectory. Each fixture targets a specific behavior.
2. **Skipped multi-period test drifts.** An `it.skip` can rot silently.
   The comment explicitly names the bug and points at the follow-up
   brainstorm; flipping it to `it` is a single-line diff when the fix
   lands.
3. **Un-exporting `appendSegments` is a breaking API change** for any
   external caller. `cmaf-lite` is pre-1.0 and the function is not
   part of the documented API. The parser package's `exports` field
   is unchanged.
