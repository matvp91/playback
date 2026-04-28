# BolaScorer Simplification

## Overview

Restructure `BolaScorer` and its integration in `AbrController` so
that responsibilities are cleanly separated: `BolaScorer` answers
"given current state, what does BOLA recommend?", and `AbrController`
owns driver selection. Both subsystems subscribe to the events they
need independently. Aligns the boundary with dash.js v5 while keeping
cmaf-lite's smaller surface.

## Motivation

The current `BolaScorer` mixes three concerns inside a single
`getRecommendedStream()` method:

- An event-driven latch (`isSteady_`, set on `BUFFER_APPENDED`,
  cleared on `seeking` and `BUFFER_FLUSHED`).
- A continuous threshold check (`frontBuffer >= maxSegmentDuration`).
- The full BOLA-O scoring loop.

Two issues fall out:

1. The latch and the threshold check are doing different work — the
   latch is "have we ever observed real data?", the threshold is "is
   the buffer comfortable right now?" — but they share a return path
   and aren't named accordingly.
2. `MINIMUM_BUFFER_S = 10` serves a single role today (BOLA Vp/gp
   calibration), but the file exports it for `AbrController` to use
   as a hysteresis floor. dash.js v5 keeps these strictly separate:
   `MINIMUM_BUFFER_S` is a math constant, the activation threshold is
   `bufferTimeDefault`. Conflating them makes both harder to tune.

`AbrController.evaluate_()` runs `switchStrategy_()` (the hysteresis)
on every timer tick, even though the buffer level only changes on
`BUFFER_APPENDED`. dash.js drives its equivalent transition off
`BUFFER_LEVEL` events for the same reason — fewer redundant checks
and tighter coupling between the change and the response.

## Goals

- `BolaScorer` keeps its own event subscriptions for the state it
  cares about (`BUFFER_APPENDED`, `MEDIA_ATTACHED`,
  `MEDIA_DETACHING`) and its own `seeking` DOM listener. Public
  surface narrows to `getRecommendedStream()` and `destroy()`.
- `AbrController` adds a `BUFFER_APPENDED` subscription for its own
  hysteresis update. It does not forward events to `BolaScorer`.
  Both subsystems are independent subscribers to the same event.
