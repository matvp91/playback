# Live Playback — Refresh Loop, Reconciliation, and Live Positioning

## Goal

Support live presentations end-to-end: periodic manifest refreshes,
identity-preserving reconciliation of segments across refreshes,
initial playback positioned behind the live edge, and MSE configured
for unbounded duration.

This is roadmap item 1 ("Live manifest updates") with the scope
extended to cover the player-layer pieces implied by the acceptance
criterion *"Can play an `MPD@type='dynamic'` manifest starting at the
live edge."*

The manifest-apply prerequisite landed in PR #38
([2026-04-21-manifest-apply-design.md](2026-04-21-manifest-apply-design.md)).
This spec layers onto that without further parser restructuring.

## Non-goals

- Drift correction (auto-catch-up after rebuffer). v1 starts at live
  delay and plays forward; if the user falls behind, they stay behind.
- `seekToLive()` / `isLiveEdge()` public APIs.
- `MediaSource.setLiveSeekableRange` — rely on `duration = Infinity`.
- Empty-track / empty-switching-set cleanup. Well-formed CMAF/DASH
  does not add or remove AdaptationSets mid-presentation.
- `MANIFEST_ERROR` event. Failed refreshes silently reschedule;
  persistent failure surfaces eventually as buffer exhaustion via
  existing mechanisms.
- `backBufferLength` auto-tuning for live. User remains in control.
- Live SegmentTemplate + `@duration` (no SegmentTimeline). Real-world
  live overwhelmingly uses SegmentTimeline; the `@duration` path can
  land when a concrete need appears.
- LL-DASH, MPD patching, `UTCTiming`.
- Dynamic-to-static handoff (end-of-event transition).
- Diff payloads on `MANIFEST_UPDATED` — consumers receive the
  mutated `manifest` reference and re-read what they need.

## Format-agnostic manifest model

Only one new field on `Manifest`:

```ts
export interface Manifest {
  duration: number;
  isLive: boolean;          // NEW
  switchingSets: SwitchingSet[];
}
```

**No DASH terminology on `Manifest`.** `timeShiftBufferDepth`,
`minimumUpdatePeriod`, `availabilityStartTime`,
`suggestedPresentationDelay`, `publishTime` — none of these appear on
the public model. They either live inside the DASH parser or are
replaced by player-level config (`liveDelay`, `liveUpdateTime`).

Seekable-window metadata (DVR start / live edge) is implicit in the
segment list: `segments[0].start` is DVR start, `segments.at(-1).end`
is the live edge. No separate field.

## Shape

### DashParser — delta emission

`appendSegments` gets state-aware so refreshes only materialize new
segments, not the entire window.

```ts
// dash_segments.ts
export function appendSegments(
  target: Segment[],
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodDuration: number | null,
  startAfter: number,                       // NEW
): { maxSegmentDuration: number; firstAvailableStart: number }
```

`startAfter` is sourced by the caller from the existing tail:

```ts
const startAfter = track.segments.at(-1)?.start ?? -Infinity;
```

Inside `appendSegments`, the timeline walk skips `<S>` ranges whose
entire `time..time+d*(r+1)` span falls at or below `startAfter`:

- For a `<S t="T" d="D" r="R"/>` block starting fully behind
  `startAfter`, advance `time` and `number` arithmetically without
  invoking `processUriTemplate`. Templating is the real per-segment
  cost; skipping it is the point of the optimization.
- For a block straddling the boundary, start the `i` loop at the
  first index whose derived `start` exceeds `startAfter`.

The `firstAvailableStart` is the `start` of the first segment the MPD
currently advertises for this representation — emitted or not. This
is the pruning watermark: segments already on the track whose `start`
is below it have rolled off the DVR window.

First parse: `startAfter = -Infinity`, all `<S>` entries emit, behavior
identical to today. No special-casing of initial vs. refresh.

The SegmentTemplate + `@duration` branch is **out of scope** for live
v1. Keep it functioning for static content; `startAfter` threads
through but the branch can stay as it is today (start from index 0
when the track is empty).

