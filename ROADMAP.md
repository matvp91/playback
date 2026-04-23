# Roadmap

Tracks the next body of work for cmaf-lite. Each entry is a mini-spec —
scope, approach, open questions — concrete enough to start scoping
without a separate spec document.

---

## 1. Live manifest updates

**Status:** Not started.

### Goal

Support DASH live presentations (`MPD@type="dynamic"`) with periodic
manifest refreshes. The manifest state evolves continuously: new
segments appear at the live edge, expired segments roll off the tail of
the DVR window, and occasionally periods are added or removed.

Identity-preserving reconciliation is the hard requirement: downstream
components (ABR controller, stream controller, buffer controller) hold
`SwitchingSet` and `Track` instances by reference via `StreamHierarchy`.
A refresh must update those instances in place, not replace them.

### Approach

Parsing today is a one-shot function of XML → `Manifest`. Live
requires that parsing run against persistent state.

- **Parser state object.** Promote the two lookup Maps
  (`switchingSetsById`, `tracksById`) out of `flattenPeriods` into a
  `ManifestParser` class (or equivalent struct) that survives across
  refreshes. First parse populates them; subsequent parses reconcile
  against them.
- **Delta merge for segments.** The hot path becomes "append the new
  tail of a track's segment list, drop expired head". Requires a
  mutate-in-place `appendSegments(target, ...)` primitive in
  `dash_segments.ts` — same shape as the primitive the static parser
  already wants for allocation reasons (see Prerequisites).
- **Segment identity.** Dedup-on-append needs a segment key. Use
  `start` time (presentation timeline seconds) — stable across
  refreshes for a given representation, unlike URL which can change
  under URL templating.
- **Expired segment pruning.** Drop segments from the head of each
  track when `segment.end < now - timeShiftBufferDepth`. Run as a
  cleanup pass after reconcile.
- **Period lifecycle.** Track periods by identity (MPD `Period@id` if
  present, else period start time). New periods append; periods whose
  last segment has expired drop. Switching sets follow the existing
  cross-period merge rule — a period disappearing does not remove a
  switching set unless every track becomes empty.
- **Refresh scheduler.** New component, owned by `Player` (or a
  dedicated `ManifestController`). Honors `minimumUpdatePeriod` with
  jittered scheduling. Fires an event the existing controllers can
  subscribe to.

### Prerequisites

These should land before live work begins, independently useful today:

- **Segments-append primitive.** Replace `parseSegmentData` with
  `appendSegments(target: Segment[], ..., duration): number` (returns
  contributed `maxSegmentDuration`). Kills the intermediate array, the
  `SegmentData` wrapper, and the element-by-element spread on hit.
  Roughly matches the flow live needs.
- **Public `id` fields on `SwitchingSet`/`Track`** — already done.
  Stable identity anchors reconciliation across refreshes.

### In scope (initial live support)

- MPD@type detection (`static` vs `dynamic`).
- Periodic refresh driven by `minimumUpdatePeriod`.
- Identity-preserving reconciliation of switching sets, tracks, and
  segments across refreshes.
- Delta segment append keyed on `Segment.start`.
- Expired segment pruning bounded by `timeShiftBufferDepth`.
- Period add/remove across refreshes.
- Error handling: transient refresh failures retry with backoff;
  persistent failures surface as a manifest event.

### Out of scope (initial live support)

- Low-latency DASH (LL-DASH, chunked CMAF, `ProducerReferenceTime`).
- MPD patching (RFC 6902-style partial updates).
- UTC timing sources (`UTCTiming` element) — use client clock initially.
- DVR controls in the player UI (seek to live edge, scrub in DVR window).
  Parser makes the data available; UI work lands separately.

### Open questions

- **Refresh scheduler ownership.** Player, a new `ManifestController`,
  or a dedicated module inside `lib/manifest/`? Leaning toward a new
  module to keep Player's surface area small.
- **Segment-identity ties.** Are `start` times always unique within a
  track? SegmentTemplate with timeline and consecutive identical
  durations should be — verify against the `@svta/cml-dash` templating
  behavior.
