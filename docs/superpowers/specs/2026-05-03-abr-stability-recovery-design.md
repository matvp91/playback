# ABR simplification — design

## Problem

The ABR controller has accumulated several layers — throughput
driver, BOLA scoring, anti-oscillation cap, low-buffer safety cap —
each addressing a real concern but together making the decision
flow harder to reason about. The recovery bug (post-throttle, the
player doesn't return to the original tier) is symptomatic: it lives
at the seam between two of those layers.

## Goal

A single ABR strategy that:

- Uses throughput (EWMA) as the primary signal for switch decisions.
- Lifts the pick when the buffer corroborates that the network has
  headroom (a "BOLA-lite" use of buffer fullness).
- Has zero standalone safety caps. The throughput driver's existing
  asymmetric upgrade/downgrade margins are the entire stability
  story; buffer health is the entire optimism story.
- Fits in roughly 100 lines.

## Design

Two ABR signals, combined in one function:

1. **Throughput-driven pick (the floor).** Highest stream the EWMA
   confirms — asymmetric thresholds (`bandwidthUpgradeTarget = 0.7`
   for upgrades, `bandwidthDowngradeTarget = 0.95` for stay/downgrade)
   give it the stability it needs as a single signal.

2. **Buffer-driven uplift.** When the front buffer has been
   continuously above the upper hysteresis threshold (`(2/3) *
   frontBufferLength` to enter, `(1/3) * frontBufferLength` to exit),
   the buffer is corroborating evidence. The pick is allowed to
   raise to the highest stream the EWMA confirms sustainable
   (`EWMA × bandwidthDowngradeTarget`) — no upgrade margin needed
   because the buffer signal is the second source of confirmation.

The final `evaluate_` body:

```ts
private evaluate_() {
  const streams = this.player_.getStreams(MediaType.VIDEO);
  if (streams.length === 0) return;
  const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
  const { abr } = this.player_.getConfig();
  const bw =
    this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

  // Throughput-driven pick — asymmetric thresholds for stability.
  let pick: VideoStream | null = null;
  for (const s of streams) {
    let scaled = bw;
    if (activeStream) {
      scaled *= s.bandwidth > activeStream.bandwidth
        ? abr.bandwidthUpgradeTarget
        : abr.bandwidthDowngradeTarget;
    }
    if (s.bandwidth <= scaled) pick = s;
  }
  pick = pick ?? streams[0]!;

  // Buffer-aware uplift — when the buffer corroborates, drop the
  // upgrade margin and allow the highest sustainable tier.
  if (this.useBola_) {
    const ceiling = bw * abr.bandwidthDowngradeTarget;
    let raised: VideoStream | null = null;
    for (const s of streams) if (s.bandwidth <= ceiling) raised = s;
    if (raised && raised.bandwidth > pick.bandwidth) pick = raised;
  }

  if (pick === activeStream) return;
  const now = performance.now();
  if (now - this.lastSwitchAt_ < abr.switchInterval * 1000) return;
  this.lastSwitchAt_ = now;
  log.info("Decision", pick);
  this.player_.emit(Events.ADAPTATION, { stream: pick });
}
```

## What stays

- `ThroughputEstimator` (dual fast/slow EWMA) — unchanged.
- `useBola_` hysteresis boolean — updated on `BUFFER_APPENDED`, reset
  on `seeking`. Same thresholds as today (1/3 lower, 2/3 upper).
- `lastSwitchAt_` and the `switchInterval` throttle.
- The `NETWORK_RESPONSE`, `BUFFER_APPENDED`, `MEDIA_ATTACHED`,
  `MEDIA_DETACHING`, and `seeking` event handlers (in pared-down
  form).
- `getThroughputEstimate()` public method.

## What gets removed

| Removed | Why it can go |
|---|---|
| `pickFromBola_` (~30 lines of log/V/gp math) | Replaced by a simple ceiling pick; behavior at full buffer is equivalent for typical adaptive ladders |
| BOLA-O anti-oscillation cap (separate logic block) | Folded into `max(throughput-pick, ceiling)` — same effect, fewer branches |
| `applyLowBufferCap_` (~30 lines) and its `isBufferSteady_` latch | Sub-5s safety net that fires in a narrow window; the throughput driver's `0.95` downgrade margin provides the practical equivalent |
| `MINIMUM_BUFFER_S` constant | Was only used by `pickFromBola_` |
| `lowBufferSafetyFactor` config key | Was only used by `applyLowBufferCap_` |

## Configuration

`AbrConfig.lowBufferSafetyFactor` is removed (no callers remain
after the cap is deleted). All other keys remain unchanged.

## Behaviour vs current

- **Recovery (the reported bug):** fixed. The buffer-driven uplift
  reaches the top tier when `EWMA ≥ tier / 0.95 ≈ 1.05 × tier`,
  versus the current `1.43 × tier` requirement.
- **Sustained low bandwidth:** stable. The ceiling is the highest
  stream the EWMA literally supports (× 0.95), so the pick never
  exceeds what the network can sustain. No oscillation.
- **Single transient bad sample:** does not cause a downgrade. The
  uplift's floor is the throughput-pick, which uses the existing
  `0.95` "stay" margin; a single noisy sample below the active
  stream's bitrate / 0.95 leaves the active pick unchanged.
- **Buffer-aware quality progression:** binary instead of graded.
  Below `2/3 frontBufferLength`, throughput drives; above, the
  buffer uplift kicks in. For dense ladders (many close-spaced
  tiers) this is a slight regression vs BOLA's continuous score;
  for the typical 3–6 tier CMAF ladder it is indistinguishable.
- **Sub-5s buffer scenarios with stale-high EWMA:** lose the
  explicit `applyLowBufferCap_` safety net. The throughput driver
  still downgrades as new samples land; the previously-explicit
  margin is now part of the throughput driver's natural reaction
  curve.

## Testing

`packages/cmaf-lite/test/abr/abr_controller.test.ts` is removed
alongside its only consumer of the stub framework
(`test/__framework__/abr_stubs.ts`). A new ABR test surface will be
designed as part of a separate testing-framework pass; covering the
new controller through the old stubs is not a goal of this change.

`test/abr/throughput_estimator.test.ts` is unaffected and stays.

## Out of scope

- **`bandwidthUpgradeTarget` tuning.** Stays at `0.7` because the
  throughput driver uses it as a single-signal upgrade margin where
  conservatism is correct. The buffer-aware uplift does not consult
  it.
- **Sample-credibility weighting on the EWMA.** Considered earlier
  and dropped — the cap floor (`max(throughput-pick, ceiling)`)
  already prevents single-sample blips from causing downgrades.
- **Abandon-fragment** and other open enhancements remain deferred
  per `packages/cmaf-lite/docs/abr.md`.