### manifest_utils — reconciliation primitive

One pure, boundary-only primitive in `lib/utils/manifest_utils.ts`.
No DASH knowledge; operates on the generic `Segment[]` shape.

```ts
// lib/utils/manifest_utils.ts

export function pruneSegments(target: Segment[], firstKeptStart: number): void {
  let count = 0;
  while (count < target.length && target[count]!.start < firstKeptStart) {
    count++;
  }
  if (count > 0) target.splice(0, count);
}
```

O(k) where k is the head movement per refresh — typically 1–3
segments. Middle of `target` is never touched, which is exactly what
preserves object identity for `StreamHierarchy` holders.

Tail-append is not a separate primitive because the DASH parser's
`appendSegments` writes directly into `track.segments` with the
`startAfter` watermark handling dedup at materialization time. A
generic tail-append helper belongs in `manifest_utils` when a second
parser (e.g., HLS) needs it; until then it would be dead code.

**Float correctness.** `pruneSegments` compares `segment.start`
against `firstAvailableStart`, both derived from the same
deterministic formula with the same integer inputs. IEEE 754
guarantees bit-identical results for identical inputs, so the
comparison is rounding-safe without epsilon hacks.

### DashParser — parser-internal pruning threshold

The DASH parser's `appendSegments` already returns
`firstAvailableStart`. For SegmentTimeline, this is the `t` of the
first `<S>` element (resolved through `pto`, `timescale`,
`periodStart`). No `timeShiftBufferDepth` reading required — the
packager has already sized the MPD's visible window.

`timeShiftBufferDepth` is not read at all in v1. It only matters for
the `@duration`-live branch, which is out of scope.

### Update flow in dash_periods

`applyPeriods` threads `startAfter` per-track and collects
`firstAvailableStart` on the way out. After the timeline walk writes
new segments into `track.segments`, the reconciler prunes using the
collected `firstAvailableStart`:

```ts
// inside applyPeriods, per representation:
const track = upsertTrack(ctx, switchingSet, adaptationSet, representation);
const startAfter = track.segments.at(-1)?.start ?? -Infinity;
const { maxSegmentDuration, firstAvailableStart } = appendSegments(
  track.segments, sourceUrl, mpd, period, adaptationSet, representation,
  periodDuration, startAfter,
);
ManifestUtils.pruneSegments(track.segments, firstAvailableStart);
track.maxSegmentDuration = Math.max(track.maxSegmentDuration, maxSegmentDuration);
```

`DashParser.appendSegments` writes directly into `track.segments` with
dedup-by-tail semantics via `startAfter`, so no separate merge step is
needed. Only pruning needs the `manifest_utils` primitive.

### ManifestController — unified fetch loop

`ManifestController` grows to own:

- The `Manifest` reference across its lifetime.
- A `Timer` instance whose callback does the fetch + apply.
- A cached source URL used by every fetch.

Initial load and live refresh share one method. Branching on
`this.manifest_` decides whether to **create** (first time) or
**update** (every subsequent tick) the manifest. `onManifestLoading_`
just stashes the URL and calls `timer_.tickNow()` — the Timer is the
single entry point into the fetch path.

```ts
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
    if (this.request_) networkService.cancel(this.request_);
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
      NetworkRequestType.MANIFEST, this.sourceUrl_, config.manifestRequestOptions,
    );
    const response = await this.request_.promise;
    if (response === ABORTED) {
      this.scheduleNext_();
      return;
    }

    if (!this.manifest_) {
      this.manifest_ = DashParser.parseManifest(response.text, response.request.url);
      this.player_.emit(Events.MANIFEST_CREATED, { manifest: this.manifest_ });
    } else {
      DashParser.updateManifest(this.manifest_, response.text, response.request.url);
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

VOD and live go through the same code path. For VOD, `isLive` is
false and `scheduleNext_` is a no-op after the initial parse; the
Timer never fires again. For live, every tick reschedules.

**Failure handling.** If the refresh fetch fails (NetworkService
exhausted its own retries), `response === ABORTED` is also the
failure sentinel surface — we reschedule and try again on the next
tick. No error event, no backoff, no tear-down.

**Refresh cadence.** Because we use `tickAfter` scheduled after each
response, actual cadence is `liveUpdateTime + fetchDuration`. This
naturally back-pressures on slow servers and avoids overlapping
refreshes.

### Events

```ts
// events.ts
export const Events = {
  MANIFEST_LOADING: "manifestLoading",
  MANIFEST_CREATED: "manifestCreated",    // RENAMED from MANIFEST_PARSED
  MANIFEST_UPDATED: "manifestUpdated",    // NEW
  // ... rest unchanged
} as const;

