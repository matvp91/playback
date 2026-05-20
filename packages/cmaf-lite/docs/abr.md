# Adaptive Bitrate (ABR)

cmaf-lite includes a built-in ABR controller that automatically manages
video quality during playback. The current implementation is
throughput-only: a dual EWMA bandwidth estimator drives a single-signal
decision with asymmetric upgrade/downgrade thresholds.

## Throughput-driven pick

Download speed is measured with a dual EWMA (Exponential Weighted
Moving Average) estimator (`min(fast, slow)` — adapt down quickly, up
slowly) and the highest video stream the network can sustain is
selected. Asymmetric thresholds give the single-signal decision its
stability:

- Upgrade: `stream.bandwidth ≤ estimate × bandwidthUpgradeTarget`
  (requires headroom to step up).
- Stay / downgrade: `stream.bandwidth ≤ estimate × bandwidthDowngradeTarget`
  (current quality is sustainable).

Falls back to `defaultBandwidthEstimate` while the estimator is
undersampled.

## Switch throttle

After every emitted `ADAPTATION`, further switches are suppressed for
`switchInterval` seconds (default 8s). The evaluator still runs every
second and recomputes the pick; only the emit is gated.

## Observability

One read-only method on `Player`:

- `getThroughputEstimate(): number` — current bits/second estimate
  (default applied while undersampled).

## Configuration

All settings live under the `abr` key in `PlayerConfig`. See
`AbrConfig` for the full list of options and their defaults.

## Future Enhancements

The following refinements are intentionally deferred.

### BOLA selector

A buffer-occupancy-driven selector (BOLA) layered on top of the
throughput pick: once the buffer has built up enough runway, the
buffer level becomes the primary signal and the highest stream whose
per-bitrate buffer threshold is satisfied is picked. Requires
per-bitrate threshold derivation and a confidence/score gate so the
selector cannot commit to a tier the network has not actually shown
it can sustain. Pure throughput is the safety floor it falls back to.

### Buffer threshold config

When BOLA lands, the buffer-occupancy thresholds that switch the
selector between throughput-only and buffer-driven modes (and the
per-bitrate buffer levels themselves) will be exposed through
`AbrConfig`.

### Dropped frames

A device-capability cap that downgrades quality when the browser's
dropped-frame ratio is high. Removed in an earlier refactor; will be
restored as a separate concern (per-stream history) in a follow-up.

### Abandon-fragment

Abandoning in-flight downloads when bandwidth drops below the
in-progress segment's bitrate would shorten reaction time on sharp
drops. cmaf-lite's `NetworkService` has no in-flight progress
events; deferred.
