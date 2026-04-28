# Adaptive Bitrate (ABR)

cmaf-lite includes a built-in ABR controller that automatically manages
video quality during playback. It runs **one of two drivers** per
evaluation tick, selected by a buffer-fullness hysteresis.

## Drivers

### Throughput

Measures download speed using a dual EWMA (Exponential Weighted Moving
Average) estimator. Picks the highest video stream that the network
can sustain, with asymmetric thresholds to resist oscillation — it
requires more headroom to upgrade than to stay at the current quality.

Active when the buffer is low. Falls back to a configured default
estimate while undersampled.

### BOLA (Buffer Optimized)

Uses buffer level to score each quality tier (BOLA-O,
arxiv 1601.06748). When the buffer is comfortable, BOLA favors higher
quality; as the buffer drops, it shifts toward conservative picks.

A one-shot `isBufferSteady` latch gates BOLA's scoring: false until
the front buffer has crossed `maxSegmentDuration` at least once since
the last reset. The latch resets on media `seeking`. Below this
threshold, BOLA returns no recommendation and the controller falls
back to throughput.

**Anti-oscillation cap.** BOLA's score is buffer-only by design, so
a sustained low-bandwidth regime would otherwise let it pick a tier
the network can't sustain — buffer drains, hysteresis flips to
throughput, throughput picks low, buffer recovers, BOLA picks high
again. Mirroring `dash.js`'s `BolaRule.js`, the controller caps any
BOLA-driven *upgrade* by the throughput driver's pick: if BOLA's pick
exceeds both the active stream and the throughput-safe pick, the
controller falls back to the throughput pick (or stays at active when
even that would be a downgrade). BOLA is still free to stay or
downgrade; it just cannot upgrade past what throughput sustains.

## Driver Selection

A buffer-fullness hysteresis derived from `frontBufferLength` as
fractions below the fill cap:

- `frontBuffer < (1/3) * frontBufferLength`  → **Throughput**.
- `frontBuffer >= (2/3) * frontBufferLength` → **BOLA**.
- in between → keep current driver (dead zone).

With default `frontBufferLength = 30`, that's 10s/20s. The transition
is checked on `BUFFER_APPENDED`, not on every evaluation tick.
Initial driver is `Throughput` (buffer is 0 at startup).

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
dropped-frame ratio is high. Removed in this refactor; will be
restored as a separate concern (per-stream history) in a follow-up.

### BOLA placeholder buffer

The original BOLA paper describes a virtual buffer that compensates
for non-download delays (pauses, stalls, seek recovery). cmaf-lite is
VOD-focused; the dual-driver model with hysteresis gives the same
practical safety without the placeholder buffer's bookkeeping.

### Abandon-fragment

dash.js abandons in-flight downloads when bandwidth drops below the
in-progress segment's bitrate. cmaf-lite's `NetworkService` has no
in-flight progress events; deferred.

### InsufficientBufferRule

BOLA can pick a stream that won't finish before underrun in
low-buffer regimes. dash.js v5 caps the pick by
`safeThroughput * bufferLevel / fragmentDuration * 0.7` in a parallel
rule (`InsufficientBufferRule.js`). Deferred; cmaf-lite's hysteresis
(Throughput active below 10s) provides partial coverage.
