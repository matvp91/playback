# ABR stability & recovery — design

## Problem

After a transient bandwidth throttle (e.g. Chrome devtools throttling
on, then off), the player downgrades correctly but never returns to
the original quality tier. The throughput estimate eventually climbs
back within ~1 minute, yet the picked stream remains capped below the
top tier.

Two related root causes:

1. **EWMA can't tell a transient device blip from a real bandwidth
   drop.** A single artificially-delayed network response (common on
   low-end devices that briefly stall network requests) collapses the
   throughput estimate even when the front buffer would have absorbed
   the deviation. Subsequent recovery is slow.
2. **The BOLA-O anti-oscillation cap holds upgrades back even when
   the buffer signal is unambiguous.** Once `useBola_` is true, the
   buffer is — by definition — full enough that BOLA's recommendation
   is trustworthy. Capping it by a still-lagging throughput estimate
   prevents legitimate climbs back to top quality.

`InsufficientBufferRule`-style underrun protection (`applyLowBufferCap_`)
is mostly inert at full buffer (it only binds below ~5s of front buffer
with default config) and is not the cause of the recovery failure.
It stays as-is.

## Goals

- Stream stability: a single low-throughput sample must not trigger
  a quality drop while the front buffer can absorb it.
- Recovery: after sustained buffer-healthy conditions, BOLA's pick
  must be allowed to climb past the throughput-derived cap.
- No new configuration knobs. Both behaviors derive entirely from
  existing config (`frontBufferLength`, `slowHalfLife`).

## Non-goals

- Replacing the dual-EWMA estimator. The fast/slow half-lives stay.
- Reworking driver selection. The hysteresis between throughput and
  BOLA stays as-is.
- Generalising to multi-rule aggregation à la dash.js
  `ABRRulesCollection`. Out of scope.

## Design

Two changes to `AbrController` plus a small extension to
`ThroughputEstimator`.

### 1. Buffer-headroom-weighted downward samples

`ThroughputEstimator.sample` gains an optional weight scalar:

```ts
sample(durationSeconds: number, bytes: number, weightFactor: number = 1)
```

Internally, the EWMA weight becomes `durationSeconds * weightFactor`.
The bps value (`bytes * 8 / durationSeconds`) is unchanged — only the
sample's *influence* on the estimate is scaled.

`AbrController.onNetworkResponse_` computes the factor:

```ts
const bps = (bytes * 8) / durationSec;
const current = this.throughput_.getEstimate();
const downward = current !== null && bps < current;
const fbl = this.player_.getConfig().frontBufferLength;
const headroom = Math.min(1, this.getFrontBuffer_() / fbl);
const weightFactor = downward ? 1 - headroom : 1;
this.throughput_.sample(durationSec, bytes, weightFactor);
```

Reading the formula: *the more buffer headroom we have, the less we
trust a single low sample.*

- `frontBuffer >= frontBufferLength` (full): `weightFactor = 0` —
  downward samples are ignored entirely.
- `frontBuffer = 0`: `weightFactor = 1` — downward samples count
  fully, the EWMA reacts at normal speed.
- Linear ramp in between.
- Upward samples (bps ≥ current estimate) always count fully —
  network improvements register without delay.

Behavioural consequences:

- A device-induced single delay arrives, gets discounted in
  proportion to current buffer headroom, EWMA barely moves, BOLA
  stays the course.
- A real sustained bandwidth drop produces successive low samples
  while the buffer drains: as `frontBuffer` falls, headroom shrinks,
  weights climb, the EWMA reacts. By the time the buffer crosses
  the BOLA lower hysteresis, the throughput driver has the most
  recent reality reflected in the estimate.
- The InsufficientBufferRule cap (`applyLowBufferCap_`) remains the
  underrun safety net during the transition.

`ThroughputEstimator.getEstimate()` is unchanged: still
`Math.min(fast, slow)`, still null until `minTotalBytes` is exceeded.

### 2. Lift the BOLA-O cap on sustained BOLA-active buffer

The current cap (in `evaluate_()`):

```ts
if (
  pick &&
  activeStream &&
  throughputPick &&
  pick.bandwidth > activeStream.bandwidth &&
  pick.bandwidth > throughputPick.bandwidth
) {
  pick = throughputPick.bandwidth > activeStream.bandwidth
    ? throughputPick
    : activeStream;
}
```

A new latch tracks how long `useBola_` has been continuously true:

