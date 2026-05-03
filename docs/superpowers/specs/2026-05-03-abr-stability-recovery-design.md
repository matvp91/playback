# ABR stability & recovery — design

## Problem

After a transient bandwidth throttle (e.g. Chrome devtools throttling
on, then off), the player downgrades correctly but never returns to
the original quality tier. The throughput estimate eventually climbs
back within ~1 minute, yet the picked stream remains capped below the
top tier.

Root cause: the BOLA-O anti-oscillation cap holds upgrades back even
when the buffer signal is unambiguous. The cap currently compares
BOLA's pick to the *throughput driver's pick*, which already folds in
`bandwidthUpgradeTarget = 0.7` (a 43% headroom requirement). That
margin is correct for the throughput driver acting as a *single* signal
— but it is the wrong threshold to apply on top of BOLA, whose own
full-buffer signal is the second corroboration. As a result, to allow
BOLA to pick tier N the EWMA must reach 1/0.7 ≈ 1.43 × tier N. For any
network whose actual capacity is below that bar, the cap is
permanently binding and the player cannot return to tier N.

`InsufficientBufferRule`-style underrun protection (`applyLowBufferCap_`)
is mostly inert at full buffer (it only binds below ~5s of front buffer
with default config) and is not the cause of the recovery failure. It
stays as-is.

## Goals

- Recovery: after the EWMA has caught up to a recovered network,
  BOLA's pick must be allowed to climb to whatever the network
  literally supports — not held back by the throughput driver's
  conservative upgrade margin.
- Stream stability: oscillation prevention in genuinely
  low-bandwidth regimes is preserved exactly as today.
- No new configuration knobs, no new constants, no new state.
- EWMA and BOLA remain pure: each operates on its own signal, and
  buffer-aware decision-making lives entirely in
  `AbrController.evaluate_`.

## Non-goals

- Modifying `ThroughputEstimator`. Its API and behaviour are
  unchanged.
- Modifying BOLA scoring (`pickFromBola_`). Unchanged.
- Modifying driver selection (the `useBola_` / `isBufferSteady_`
  hysteresis). Unchanged.
- Generalising to multi-rule aggregation à la dash.js
  `ABRRulesCollection`. Out of scope.

## Design

A single change to `AbrController`: introduce a separate cap
calculation for the BOLA-O guard, distinct from the throughput
driver's own decision.

### Recalibrate the BOLA-O cap

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

`throughputPick` itself folds in `bandwidthUpgradeTarget = 0.7`,
which means BOLA is held below "highest stream that fits under
0.7 × estimate." That margin is correct for the throughput driver
acting as a single signal — it must be conservative without
corroboration — but it is the wrong threshold to cap a
buffer-corroborated rule like BOLA.

The fix introduces a separate helper that resolves BOLA's ceiling
to "the highest stream the EWMA confirms is *sustainable*", reusing
`bandwidthDowngradeTarget` (the existing config key whose semantics
are precisely *"the stream is sustainable at this estimate"*):

