# Adaptive Bitrate (ABR)

cmaf-lite includes a built-in ABR controller that automatically manages
video quality during playback. It runs a single decision flow per
evaluation tick — a throughput-driven pick that the buffer is
allowed to raise when conditions allow.

## Throughput-driven pick (the floor)

Measures download speed using a dual EWMA (Exponential Weighted Moving
Average) estimator and selects the highest video stream the network
can sustain. Asymmetric thresholds resist oscillation as a
single-signal decision:

- Upgrade: `stream.bandwidth ≤ estimate × bandwidthUpgradeTarget`
  (requires headroom to step up).
- Stay / downgrade: `stream.bandwidth ≤ estimate × bandwidthDowngradeTarget`
  (current quality is sustainable).

Falls back to `defaultBandwidthEstimate` while the estimator is
undersampled.

## Buffer-aware uplift

When the front buffer has been continuously comfortable, the buffer
itself is corroborating evidence that the EWMA is reliable. In that
regime, the upgrade margin is unnecessary and the pick is allowed to
raise to the highest stream the estimate sustains:

```
ceiling = estimate × bandwidthDowngradeTarget
```

The picked stream is then `max(throughput-pick, highest stream ≤
ceiling)`. The buffer-aware uplift can only *raise* the pick, never
lower it — so a single low sample cannot cause a downgrade via this
path.

A buffer-fullness hysteresis derived from `frontBufferLength`
controls when the uplift is active:

- `frontBuffer >= (2/3) * frontBufferLength` → uplift on.
- `frontBuffer < (1/3) * frontBufferLength` → uplift off.
- in between → keep current state (dead zone).

With default `frontBufferLength = 30`, that's 10s/20s. The state is
updated on `BUFFER_APPENDED` and reset on media `seeking`.

## Switch throttle

After every emitted `ADAPTATION`, further switches are suppressed
for `switchInterval` seconds (default 8s). The evaluator still runs
every second and recomputes the pick; only the emit is gated.

## Observability

One read-only method on `Player`:

- `getThroughputEstimate(): number` — current bits/second estimate
  (default applied while undersampled).

## Configuration

All settings live under the `abr` key in `PlayerConfig`. See
`AbrConfig` for the full list of options and their defaults.

## Future Enhancements

The following refinements are intentionally deferred.

### Dropped frames

A device-capability cap that downgrades quality when the browser's
dropped-frame ratio is high. Removed in an earlier refactor; will be
restored as a separate concern (per-stream history) in a follow-up.

### Abandon-fragment

Abandoning in-flight downloads when bandwidth drops below the
in-progress segment's bitrate would shorten reaction time on sharp
drops. cmaf-lite's `NetworkService` has no in-flight progress
events; deferred.