- Construction order is load-bearing: `AbrController` instantiates
  `new BolaScorer(player)` *before* subscribing to its own player
  events. `BolaScorer`'s `BUFFER_APPENDED` handler therefore fires
  first, so `isSteady_` is current by the time `AbrController`'s
  handler runs (defensive — neither handler currently reads the
  other's state, but the ordering keeps that an option).
- `isSteady_` re-introduced inside `BolaScorer` as the sole "have we
  observed real data?" gate. Latched true when `frontBuffer >=
  maxSegmentDuration` on a video `BUFFER_APPENDED`. Cleared on
  media `seeking`.
- No internal cache of the recommendation — recompute on demand.
- `MINIMUM_BUFFER_S` becomes a private math-only constant inside
  `BolaScorer`. Removed from the export.
- Hysteresis thresholds derive from `frontBufferLength` as fractions
  below the fill cap: on at `(2/3) * frontBufferLength`, off at
  `(1/3) * frontBufferLength`. With default config (30s) this is
  20s/10s — identical to the previous `MINIMUM_BUFFER_S * 2` /
  `MINIMUM_BUFFER_S` thresholds, just derived from `frontBufferLength`
  instead of the BOLA math constant. The fractions sit below the
  fill cap so the "on" threshold is actually reachable. Updated
  event-driven on `BUFFER_APPENDED`.
- New private method `AbrController.getFrontBuffer_(): number` —
  takes no arguments, reads `this.player_` internally, returns
  absolute video front-buffer in seconds (no clamp, no
  normalization). Only used inside `AbrController`.
- `BolaScorer` computes its own video front-buffer inline from
  `media_` + `player_.getBuffered(VIDEO)` + `player_.getConfig()`
  (the same primitives `getFrontBuffer_` uses). The two computations
  are intentionally not shared — each subsystem stays encapsulated,
  and the duplication is six lines.
- `Player.getBufferFullness()` is removed (public API change). It
  was only used internally; observability hooks for the buffer level
  are no longer part of the public surface.
- `BUFFER_FLUSHED` is no longer a reset trigger.
- `AbrController`'s evaluation timer is fixed at 1 second
  (hardcoded). The `evaluationInterval` config option is removed.
- A new config option `abr.switchInterval` (seconds, default 8)
  throttles actual switches: `evaluate_()` discards a non-null pick
  if fewer than `switchInterval` seconds have elapsed since the last
  emitted `ADAPTATION`. Decouples evaluation cadence (cheap, fast)
  from switch cadence (visible, throttled). Preserves current
  effective behavior at default config (8s minimum between
  switches).
- `bola_scorer.test.ts` constructor signature aligned with shipping
  code; `BUFFER_FLUSHED` tests removed; the `MINIMUM_BUFFER_S`
  threshold test is removed (the threshold no longer lives in
  `BolaScorer`).
- `docs/abr.md` updated to describe the single one-shot latch and the
  `frontBufferLength`-derived hysteresis.

## Non-goals

- `InsufficientBufferRule` equivalent (BOLA's stall safety net in
  dash.js). Acknowledged as a future enhancement; documented in
  `docs/abr.md` alongside placeholder buffer / abandon-fragment.
- `bufferTimeAtTopQuality` equivalent. cmaf-lite has a single
  `frontBufferLength` target; per-quality buffer targets are not
  introduced.
- BOLA scoring math itself. The Vp/gp formulas, the +1 utility shift,
  and the score expression all carry over verbatim.
- Throughput estimator changes.

## Design

### `BolaScorer`

State:

- `player_: Player`
- `media_: HTMLMediaElement | null`
- `isSteady_: boolean` — latched true on a video `BUFFER_APPENDED`
  when `frontBuffer >= maxSegmentDuration`. Cleared on `seeking`.

Lifecycle:

- Constructor subscribes to `BUFFER_APPENDED`, `MEDIA_ATTACHED`, and
  `MEDIA_DETACHING`. No subscription to `BUFFER_FLUSHED`.
- `MEDIA_ATTACHED` stores `media_` and adds the `seeking` DOM
  listener.
- `MEDIA_DETACHING` removes the `seeking` listener and clears
  `media_`.
- `destroy()` unsubscribes the player listeners and (if media is
  attached) the `seeking` listener.

Public surface:

- `getRecommendedStream(): VideoStream | null` — returns `null` if
  `!isSteady_` or no streams. Otherwise reads `frontBuffer` (computed
  inline from `media_` + `player_.getBuffered(VIDEO)` +
  `player_.getConfig().maxBufferHole`) and runs the BOLA-O scoring
  loop on current streams + that value, returning the highest-scoring
  stream. Recomputes every call.
- `destroy()`.

Private handlers:

- `onBufferAppended_(event)` — if `event.type !== MediaType.VIDEO`,
  returns. Else reads `frontBuffer` (inline computation, same
  primitives as in `getRecommendedStream`) and the lowest stream's
  `maxSegmentDuration`; if `frontBuffer >= maxSegmentDuration`, sets
  `isSteady_ = true`. Once latched, never re-checked until reset.
- `onMediaAttached_` / `onMediaDetaching_` — manage `media_` and the
  `seeking` listener as described above.
- `onSeeking_` — `isSteady_ = false`.

Private constants:

- `MINIMUM_BUFFER_S = 10` — module-private, not exported.

The `BUFFER_FLUSHED` listener is removed entirely. A flush implies an
empty buffer, and the AbrController hysteresis already pulls back to
throughput when `frontBuffer < (1/3) * frontBufferLength`. Once
buffer rebuilds, `BUFFER_APPENDED` re-latches `isSteady_` if it had
been cleared by a concurrent seek.

### `AbrController`

State adds:

- `lastSwitchAt_: number` — timestamp (`performance.now()`) of the
  last emitted `ADAPTATION`. Initialized to `-Infinity` (or `0`) so
  the first switch is unthrottled. `bolaActive_` already exists.

Lifecycle changes:

- Constructor subscribes to `BUFFER_APPENDED` in addition to the
  existing `NETWORK_RESPONSE`. This subscription happens *after*
  `new BolaScorer(player)` returns, so `BolaScorer`'s handler
  registers (and therefore fires) first.
- Timer is started at a hardcoded 1-second cadence
  (`this.timer_.tickEvery(1)`). The `abr.evaluationInterval` config
  read is removed.
- `destroy()` unsubscribes the new `BUFFER_APPENDED` listener
  (timer/throughput cleanup unchanged).

Behavior changes:

- New private `onBufferAppended_(event)` — filters on
  `event.type === MediaType.VIDEO` (audio appends don't move video
  buffer fullness), then runs `switchStrategy_()`. No call into
  `BolaScorer`; that subsystem subscribes to the same event
  independently and applies its own video filter.
- `evaluate_()` no longer calls `switchStrategy_()`. The hysteresis
  state is updated event-driven; `evaluate_()` reads `bolaActive_`
  and asks BOLA or throughput accordingly.
- `evaluate_()` throttles switches: after computing a `pick` that
  differs from `activeStream`, it checks `now - lastSwitchAt_ >=
  switchInterval * 1000`; if not, the pick is discarded (no emit).
  When it does emit, it updates `lastSwitchAt_ = now`.
- `switchStrategy_()` reads `this.getFrontBuffer_()` (private
  method, returns absolute seconds, video-only, no clamp) and
  compares against fractions of `frontBufferLength`: on at
  `frontBuffer >= (2/3) * frontBufferLength`, off at `frontBuffer <
  (1/3) * frontBufferLength`. At default 30s this is the same 20s/10s
  band as before the refactor.
- `MINIMUM_BUFFER_S` import removed.

The `getFrontBuffer_()` helper is a private method on
`AbrController`:

```ts
private getFrontBuffer_(): number {
  const media = this.player_.getMedia();
  if (!media) return 0;
  const buffered = this.player_.getBuffered(MediaType.VIDEO);
  const { maxBufferHole } = this.player_.getConfig();
  const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
  if (end === null) return 0;
  return end - media.currentTime;
}
```

Same logic the old `Player.getBufferFullness()` had, minus the
divide-by-`frontBufferLength` and the `Math.min(1, ...)` clamp.
`BolaScorer` uses an inlined six-line equivalent in its handlers
(see the `BolaScorer` section above) — the duplication is
intentional to keep each subsystem self-contained.

`evaluate_()` body shrinks to:

```ts
const streams = this.player_.getStreams(MediaType.VIDEO);
if (streams.length === 0) return;
const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
let pick: VideoStream | null = null;
if (this.bolaActive_) {
  pick = this.bola_.getRecommendedStream();
}
if (!pick) {
  pick = this.pickFromThroughput_(streams, activeStream);
}
if (!pick || pick === activeStream) return;
const now = performance.now();
const { switchInterval } = this.player_.getConfig().abr;
if (now - this.lastSwitchAt_ < switchInterval * 1000) return;
this.lastSwitchAt_ = now;
log.info("Decision", pick);
this.player_.emit(Events.ADAPTATION, { stream: pick });
```

The 1-second timer drives evaluation; the throttle keeps actual
switches spaced by at least `switchInterval` seconds, regardless of
how often the underlying state changes.

### Tests

`packages/cmaf-lite/test/abr/bola_scorer.test.ts`:

- Update constructor call to `new BolaScorer(player as never)` —
  drop the `media` argument used by the current out-of-sync tests.
  Emit `MEDIA_ATTACHED` from the stub player in `beforeEach` to
  deliver the media element to `BolaScorer`.
- Drop `video BUFFER_FLUSHED re-arms the event gate`.
- Drop `audio BUFFER_FLUSHED does not affect the event gate`.
- Drop `threshold gate closes when frontBuffer < maxSegmentDuration`
  (the threshold is now in `AbrController`, not `BolaScorer`).
- Keep, with the updated latch condition (`frontBuffer >=
  maxSegmentDuration` checked at append time): `returns null before
  any BUFFER_APPENDED`, `returns a stream after a video
  BUFFER_APPENDED`, `ignores audio BUFFER_APPENDED`, `media seeking
  re-arms the event gate`, plus the three math tests (low vs full
  buffer pick, full-buffer prefers highest, monotonic preference).
- `destroy()` test: assertion stays the same — events emitted after
  `destroy()` are no-ops.

`packages/cmaf-lite/test/abr/abr_controller.test.ts`:

- Add a test that `BUFFER_APPENDED` updates `bolaActive_` according
  to the `frontBufferLength`-derived thresholds (event-driven
  hysteresis).
- Update existing hysteresis tests: thresholds remain 20s/10s at
  default config (now derived as `(2/3)`/`(1/3)` of
  `frontBufferLength` rather than `MINIMUM_BUFFER_S * 2` /
  `MINIMUM_BUFFER_S`). Transitions are driven via `BUFFER_APPENDED`
  rather than evaluation ticks.

### Docs

`packages/cmaf-lite/docs/abr.md`:

- Replace the `### BOLA (Buffer Optimized)` "two-gate trust state"
  paragraph with a single one-shot-latch description: "BOLA returns
  null until the front buffer has crossed `maxSegmentDuration` at
  least once since the last reset. The latch resets on media
  `seeking`."
- Update `## Driver Selection` thresholds: `< (1/3) *
  frontBufferLength` → Throughput, `>= (2/3) * frontBufferLength` →
  BOLA. With default `frontBufferLength = 30`, that's 10s/20s. Note
  that the transition is checked on `BUFFER_APPENDED`, not on every
  evaluation tick.
- Drop the `getBufferFullness` bullet from the `## Observability`
  section — that public method is removed in this refactor.
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
It was used by `AbrController` and `BolaScorer` internally, plus
documented as an observability hook. Internal callers are migrated
to `getFrontBuffer_()` / inlined equivalents; external callers (if
any) lose the hook.

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
