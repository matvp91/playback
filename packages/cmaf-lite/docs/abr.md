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

Active when the buffer is comfortable. Has a **two-gate trust state**:
the gate stays closed (and the controller falls back to throughput)
unless

1. at least one video segment has been appended to the SourceBuffer
   since the last reset (init/seek/flush), and
2. the front buffer has reached at least one segment duration.

The gate is reset on media `seeking` and on video `BUFFER_FLUSHED`.

## Driver Selection

A buffer-fullness hysteresis anchored to absolute seconds:

- `frontBuffer < 10s`  → **Throughput** (low buffer; safe pick).
- `frontBuffer > 20s`  → **BOLA** (comfortable buffer; utility pick).
- in between           → keep current driver (dead zone).

Initial driver is `Throughput` (buffer is 0 at startup).

## Observability

Two read-only methods on `Player`:

- `getBufferFullness(): number` — 0..1, clamped. Front buffer in
  seconds divided by `frontBufferLength`.
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
