# ABR BOLA Inlining

## Overview

Dissolve `BolaScorer` as a separate class and inline its logic into
`AbrController`. After the dust settles from the dual-driver
restructure (e6243ac…461e0c8), the BolaScorer abstraction is paying
its overhead twice: it owns event subscriptions in parallel with
AbrController's own, and the public method surface
(`getRecommendedStream`, contemplated `isActive`/`shouldSwitch`)
keeps producing edge cases where the two methods can disagree.

Once inlined, all ABR state lives in one place. The questions about
"which method gates which" disappear because there are no public
methods between `BolaScorer` and `AbrController` — just private
state and private helpers.

## Motivation

Three pain points compounded over the past iterations:

1. **Surface duplication.** Both `BolaScorer` and `AbrController`
   subscribe to `BUFFER_APPENDED`. Both compute the video front
   buffer (the "duplication is six lines but each subsystem stays
   self-contained" justification in the previous spec is a tell that
   the abstraction isn't load-bearing). Both reason about
   `frontBufferLength`.

2. **Method-pair smell.** Once we considered exposing
   `shouldSwitch()` (or `isActive()`) alongside `getRecommendedStream()`,
   the two methods could disagree on edge cases (mainly empty
   `streams`). The user surfaced this directly: "isActive but null
   pick is essentially 'BOLA is not active'." The fix isn't to make
   the methods agree — it's to not have the seam in the first place.

3. **Naming churn.** `isSteady_`, `bolaActive_`, `shouldSwitch`,
   `isActive` — each round produced a new round of names because
   the meanings only made sense relative to a class boundary that
   itself was unclear.

Inlining resolves all three. The class boundary disappears; the
duplicated event subscriptions collapse to one; the named flags
become private fields with no public API to reconcile.

## Goals

- `BolaScorer` class is removed. The file `lib/abr/bola_scorer.ts` is
  deleted; the test file `test/abr/bola_scorer.test.ts` is deleted.
- All BOLA logic lives inside `AbrController`:
  - `isBufferSteady_: boolean` — latch. True once a video
    `BUFFER_APPENDED` has fired with `frontBuffer >=
    maxSegmentDuration`. Cleared on `seeking`. The "have we observed
    real data?" gate.
  - `useBola_: boolean` — hysteresis output. True when buffer is in
    the BOLA-drives comfort band: enters at `frontBuffer >= (2/3) *
    frontBufferLength`, exits at `frontBuffer < (1/3) *
    frontBufferLength`. Updated on every video `BUFFER_APPENDED`.
    Cleared on `seeking` (defensive — pre-seek state isn't relevant).
  - Private `getFrontBuffer_()` — video front-buffer in seconds, no
    clamp, no normalization.
  - Private `pickBolaStream_(streams, frontBuffer)` — the BOLA-O
    scoring loop. Pure: input → output, no internal state.
  - `evaluate_()` (existing) — uses `pickBolaStream_` when
    `isBufferSteady_ && useBola_`, falls back to `pickFromThroughput_`
    otherwise. Throttled by `switchInterval` on emit.
- `AbrController` subscribes to `BUFFER_APPENDED`, `MEDIA_ATTACHED`,
  `MEDIA_DETACHING` (in addition to the existing `NETWORK_RESPONSE`).
  It manages the media-element `seeking` listener directly. Single
  event hub for all ABR state.
- `BUFFER_FLUSHED` is not subscribed to. The hysteresis naturally
  pulls back when a flushed buffer's next append shows low fill.
- The evaluation timer is fixed at 1 second (hardcoded). The
  `abr.evaluationInterval` config option is removed.
- A new config option `abr.switchInterval` (seconds, default 8)
  throttles emits: a non-null `pick` is discarded when fewer than
  `switchInterval` seconds have elapsed since the last `ADAPTATION`.
  Decouples evaluation cadence (cheap, fast) from switch cadence
  (visible, throttled). Preserves the current 8s effective
  minimum-between-switches at default config.
- `Player.getBufferFullness()` is removed (public API change). With
  no internal callers remaining outside `AbrController`'s private
  helper, the public observability hook isn't pulling its weight.
- `MINIMUM_BUFFER_S = 10` becomes a private constant inside
  `abr_controller.ts` (Vp/gp math calibration only). Removed from
  the previous re-export.
- Hysteresis thresholds derive from `frontBufferLength` as fractions
  *below* the fill cap: on at `(2/3) * frontBufferLength`, off at
  `(1/3) * frontBufferLength`. With default `frontBufferLength = 30`
  this is 20s/10s — the same effective band as the pre-refactor
  `MINIMUM_BUFFER_S * 2 / MINIMUM_BUFFER_S` thresholds. The fractions
  sit below the fill cap so the "on" threshold is reachable.
- `docs/abr.md` updated to describe the inlined model and the
  `frontBufferLength`-derived hysteresis. The "Observability" hook
  for `getBufferFullness` is dropped.

## Non-goals

- `InsufficientBufferRule` equivalent (BOLA's stall safety net in
  dash.js). Deferred; documented in `docs/abr.md` Future
  Enhancements alongside placeholder buffer / abandon-fragment.
- `bufferTimeAtTopQuality` equivalent. cmaf-lite has a single
  `frontBufferLength` target.
- BOLA scoring math itself. The Vp/gp formulas, the +1 utility
  shift, and the score expression all carry over verbatim from the
  current `BolaScorer.getRecommendedStream`.
- Throughput estimator changes (still in its own
  `ThroughputEstimator` class — unlike BolaScorer, it's stateful
  enough to earn the abstraction).
- Public API surface beyond `Player.getBufferFullness()` and the
  `abr.evaluationInterval` → `abr.switchInterval` config rename.

## Design

### `AbrController`

State:

- `player_: Player`
- `throughput_: ThroughputEstimator`
- `timer_: Timer`
- `media_: HTMLMediaElement | null`
- `lastSwitchAt_: number` — `performance.now()` of the last emitted
  `ADAPTATION`. Initialized to `-Infinity`.
- `isBufferSteady_: boolean` — observed-data latch.
- `useBola_: boolean` — hysteresis output.

Lifecycle:

- Constructor subscribes to `NETWORK_RESPONSE`, `BUFFER_APPENDED`,
  `MEDIA_ATTACHED`, `MEDIA_DETACHING`. Starts the 1-second timer.
- `onMediaAttached_(event)` — stores `media_`; adds the `seeking`
  DOM listener.
- `onMediaDetaching_()` — removes the `seeking` listener; clears
  `media_`.
- `destroy()` — unsubscribes all four player events, removes the
  `seeking` listener if media is attached, stops the timer.

Event handlers:

- `onBufferAppended_(event)` — if `event.type !== MediaType.VIDEO`,
  returns. Otherwise reads `frontBuffer` via `getFrontBuffer_()` and
  the lowest stream's `maxSegmentDuration`, then:
  1. Latch update: if `frontBuffer >= maxSegmentDuration`, sets
     `isBufferSteady_ = true`. Once latched, never re-checked until
     reset.
  2. Hysteresis update: if `frontBuffer >= (2/3) * frontBufferLength`,
     sets `useBola_ = true`. If `frontBuffer < (1/3) *
     frontBufferLength`, sets `useBola_ = false`. Otherwise (in the
     dead zone) keeps the current value.
- `onSeeking_()` — sets `isBufferSteady_ = false`,
  `useBola_ = false`. Both gates close; the next `BUFFER_APPENDED`
  re-evaluates from scratch.
- `onNetworkResponse_(event)` — existing throughput-sample logic.

Private helpers:

- `getFrontBuffer_(): number` — returns video front-buffer in
  seconds:

  ```ts
  private getFrontBuffer_(): number {
    const media = this.media_;
    if (!media) return 0;
    const buffered = this.player_.getBuffered(MediaType.VIDEO);
    const { maxBufferHole } = this.player_.getConfig();
    const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
    if (end === null) return 0;
    return end - media.currentTime;
  }
  ```

- `pickBolaStream_(streams: VideoStream[], frontBuffer: number):
  VideoStream | null` — runs the BOLA-O scoring loop and returns
  the highest-scoring stream. Pure (no `this` state read other than
  `streams`/`frontBuffer` arguments). Body is the existing math
  from `BolaScorer.getRecommendedStream`, lifted unchanged.

- `pickFromThroughput_(streams, active)` — unchanged.

`evaluate_()` (timer callback, runs every 1s):

```ts
private evaluate_(): void {
  const streams = this.player_.getStreams(MediaType.VIDEO);
  if (streams.length === 0) return;
  const active = this.player_.getActiveStream(MediaType.VIDEO);

  let pick: VideoStream | null = null;
  if (this.isBufferSteady_ && this.useBola_) {
    pick = pickBolaStream_(streams, this.getFrontBuffer_());
  }
  if (!pick) {
    pick = this.pickFromThroughput_(streams, active);
  }
  if (!pick || pick === active) return;

  const now = performance.now();
  const { switchInterval } = this.player_.getConfig().abr;
  if (now - this.lastSwitchAt_ < switchInterval * 1000) return;

  this.lastSwitchAt_ = now;
  log.info("Decision", pick);
  this.player_.emit(Events.ADAPTATION, { stream: pick });
}
```

Private constants in `abr_controller.ts`:

- `MINIMUM_BUFFER_S = 10` — BOLA Vp/gp math parameter, used inside
  `pickBolaStream_`. Module-private, not exported.

### Tests

`packages/cmaf-lite/test/abr/bola_scorer.test.ts` — **deleted**.

`packages/cmaf-lite/test/abr/abr_controller.test.ts` — expanded to
cover the now-inlined behavior:

- Latch tests: `isBufferSteady_` flips true on a video
  `BUFFER_APPENDED` with `frontBuffer >= maxSegmentDuration`; stays
  false on audio appends or low-buffer appends; cleared on
  `seeking`.
- Hysteresis tests: `useBola_` enters at `frontBuffer >= 20s` and
  exits at `frontBuffer < 10s` (with default `frontBufferLength =
  30`); stays in dead zone between; cleared on `seeking`.
- Driver-selection tests: when both gates are open, `evaluate_()`
  uses BOLA's pick; when either is closed, falls back to throughput.
- BOLA math tests (lifted from the deleted file): low-buffer pick is
  lower-bandwidth than full-buffer pick; full-buffer prefers highest
  stream; monotonic preference as buffer grows.
- Throttle test: two state changes within `switchInterval` produce
  one emit; a third change after the interval emits again.
- Lifecycle test: `destroy()` removes all four player listeners and
  the `seeking` listener.

If `pickBolaStream_` ends up genuinely complex to test through
integration, lift it to a top-level non-exported function in
`abr_controller.ts` so tests can import it directly. Otherwise keep
it as a private method.

### Docs

`packages/cmaf-lite/docs/abr.md`:

- Replace the `### BOLA (Buffer Optimized)` "two-gate trust state"
  paragraph with a single one-shot-latch description: "BOLA's
  scoring is gated on a `isBufferSteady` latch — false until the
  front buffer has crossed `maxSegmentDuration` at least once since
  the last reset. The latch resets on media `seeking`."
- Update `## Driver Selection` thresholds: `< (1/3) *
  frontBufferLength` → Throughput, `>= (2/3) * frontBufferLength` →
  BOLA. With default `frontBufferLength = 30`, that's 10s/20s. Note
  that the transition is checked on `BUFFER_APPENDED`, not on every
  evaluation tick.
- Drop the `getBufferFullness` bullet from the `## Observability`
  section — that public method is removed.
- Add a bullet to `## Future Enhancements` for an
  `InsufficientBufferRule` equivalent: "BOLA can pick a stream that
  won't finish before underrun in low-buffer regimes. dash.js v5
  caps the pick by `safeThroughput * bufferLevel / fragmentDuration
  * 0.7` in a parallel rule (`InsufficientBufferRule.js`). Deferred;
  cmaf-lite's hysteresis (Throughput active below 10s) provides
  partial coverage."

## Migration

`PlayerConfig.abr` shape changes (breaking for any user that set
`evaluationInterval`):

- Removed: `abr.evaluationInterval` (timer is now hardcoded at 1s).
- Added: `abr.switchInterval` (seconds, default `8` — preserves the
  effective minimum-time-between-switches at default config).

`Player.getBufferFullness()` is also removed (public API change).
It was previously documented as an observability hook; with no
remaining internal callers, it's dropped from the public surface.

`BolaScorer` was internal — its removal is invisible to consumers.

The exported `MINIMUM_BUFFER_S` from `bola_scorer.ts` was only
consumed by `AbrController`; no external consumers.

Other public surface (`Player` methods, exported types) is
unchanged.

Behavior at default config:

- Hysteresis thresholds remain 20s/10s — same as before the refactor,
  now derived as `(2/3)`/`(1/3)` of `frontBufferLength` rather than
  `MINIMUM_BUFFER_S * 2` / `MINIMUM_BUFFER_S`. Identical effective
  behavior; cleaner derivation.
- Evaluation cadence increases (8s → 1s), but actual switch cadence
  is unchanged (throttled to 8s by `switchInterval`).

## Open Questions

None.
