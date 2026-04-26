# ABR Dual-Driver Restructure

## Overview

Restructure the ABR controller around two explicit drivers — Throughput
(dual EWMA) and BOLA — selected by a buffer-level hysteresis. Replaces
the existing four-rule min-merge model. Modeled after dash.js v5's
`_updateDynamicAbrStrategy` toggle, scaled to cmaf-lite's size.

## Motivation

The current `AbrController` evaluates four rules — Throughput, BOLA,
InsufficientBuffer, DroppedFrames — on every tick and picks the lowest
bandwidth among proposals. The pattern conflates independent concerns:

- Throughput and BOLA are competing *strategies* for the same decision
  (which stream best fits current conditions). Running both and taking
  min means BOLA's buffer-aware advantages are erased whenever
  Throughput is more conservative — BOLA never gets to drive.
- InsufficientBuffer is not a peer signal — it's a low-buffer adjustment
  to the throughput estimate. Encoding it as a rule duplicates the
  throughput estimator's role.
- DroppedFrames is a device-capability cap, not a quality strategy. As a
  rule it competes with the others on bandwidth instead of capping them.

dash.js v5 resolved these by:

- Running only one of BOLA/Throughput at a time per media type, switched
  on buffer hysteresis.
- Folding low-buffer behavior into the throughput strategy itself.
- Treating dropped frames and abandonment as separate concerns with
  dedicated handling.

This spec applies the same lessons at cmaf-lite scale.

## Goals

- One active driver per evaluation, selected by buffer level.
- Dual EWMA throughput estimation lives inside the throughput driver.
- BOLA implementation unchanged in formula, repackaged behind a driver
  interface.
- Public `AbrController` API and `AbrConfig` shape unchanged.
- Per-file module size stays small; flat layout.

## Non-goals

- Dropped-frames handling — removed in this refactor, restored in a
  follow-up session with per-stream history.
- InsufficientBuffer rule — removed. The two-driver model with
  buffer hysteresis already encodes the low-buffer safety case
  (Throughput is the active driver below the low mark; fast EWMA
  half-life reacts to sudden degradation within seconds).
- Abandon-fragment rule — NetworkService has no in-flight progress
  events; deferred.
- BOLA placeholder buffer — already noted as deferred in `docs/abr.md`.
- Multi-period state, manual-switch queueing, L2A/LoL+ — out of scope.
- Renaming `Stream`/`VideoStream` to `Representation` — cmaf-lite keeps
  its neutral model.

## Architecture

```
AbrController (policy + wiring)
 ├── ThroughputDriver  — pure estimator. Owns Ewma state. No streams,
 │                       no events, no Player. Inputs: bandwidth
 │                       samples. Output: bits/s estimate.
 └── BolaDriver        — pure scorer. Owns BOLA params (lnS1, vM, Qmax,
                         gp, V) cached against the bandwidth ladder.
                         No events, no Player. Output: optimal index or
                         null (startup abstain).
```

Drivers are **pure logic objects** — testable in isolation, no event
bus, no Player coupling. The controller does all wiring and all policy.

Per evaluation tick, the controller:

1. Reads `bufferLevel`, `streams`, `activeStream`, config.
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA and `activeStream` exists:
   `i = bola.getOptimalIndex(streams, activeStream, bufferLevel,
   frontBufferLength)`. If non-null, `pick = streams[i]`.
4. If `pick` is still unresolved (active driver is Throughput, or BOLA
   abstained, or no active stream yet): run the throughput pick —
   `bandwidth = throughput.getEstimate(default) - audioBandwidth`,
   walk video streams, return highest stream fitting
   `bandwidth × {upgrade,downgrade}Target`, fall back to `streams[0]`.
5. Emits `ADAPTATION` if `pick` differs from `activeStream`.

The controller subscribes to `NETWORK_RESPONSE` and forwards
`(durationSec, byteLength)` to `throughput.sample(...)`.

## File Layout

```
lib/abr/
  abr_controller.ts      — orchestrator, event wiring, hysteresis
  throughput_driver.ts   — Ewma + EwmaBandwidthEstimator + ThroughputDriver
  bola_driver.ts         — BolaDriver
```

Files removed: `ewma.ts`, `ewma_bandwidth_estimator.ts` (folded into
`throughput_driver.ts` — only consumer).

## Types

```ts
// throughput_driver.ts (public surface)
export class ThroughputDriver {
  constructor(config: AbrConfig);
  sample(durationSec: number, bytes: number): void;
  getEstimate(defaultEstimate: number): number;
}

// bola_driver.ts (public surface)
export class BolaDriver {
  constructor();
  // null = abstain (startup, below segment-duration buffer).
  getOptimalIndex(
    streams: VideoStream[],
    activeStream: VideoStream,
    bufferLevel: number,
    frontBufferLength: number,
  ): number | null;
}
```

Neither driver takes the controller. ThroughputDriver receives samples
through `sample()`; BolaDriver receives streams + state per call.
Internal caching makes per-call ladder copies cheap (reference-equality
check).

## Driver Selection

Hysteresis around buffer level prevents flapping between drivers:

```
lowMark  = MINIMUM_BUFFER_S          // 10s — BOLA's own minimum
highMark = MINIMUM_BUFFER_S * 2      // 20s

bufferLevel < lowMark   → Throughput
bufferLevel > highMark  → BOLA
otherwise               → keep current driver
```

Initial driver is `Throughput` (buffer is 0 at startup). The controller
stores the current driver as a private field.

## Throughput Driver

Combines today's `EwmaBandwidthEstimator` and `Ewma` into one
self-contained module — pure estimator, no awareness of streams.

State:
- `Ewma` (fast and slow), wrapped in `EwmaBandwidthEstimator` —
  unchanged math; both classes are now file-private to
  `throughput_driver.ts`.
