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
AbrController (orchestrator)
 ├── ThroughputDriver  — owns Ewma + EwmaBandwidthEstimator state,
 │                       listens to NETWORK_RESPONSE, picks a stream
 │                       from its estimate
 └── BolaDriver        — owns BOLA-O state, picks a stream from its
                         scoring math (or returns null during startup)
```

Each driver is **autonomous**:

- Constructed with the `AbrController` so it can read player state and
  bind its own listeners.
- Holds its own state (EWMA estimator / BOLA Vp/gp/utilities).
- Subscribes to its own events.
- Exposes `getStream(): VideoStream | null` — the recommendation.
- Provides `destroy()` to unbind listeners.

Per evaluation tick, the controller:

1. Reads `bufferLevel`.
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA: `pick = bola.getStream()`. If `null`,
   fall back to `throughput.getStream()`.
4. If active driver is Throughput: `pick = throughput.getStream()`.
5. Emits `ADAPTATION` if `pick` differs from the active stream.

The controller no longer wires `NETWORK_RESPONSE` — `ThroughputDriver`
listens directly.

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

Drivers return `VideoStream | null` directly. `null` from BOLA signals
"abstain" — controller falls back to throughput. ThroughputDriver
returns `null` only when the stream list is empty.

```ts
// throughput_driver.ts (public surface)
export class ThroughputDriver {
  constructor(controller: AbrController);
  getStream(): VideoStream | null;          // current recommendation
  getEstimate(defaultEstimate: number): number;  // for AbrController.getThroughputEstimate()
  destroy(): void;
}

// bola_driver.ts (public surface)
export class BolaDriver {
  constructor(controller: AbrController);
  getStream(): VideoStream | null;          // null = abstain (startup)
  destroy(): void;
}
```

Drivers reach into the controller for shared state (streams, active
stream, buffer level, config, player event bus). The controller exposes
internal accessors used only by drivers — see AbrController section.

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

Combines today's `EwmaBandwidthEstimator`, `Ewma`, and the existing
Throughput rule into one self-contained module.

State:
- `Ewma` (fast and slow), wrapped in `EwmaBandwidthEstimator` —
  unchanged math, internal classes.
- Total bytes counter (gates switching to the EWMA estimate).

Listeners:
- `Events.NETWORK_RESPONSE` — segment responses feed
  `EwmaBandwidthEstimator.sample(durationSec, byteLength)`. Bound in
  the constructor, unbound in `destroy()`.

`getStream()` logic — runs on demand each tick:
- `bandwidth = getEstimate(defaultBandwidthEstimate)` minus active
  audio stream bandwidth.
- Walk video streams, track best stream where
  `stream.bandwidth ≤ bandwidth × factor`. `factor` is
  `bandwidthUpgradeTarget` when stream is above active, else
  `bandwidthDowngradeTarget`. When no active stream, no factor.
- Fall back to `streams[0]` if none fit.

`getEstimate(defaultEstimate)` exposes the raw bandwidth number for the
controller's public `getThroughputEstimate()`.

## BOLA Driver

Mechanically identical to today's `evaluateBola_`, repackaged.

State (lazy, recomputed when `streams` reference changes):
- `lnS1` (log of lowest bandwidth), `vM` (utility ceiling), `gp`, `V`,
  `Qmax` — derived from stream set + `frontBufferLength`.
- Cached `streams` reference for staleness detection.

Listeners: none. Manifest objects have stable identity (per project
DESIGN principles), so reference comparison inside `getStream()` is
sufficient to detect stream-set changes.

`getStream()` logic:
- Read `streams`, `activeStream`, `bufferLevel` via the controller.
- If no `activeStream`, or `bufferLevel < activeTrack.maxSegmentDuration`,
  return `null` (abstain — controller falls back to throughput).
- Recompute state if `streams` reference changed.
- Score each stream: `(V × (vm - 1 + gp) - bufferLevel) / stream.bandwidth`.
- Return `streams[argmax(score)]`.

Constants stay inline (`MINIMUM_BUFFER_S = 10`).

## AbrController

Responsibilities:
- Construct and own the two drivers.
- Run the evaluation timer at `evaluationInterval`.
- Compute `bufferLevel`.
- Track active-driver state and update via hysteresis.
- Call `bola.getStream()` (with throughput fallback on `null`) or
  `throughput.getStream()` based on the active driver.
- Emit `ADAPTATION` when the pick differs from the active stream.

Public surface (unchanged for consumers):

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;
  getBufferLevel(): number;
  destroy(): void;
}
```

Internal accessors (used by drivers — colocated, intra-package):

```ts
class AbrController {
  // intra-package — stable shape used by drivers
  getPlayer(): Player;
  getStreams(): VideoStream[];
  getActiveVideoStream(): VideoStream | null;
  getActiveAudioStream(): Stream | null;
  getConfig(): PlayerConfig;
}
```

`getThroughputEstimate()` delegates to `ThroughputDriver.getEstimate()`.
`destroy()` calls `destroy()` on both drivers, stops the timer, and
unbinds the controller's own listeners.

## Config

`AbrConfig` shape unchanged. `droppedFramesThreshold` retained in the
config for now (no consumer in this refactor — restored when dropped
frames returns). All other fields keep their meaning.

## Tests

Tests live in `packages/cmaf-lite/test/abr/`, mirroring `lib/abr/`.

- `throughput_driver.test.ts` — estimator math, sample ingestion via
  `NETWORK_RESPONSE`, stream selection with upgrade/downgrade asymmetry,
  audio bandwidth subtraction, fallback to lowest stream when none fit.
- `bola_driver.test.ts` — abstention below threshold (returns `null`),
  score selection across buffer levels, lazy state recompute on stream
  reference change.
- `abr_controller.test.ts` — hysteresis transitions, BOLA-null
  fallback to throughput, `ADAPTATION` emission, driver lifecycle on
  `destroy()`.

Existing tests under `test/abr/` are migrated; rule-specific tests
collapse into driver tests.

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