- **How do controllers learn of updates?** New `ManifestUpdated` event
  carrying a diff, or a generic signal + pull from the updated
  `Manifest` object? Diff enables incremental work; signal is simpler.
- **Clock source.** Defer to client `Date.now()` initially; `UTCTiming`
  follows in a later pass.

### Acceptance criteria

- Can play an `MPD@type="dynamic"` manifest starting at the live edge.
- After a refresh, new segments appear on existing `Track` instances —
  `switchingSet` / `track` references held by controllers are the same
  objects as before the refresh.
- Segments past `timeShiftBufferDepth` disappear from
  `track.segments`; buffer controller drops their ranges.
- A new period appearing adds tracks/segments without rewriting the
  rest of the manifest.
- Transient 5xx refresh failures retry with exponential backoff; repeated
  failure emits a `ManifestError` event without stopping playback while
  the current buffer is still playable.

---

## 2. Spec-faithful AdaptationSet / Representation identity

**Status:** Not started.

### Goal

Align SwitchingSet and Track identity derivation with MPEG-DASH
(ISO/IEC 23009-1) and CMAF (ISO/IEC 23000-19) semantics. Current
identity keys (`type:codec[:lang]` for SwitchingSet,
`Representation@id` for Track) are pragmatic heuristics that
over-merge and under-merge in predictable ways.

### Current gaps

- **`AdaptationSet@id` ignored.** When authors supply stable IDs
  across Periods, we derive our own composite key instead.
- **Video over-merges on codec.** Two video AdaptationSets with the
  same codec but different roles, aspect ratios, or HDR/SDR
  characteristics collapse into one SwitchingSet.
- **Audio over-merges on codec+lang.** Main / commentary /
  audio-description tracks with the same language and codec collapse.
  Role descriptor is the canonical disambiguator; we don't read it.
- **No `Role` descriptor awareness**
  (`urn:mpeg:dash:role:2011`) — `main`, `alternate`, `commentary`,
  `dub`, `description`, `caption`, etc.
- **No period-continuity signals** — DASH
  (`urn:mpeg:dash:period-continuity:2015`,
  `urn:mpeg:dash:period-switchable:2014`) tell the player which
  Representations across Periods are continuous. We infer from
  `Representation@id` stability, which the spec does not guarantee.
- **No `@par` (picture aspect ratio) or resolution-family
  awareness** — affects CMAF switching-set compatibility.

### Approach

- Prefer authored `AdaptationSet@id` as the SwitchingSet key when
  present; fall back to a composite key only when absent.
- Incorporate `Role` descriptor into the composite key. Audio +
  commentary vs. audio + main should be distinct SwitchingSets.
- Respect period-continuity / period-switchable descriptors for
  cross-Period track matching; do not silently extend segments onto a
  track that wasn't signaled continuous.
- Extend the composite key for video to include aspect ratio and
  HDR/SDR signaling where present.
- Keep Track identity as `Representation@id` scoped to its
  SwitchingSet; continuity descriptors, not pattern-matching, resolve
  cross-Period cases.

### Prerequisites

- Manifest apply restructure (item 1 prerequisite) — identity logic
  is orthogonal to the plumbing but easier to change once the upsert
  helpers are the single place identity flows through.

### Out of scope

- CMAF init-segment compatibility verification (decoding
  `ftyp`/`moov` to confirm switching-set constraints) — a deeper
  analysis pass belongs behind this, if needed.
- Fingerprint-based Representation identity (comparing init segments
  across Periods when `@id` is unstable and no continuity descriptor
  is present) — defer unless a real manifest demands it.

### Acceptance criteria

- A manifest with main + commentary audio at the same codec and
  language produces two SwitchingSets.
- A manifest with SDR and HDR video at the same codec produces two
  SwitchingSets.
- A manifest using `period-continuity:2015` matches Representations
  across Periods even when `@id` differs.
- A manifest without continuity descriptors and with distinct
  `Representation@id` values across Periods produces separate
  SwitchingSets per Period (no silent merge).
- Existing test fixtures continue to produce the same SwitchingSet /
  Track shapes (the current heuristics happen to align with spec for
  well-formed simple manifests).