export interface ManifestCreatedEvent { manifest: Manifest }
export interface ManifestUpdatedEvent { manifest: Manifest }
```

`MANIFEST_UPDATED` fires after each live refresh parse completes.
Both events carry the same mutated `manifest` reference. Consumers
re-read whatever state they care about; no diff payload.

### Config

Two new fields on `PlayerConfig`:

```ts
export interface PlayerConfig {
  // ...
  liveDelay: number;        // seconds behind the live edge to start playback
  liveUpdateTime: number;   // seconds between manifest refreshes (added to fetch duration)
}

export const DEFAULT_CONFIG: PlayerConfig = {
  // ...
  liveDelay: 20,
  liveUpdateTime: 2,
};
```

### StreamController — live positioning and EOS suppression

Three changes:

1. **Cache `isLive_`** from `MANIFEST_CREATED`. StreamController does
   not hold the `Manifest` reference — just the one flag it needs.

2. **`getInitialTime_`** factored out of `tryStart_`:

   ```ts
   private getInitialTime_(stream: Stream): number {
     if (!this.isLive_) return 0;
     const { segments } = stream.hierarchy.track;
     const liveEdge = segments.at(-1)?.end ?? 0;
     const firstSegmentStart = segments[0]?.start ?? 0;
     const { liveDelay } = this.player_.getConfig();
     return Math.max(liveEdge - liveDelay, firstSegmentStart);
   }
   ```

   Called once in `tryStart_`, using the active video stream (or
   audio if audio-only). `tryStart_` sets `media.currentTime` to this
   value before the tick loop starts. With
   `mediaSource.duration = Infinity`, the seek is valid even before
   any buffered data exists.

3. **Suppress EOS when live.** `isEnded_` returns `false`
   unconditionally when `this.isLive_` is true. Reaching the end of
   `track.segments` means "wait for the next refresh," not EOS.

Listen for `MANIFEST_UPDATED`: rebuild `streamsMap_` via
`buildStreams` and emit `STREAMS_UPDATED`. Identity-preservation means
the rebuilt map mostly contains the same `Stream` objects. If
switching sets add or remove (not expected for well-formed CMAF, but
possible), downstream sees a consistent refresh.

### BufferController — duration, not manifest

Replace `manifest_: Manifest | null` with `duration_: number | null`.
The only thing BufferController cares about is the MSE duration value.

```ts
private duration_: number | null = null;

private onManifestCreated_ = (event: ManifestCreatedEvent) => {
  this.duration_ = event.manifest.isLive ? Infinity : event.manifest.duration;
  this.updateDuration_();
};

private updateDuration_() {
  if (this.duration_ === null || this.mediaSource_?.readyState !== "open") return;
  if (this.mediaSource_.duration === this.duration_) return;
  this.blockUntil(() => {
    if (this.mediaSource_?.readyState === "open") {
      this.mediaSource_.duration = this.duration_!;
    }
  });
}
```

BufferController does not listen for `MANIFEST_UPDATED` — duration is
set once on create and never changes during live playback. For VOD it
remains the parsed duration; for live it is `Infinity`.

## Data flow

```
load(url)
  → MANIFEST_LOADING
  → ManifestController fetches + DashParser.parseManifest
  → MANIFEST_CREATED { manifest }
     → BufferController sets duration_ (Infinity for live)
     → StreamController caches isLive_, builds streams, tryStart_
        → for live: media.currentTime = getInitialTime_(activeVideoStream)
  → if isLive: timer.tickAfter(liveUpdateTime)