```ts
private throughputCap_(streams: VideoStream[]): VideoStream | null {
  const { abr } = this.player_.getConfig();
  const bw =
    this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  const threshold = bw * abr.bandwidthDowngradeTarget;
  let best: VideoStream | null = null;
  for (const stream of streams) {
    if (stream.bandwidth <= threshold) {
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
  Conservative; uses `bandwidthUpgradeTarget` (0.7) /
  `bandwidthDowngradeTarget` (0.95) to gate switches off a single
  signal.
- `throughputCap_` — *the BOLA-O ceiling*. Direct; the highest
  stream the EWMA confirms sustainable (× 0.95). BOLA's buffer
  signal is the second source of confirmation, so the upgrade
  margin is unnecessary; the small `bandwidthDowngradeTarget` margin
  remains as a hedge against EWMA noise at exact tier boundaries.

Behavioural consequences:

- Sustained low-bandwidth regime: the EWMA settles at the actual
  network rate, `throughputCap` resolves to the highest sustainable
  stream, BOLA's full-buffer pick gets capped to that. Oscillation
  prevented exactly as today.
- Post-throttle recovery: as the EWMA climbs back, `throughputCap`
  climbs with it. Each evaluation tick is permitted to step BOLA's
  pick to the next tier the EWMA now supports. After EWMA recovery
  plus a few `switchInterval` cooldowns, the player reaches the
  highest tier the network sustains with ≥ 5% margin.
- Single transient delay: the cap floor is `activeStream` (the
  formula picks `max(throughputCap, active)`), so a one-off bad
  sample can never *cause* a downgrade — at worst it briefly
  prevents an upgrade until the next sample lands.
- Boundary stability: with the 5% margin from
  `bandwidthDowngradeTarget`, EWMA noise around an exact tier
  bitrate does not flap the cap between adjacent tiers.

No new state, no new constants, no rising-edge tracking, no
duration latch, no API changes outside `AbrController`.

## Configuration

No changes to `AbrConfig` or `PlayerConfig`. The cap formula reuses
two existing values:

- The EWMA estimate from `ThroughputEstimator.getEstimate()`.
- `AbrConfig.bandwidthDowngradeTarget` (0.95) — already documented
  as *"bandwidth fraction that triggers a downgrade below current
  quality"*; semantically equivalent to *"streams whose bitrate
  fits under this fraction of the estimate are sustainable at the
  estimate"*.

## Testing

### New tests in `BOLA-O cap recalibrated` describe

- Sustained low-bw: streams = [500k, 1.5M, 3M, 5M], EWMA settled
  at 1M, BOLA wants top → cap resolves to streams ≤ 0.95 × 1M =
  0.95M = 500k. BOLA's pick is capped to 500k (or
  `max(500k, active)`).
- Post-throttle recovery: drive successive samples that push EWMA
  from 1M up through 6M; assert BOLA's pick climbs through the
  tiers as `throughputCap` admits each.
- Boundary stability: EWMA exactly at a tier bitrate × (1 / 0.95).
  e.g. 5M / 0.95 ≈ 5.26M → top tier (5M) is admitted. With EWMA at
  5.0M (no margin), cap holds at 3M; sub-5M EWMA noise does not
  flap into 5M.

### Existing `BOLA anti-oscillation guard` tests

- *caps a BOLA upgrade to the active stream when throughput cannot
  sustain any upgrade*: EWMA = 600k, active = streams[0] = 500k.
  Under the new cap: threshold = 600k × 0.95 = 570k → only 500k
  fits, `throughputCap` = 500k. BOLA wants top, cap fires,
  `pick = max(500k, 500k) = 500k = active`, no emit.
  **Outcome unchanged.**
- *caps a BOLA upgrade to the throughput-safe stream when
  throughput permits a partial upgrade*: EWMA = 2.4M, active =
  500k. Under the new cap: threshold = 2.4M × 0.95 = 2.28M →
  streams ≤ 2.28M = 1.5M, `throughputCap` = 1.5M. BOLA wants top,
  cap fires, `pick = throughputCap (1.5M) > active (500k)
  → 1.5M`. **Outcome unchanged** (still emits streams[1]).

Both tests' comments need updating to describe the new derivation
(× 0.95 from `bandwidthDowngradeTarget`, no `bandwidthUpgradeTarget`
involvement). The numerical assertions stay the same in both cases
because the chosen test values happen to land on the same tier
under the new cap.

### `low-buffer safety cap (InsufficientBufferRule)` tests

Unaffected. The `applyLowBufferCap_` helper is independent of this
change.

## Out of scope (deferred or rejected)

- **Buffer-headroom-weighted EWMA samples.** Considered as a
  separate stability mechanism (dampening downward samples when
  buffer is healthy). Rejected because (a) it would require
  threading buffer state into the estimator's API, breaking the
  EWMA / BOLA / decision-layer separation, and (b) the cap floor
  (`max(throughputCap, active)`) already prevents single-sample
  blips from causing downgrades, so the dampening is unnecessary
  to fix the reported scenarios.
- **Switch confirmation window.** Not needed once the cap is
  calibrated correctly; `switchInterval` already provides per-switch
  cooldown.
- **Buffer-trajectory gate on downgrades.** Defer; revisit only if
  measurements after this change show residual flap.