- Total bytes counter (gates switching to the EWMA estimate).

API:
- `sample(durationSec, bytes)` — push a measurement.
- `getEstimate(defaultEstimate)` — `min(fast, slow)` once
  `totalBytes ≥ minTotalBytes`, else the default.

No listeners; the controller calls `sample(...)` from its
`NETWORK_RESPONSE` handler.

## BOLA Driver

Mechanically identical to today's `evaluateBola_`, repackaged as a pure
scorer with internal caching.

State (lazy, recomputed when `streams` reference or `frontBufferLength`
changes):
- Cached `streams` reference and `frontBufferLength` value.
- Derived: `lnS1` (log of lowest bandwidth), `vM` (utility ceiling),
  `Qmax = max(frontBufferLength, MINIMUM_BUFFER_S + 2 × streams.length)`,
  `gp = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1)`,
  `V = MINIMUM_BUFFER_S / gp`.

`getOptimalIndex(streams, activeStream, bufferLevel, frontBufferLength)`:
- If `bufferLevel < activeStream.hierarchy.track.maxSegmentDuration`,
  return `null` (abstain — startup).
- Recompute state if `streams` reference or `frontBufferLength`
  changed.
- For each stream `i`, compute
  `score = (V × (vm_i - 1 + gp) - bufferLevel) / streams[i].bandwidth`,
  where `vm_i = log(streams[i].bandwidth) - lnS1 + 1`.
- Return the index of the highest-scoring stream.

Constants stay inline (`MINIMUM_BUFFER_S = 10`).

Manifest objects have stable identity (per project DESIGN principles),
so reference comparison is sufficient for cache invalidation.

## AbrController

Owns all event wiring and all policy. Drivers are pure helpers it owns.

Responsibilities:
- Construct `ThroughputDriver(abrConfig)` and `BolaDriver()`.
- Subscribe to `STREAMS_CREATED` and `NETWORK_RESPONSE`. Forward
  segment responses to `throughput.sample(...)`.
- Run the evaluation timer at `evaluationInterval`.
- Compute `bufferLevel`.
- Track active-driver state (`"throughput" | "bola"`) and update via
  hysteresis.
- Per tick, run the BOLA path or the throughput path (or fall back
  from BOLA → throughput on null) and emit `ADAPTATION` when the pick
  differs.

Public surface (unchanged for consumers):

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;
  getBufferLevel(): number;
  destroy(): void;
}
```

`getThroughputEstimate()` delegates to `throughput.getEstimate(...)`.
`destroy()` stops the timer and unbinds listeners. Drivers have no
listeners and no `destroy()` of their own.

Throughput-pick logic lives in a private controller method (~15 LOC):

```ts
private pickFromThroughput_(streams, activeStream, abr) {
  let bw = this.throughput_.getEstimate(abr.defaultBandwidthEstimate);
  const audio = this.player_.getActiveStream(MediaType.AUDIO);
  if (audio) bw -= audio.bandwidth;

  let best: VideoStream | null = null;
  for (const s of streams) {
    let scaled = bw;
    if (activeStream) {
      const factor = s.bandwidth > activeStream.bandwidth
        ? abr.bandwidthUpgradeTarget
        : abr.bandwidthDowngradeTarget;
      scaled *= factor;
    }
    if (s.bandwidth <= scaled) best = s;
  }
  return best ?? streams[0] ?? null;
}
```

## Config

`AbrConfig` shape unchanged. `droppedFramesThreshold` retained in the
config for now (no consumer in this refactor — restored when dropped
frames returns). All other fields keep their meaning.

## Tests

Tests live in `packages/cmaf-lite/test/abr/`, mirroring `lib/abr/`.

- `throughput_driver.test.ts` — dual-EWMA math, default estimate
  before `minTotalBytes`, `min(fast, slow)` after.
- `bola_driver.test.ts` — abstention below segment-duration buffer
  (returns `null`), correct argmax across buffer levels, lazy state
  recompute on `streams` reference change and on `frontBufferLength`
  change.
- `abr_controller.test.ts` — hysteresis transitions, BOLA-null
  fallback to throughput, throughput-pick logic (audio subtraction,
  upgrade/downgrade asymmetry, lowest-stream floor),
  `NETWORK_RESPONSE → throughput.sample` forwarding, `ADAPTATION`
  emission.

Existing tests under `test/abr/` are migrated; rule-specific tests
collapse into the new tests above.

## Migration

- Delete `lib/abr/ewma.ts`, `lib/abr/ewma_bandwidth_estimator.ts` (code
  moves into `throughput_driver.ts`).
- Replace `lib/abr/abr_controller.ts` with the slim orchestrator.
- Add `lib/abr/throughput_driver.ts`, `lib/abr/bola_driver.ts`.
- Update `docs/abr.md` to describe drivers, not rules. Note dropped
  frames as deferred.
- Update `docs/DESIGN.md` AbrController paragraph (currently mentions
  "four independent rules").

## Risks

- **Sudden network drop with stale slow-EWMA.** Old code's
  InsufficientBuffer rule pulled below Throughput's pick when buffer
  was thin. New code relies on the fast EWMA (3s half-life) to react
  before buffer drains. Mitigation: if real-world traces show
  rebuffering on sudden drops, reintroduce a buffer-safety cap in the
  controller — additive ~15 LOC change, doesn't disturb driver
  internals.
- **BOLA never selected if buffer can't reach `highMark`.** With
  `frontBufferLength = 30` and `highMark = 20`, normal VOD playback
  reaches BOLA quickly. Configurations with tight `frontBufferLength`
  may stay on Throughput throughout — acceptable; Throughput is safe.
- **Dropped-frames regression on capability-limited devices.** Accepted
  for this change; restored in a follow-up.
