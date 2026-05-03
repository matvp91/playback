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
- Recovery: after the EWMA has caught up to a recovered network,
  BOLA's pick must be allowed to climb to whatever the network
  literally supports — not held back by the throughput driver's
  conservative upgrade margin.
- No new configuration knobs. Both behaviors derive from existing
  state (`frontBufferLength`, the EWMA estimate itself).

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

### 2. Recalibrate the BOLA-O cap to raw EWMA capacity

The current cap (in `evaluate_()`) compares BOLA's pick to the
*throughput driver's pick*:

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

`throughputPick` itself folds in `bandwidthUpgradeTarget` (0.7),
which means BOLA is held below "highest stream that fits under
0.7 × estimate." That 43% headroom requirement is correct for the
throughput driver's *own* upgrade decisions (single signal, must be
conservative), but inappropriate as a cap on BOLA — BOLA's
full-buffer signal already corroborates the EWMA. The over-cap is
why a recovered network never lets BOLA reach the top tier.

The fix introduces a separate helper that resolves BOLA's ceiling
to "what the EWMA literally supports":

```ts
private throughputCap_(streams: VideoStream[]): VideoStream | null {
  const { abr } = this.player_.getConfig();
  const bw =
    this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  let best: VideoStream | null = null;
  for (const stream of streams) {
    if (stream.bandwidth <= bw) {
      best = stream;
    }
  }
  return best ?? streams[0] ?? null;
}
```

The cap comparison in `evaluate_()` switches from `throughputPick`
to `throughputCap`:

```ts
const throughputCap = this.throughputCap_(streams);
if (
  pick &&
  activeStream &&
  throughputCap &&
  pick.bandwidth > activeStream.bandwidth &&
  pick.bandwidth > throughputCap.bandwidth
) {
  pick = throughputCap.bandwidth > activeStream.bandwidth
    ? throughputCap
    : activeStream;
}
```

Two distinct questions, two distinct functions:

- `pickFromThroughput_` — *the throughput driver's own decision*.
  Conservative; uses `bandwidthUpgradeTarget` /
  `bandwidthDowngradeTarget` to gate switches off a single signal.
- `throughputCap_` — *the BOLA-O ceiling*. Direct; the highest
  stream the EWMA estimate literally fits, with no margin on top.
  BOLA's buffer signal is the second source of confirmation.

Behavioural consequences:

- Sustained low-bandwidth regime: the EWMA settles at the actual
  network rate, `throughputCap` resolves to the highest sustainable
  stream, BOLA's full-buffer pick gets capped to that. Oscillation
  prevented exactly as today.
- Post-throttle recovery: as the EWMA climbs back, `throughputCap`
  climbs with it. Each evaluation tick is permitted to step BOLA's
  pick to the next tier the EWMA now supports. After EWMA recovery
  plus a few `switchInterval` cooldowns, the player reaches top.

No new state, no new constants, no rising-edge tracking, no
duration latch.

## Configuration

No changes to `AbrConfig` or `PlayerConfig`. All new behaviour is
derived from:

- `PlayerConfig.frontBufferLength` (sample weighting).
- The EWMA estimate itself (BOLA-O cap).

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

### BOLA-O cap recalibrated to raw EWMA

- Sustained low-bw: with EWMA settled at a low estimate, BOLA's
  full-buffer pick is capped to the highest stream that fits under
  the raw estimate (the new `throughputCap`), regardless of
  `bandwidthUpgradeTarget`. Verify a streams=[200k, 1M, 3M, 5M]
  setup with EWMA = 1M caps BOLA at the 1M tier.
- Post-throttle recovery: with EWMA climbing across successive
  ticks (simulated by injecting samples between timer advances),
  BOLA's pick climbs one tier per tick up to top.
- Edge: when EWMA exactly equals a stream's bitrate, that stream is
  permitted (≤ comparison), so a 5M network reaches a 5M stream.

The existing `BOLA anti-oscillation guard` tests need
re-calibration: today they assert "throughput permits a partial
upgrade to streams[1]" using `bandwidthUpgradeTarget`. Under the
new cap, the same EWMA value (2.4M) directly permits streams[1]
(1.5M ≤ 2.4M) — the assertion holds, the threshold reasoning
shifts. Update test comments accordingly.

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