[every liveUpdateTime seconds, for live:]
  → ManifestController fetches + DashParser.updateManifest
     → per track: appendSegments appends new segments (startAfter)
     → per track: pruneSegments trims expired head
  → MANIFEST_UPDATED { manifest }
     → StreamController rebuilds streamsMap_, emits STREAMS_UPDATED
     → BufferController: no-op
  → timer.tickAfter(liveUpdateTime)
```

## Identity guarantees (recap)

Inherited from the manifest-apply design, still hold after live
refresh:

- `Manifest`, `SwitchingSet`, `Track`, and the `track.segments` array
  are stable references across refreshes.
- Individual `Segment` objects persist as long as they remain in the
  MPD's current window. New ones append to the tail; expired ones are
  removed from the head via `splice(0, count)`.
- The middle of `track.segments` is never touched. `StreamHierarchy`
  holders and segment indices held by `StreamController.mediaState`
  remain valid across refreshes.

## File-level change list

| File | Change |
|---|---|
| `lib/types/manifest.ts` | Add `isLive: boolean` to `Manifest`. |
| `lib/dash/dash_segments.ts` | `appendSegments` gains `startAfter: number` parameter; return shape becomes `{ maxSegmentDuration, firstAvailableStart }`; timeline walk skips `<S>` blocks at or below `startAfter`. |
| `lib/dash/dash_periods.ts` | `applyPeriods` threads `startAfter` from `track.segments.at(-1)?.start`; after `appendSegments`, calls `ManifestUtils.pruneSegments(track.segments, firstAvailableStart)`. |
| `lib/dash/dash_parser.ts` | `parseManifest` / `updateManifest` surface unchanged (no new parameters). `parseManifest` reads `MPD@type` and sets `manifest.isLive`. `resolveDuration` returns `manifest.duration = 0` (or any value — unused for live) when `isLive` is true. |
| `lib/utils/manifest_utils.ts` | Add `pruneSegments(target, firstKeptStart)` export. |
| `lib/events.ts` | Rename `MANIFEST_PARSED` → `MANIFEST_CREATED`; add `MANIFEST_UPDATED` with `ManifestUpdatedEvent { manifest: Manifest }`. |
| `lib/config.ts` | Add `liveDelay: number` (default 20) and `liveUpdateTime: number` (default 2). |
| `lib/manifest/manifest_controller.ts` | Hold `manifest_`, `sourceUrl_`, `timer_`. Unified `fetchAndApply_` branches on `manifest_` presence (create vs. update). `onManifestLoading_` stores URL and calls `timer_.tickNow()`. Schedule via `scheduleNext_` gated on `manifest_.isLive`. Emit `MANIFEST_CREATED` / `MANIFEST_UPDATED`. |
| `lib/media/stream_controller.ts` | Cache `isLive_: boolean` from `MANIFEST_CREATED`. Extract `getInitialTime_`; set `media.currentTime` for live in `tryStart_`. Suppress EOS when `isLive_`. Listen for `MANIFEST_UPDATED` → rebuild `streamsMap_` + emit `STREAMS_UPDATED`. Rename handlers from `onManifestParsed_` to `onManifestCreated_`. |
| `lib/media/buffer_controller.ts` | Replace `manifest_: Manifest \| null` with `duration_: number \| null`. Set `duration_ = manifest.isLive ? Infinity : manifest.duration` in `onManifestCreated_`. `updateDuration_` references `duration_`. No `MANIFEST_UPDATED` listener. Rename handler from `onManifestParsed_` to `onManifestCreated_`. |
| `lib/media/gap_controller.ts` | Event-name updates if it listens for `MANIFEST_PARSED`. |
| `lib/abr/abr_controller.ts` | Event-name updates if it listens for `MANIFEST_PARSED`. |

## Testing

Extends the fixture-based harness in `packages/cmaf-lite/test/`.

**DashParser (unit):**

- `appendSegments` with `startAfter = -Infinity` produces the full
  segment list (parity with today).
- `appendSegments` with `startAfter` at a mid-timeline value emits
  only segments past that point; returns the expected
  `firstAvailableStart`.
- `updateManifest` applied with an MPD whose timeline has shifted
  (first `<S>` advanced, new `<S>` at tail) appends new tail segments
  and prunes expired head segments via
  `ManifestUtils.pruneSegments`. Existing middle `Segment` objects
  are the same references.
- `parseManifest` sets `Manifest.isLive = true` for
  `MPD@type="dynamic"` and `false` for `static`.

**manifest_utils (unit):**

- `pruneSegments(target, firstKeptStart)` removes all segments with
  `start < firstKeptStart` and nothing else; preserves object
  identity for kept segments.
- `pruneSegments(target, -Infinity)` is a no-op.
- `pruneSegments(target, x)` where `x > segments.at(-1).start` empties
  the array.

**ManifestController (integration):**

- Live manifest: `MANIFEST_CREATED` fires once; `MANIFEST_UPDATED`
  fires on each `liveUpdateTime`-spaced refresh (use fake timers).
- Static manifest: `MANIFEST_CREATED` fires once; Timer never fires.
- Refresh fetch failure: no event emitted, next tick still schedules
  and fires.
- `destroy()` during a pending refresh cancels the request and stops
  the Timer.

**StreamController (integration):**

- Live: initial `media.currentTime` equals
  `liveEdge - liveDelay` (clamped to `segments[0].start`).
- Live: reaching end of current `track.segments` does not emit
  `BUFFER_EOS`; a subsequent `MANIFEST_UPDATED` adding tail segments
  resumes fetching.
- Live: `MANIFEST_UPDATED` rebuilds streams and emits
  `STREAMS_UPDATED` with the expected `Stream` object references
  preserved.
- VOD regression: initial time is 0, EOS fires at end of segments.

**BufferController (integration):**

- Live: `mediaSource.duration === Infinity` after `MANIFEST_CREATED`.
- Live: `MANIFEST_UPDATED` does not change `mediaSource.duration`.
- VOD regression: `mediaSource.duration === manifest.duration`.

**Fixtures:**

- Add a live SegmentTimeline fixture (two snapshots of the same MPD,
  taken `liveUpdateTime` apart — one with the timeline shifted
  forward by a couple of segments). Used for the `updateManifest`
  reconciliation tests.

## Known limitations

- **SegmentTemplate + `@duration` live** is unsupported in v1. Any
  attempt to refresh such a manifest will keep recomputing from
  `startNumber = 1`, producing incorrect segment numbers over time.
  A runtime check could reject this shape on `MANIFEST_CREATED` when
  `isLive`; deferred unless real content demands it.
- **No drift correction.** After a rebuffer, the user plays at the
  stalled offset indefinitely. Fine for catch-up / news; polish item
  for sports-grade live.
- **No `seekToLive()` / `isLiveEdge()`.** UI that wants a "go to live"
  button must compute `liveEdge - liveDelay` itself from the
  currently-exposed segment data. Trivial to add when a use case
  appears.
- **Identity derivation still heuristic.** The existing
  `getAdaptationSetId` (`type:codec[:lang]`) is preserved unchanged;
  roadmap item 2 ("Spec-faithful AdaptationSet / Representation
  identity") remains necessary for commentary / alternate-audio /
  HDR-vs-SDR cases where the heuristic over-merges.
- **No dynamic-to-static handoff.** End-of-event transition (MPD
  flipping `@type` and removing `minimumUpdatePeriod`) is not
  handled. Out of scope.

## Open decisions

None blocking. Deferred:

- Drift correction and associated DVR-mode state (`liveEdgeLocked`)
  — reopen when a real use case demands auto-catch-up.
- `setLiveSeekableRange` for accurate seekable ranges in the media
  element — reopen alongside DVR-controls UI.
- `MANIFEST_ERROR` event for persistent refresh failure — reopen
  when player UX needs an observable error surface for network
  outages.