- `useBolaSinceMs_: number | null` — `performance.now()` at the
  rising edge of `useBola_` (transition from `false` to `true`).
  Set to `null` whenever `useBola_` becomes `false`, including on
  `seeking`.

The cap is bypassed once that duration meets or exceeds
`slowHalfLife`:

```ts
const sustained =
  this.useBolaSinceMs_ !== null &&
  performance.now() - this.useBolaSinceMs_ >= abr.slowHalfLife * 1000;

if (
  !sustained &&
  pick &&
  activeStream &&
  throughputPick &&
  pick.bandwidth > activeStream.bandwidth &&
  pick.bandwidth > throughputPick.bandwidth
) {
  pick = throughputPick.bandwidth > activeStream.bandwidth
    ? throughputPick
    : activeStream;
}
```

Rationale for tying the duration to `slowHalfLife`: after one slow
EWMA half-life of post-recovery samples flowing in, the slow
estimate has absorbed new values to ~50% influence. By that point
the signal "buffer has stayed in the BOLA-active band" is the more
reliable indicator of network capacity, and BOLA's pick should be
trusted. The duration uses the seconds value of `slowHalfLife`
directly — no multiplier, no new tunable.

The latch is updated wherever `useBola_` is mutated:

- `onBufferAppended_`: when the hysteresis flips `useBola_` from
  `false` to `true`, set `useBolaSinceMs_ = performance.now()`.
  When it flips from `true` to `false`, clear it.
- `onSeeking_`: clear it alongside the existing
  `isBufferSteady_ = false` and `useBola_ = false`.

In a sustained low-bandwidth regime — where the buffer cannot stay
in the BOLA band — `useBola_` flips back to `false` before
`slowHalfLife` elapses, the latch resets, and the cap remains
active. Oscillation prevention is preserved exactly as today for
that case.

In the transient-throttle case — where the buffer fills back to
near `frontBufferLength` within seconds of unthrottle — `useBola_`
stays `true` continuously. After `slowHalfLife` seconds the cap
lifts, BOLA's full-buffer pick goes through, the player climbs.

## Configuration

No changes to `AbrConfig` or `PlayerConfig`. All new behaviour is
derived from:

- `PlayerConfig.frontBufferLength` (sample weighting).
- `AbrConfig.slowHalfLife` (cap-lift duration).

## Testing

Two new test groups in `test/abr/abr_controller.test.ts`, each
mirroring the structure of the existing `BOLA anti-oscillation
guard` and `low-buffer safety cap` describes:

### Buffer-headroom sample weighting

- A downward sample at full buffer leaves the estimate unchanged
  (within EWMA noise floor).
- A downward sample at empty buffer updates the estimate at full
  weight (matches today's behaviour).
- An upward sample updates the estimate at full weight regardless of
  buffer state.
- A sequence of low samples while the buffer drains progressively
  shifts the estimate as headroom shrinks.

`ThroughputEstimator` already has a unit test surface; add a direct
test for the new `weightFactor` parameter (a sample with
`weightFactor = 0` is a no-op; a sample with `weightFactor = 0.5`
moves the estimate half as much as `weightFactor = 1`).

### BOLA-O cap lift on sustained `useBola_`

- The cap remains active while `useBola_` has been true for less
  than `slowHalfLife` seconds — verify the post-throttle scenario
  before the lift fires (BOLA pick is still capped).
- After advancing fake timers past `slowHalfLife * 1000`, BOLA's
  upgrade pick goes through uncapped.
- A `seeking` event mid-wait resets the latch — verify the cap is
  re-armed.
- A `useBola_` flip back to `false` mid-wait resets the latch —
  verify by setting buffer below the lower hysteresis, then back
  above; the duration starts over.

Existing tests in `BOLA anti-oscillation guard` continue to pass —
they all complete within a single 1.1s tick, well below
`slowHalfLife`.

## Out of scope (deferred)

These were considered and intentionally left out of this design:

- **Asymmetric `min`/`max(fast, slow)` selection.** Splitting the
  estimator's `getEstimate()` into separate upgrade-vs-downgrade
  views was rejected: keeps the estimator API smaller, and the
  buffer-headroom weighting subsumes the stability case.
- **Switch confirmation window.** Requiring K consecutive ticks of
  agreement before emitting was deemed redundant once the EWMA is
  stabilised by buffer-headroom weighting.
- **Buffer-trajectory gate on downgrades.** Pairs naturally with the
  weighting change but adds another knob; revisit if the post-spec
  measurements show residual flap.
