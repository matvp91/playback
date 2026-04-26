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
- Abandon-fragment rule — NetworkService has no in-flight progress
  events; deferred.
- BOLA placeholder buffer — already noted as deferred in `docs/abr.md`.
- Multi-period state, manual-switch queueing, L2A/LoL+ — out of scope.
- Renaming `Stream`/`VideoStream` to `Representation` — cmaf-lite keeps
  its neutral model.

## Architecture

```
AbrController (orchestrator)
 ├── ThroughputDriver  — Ewma + EwmaBandwidthEstimator + decision logic
 └── BolaDriver        — BOLA-O state and decision logic
```

Per evaluation tick, the controller:

1. Reads `bufferLevel` from the player.
2. Updates the active driver via hysteresis (see Driver Selection).
3. Calls `activeDriver.evaluate({ streams, activeStream, bufferLevel })`.
4. Emits `ADAPTATION` if the returned stream differs from the active one.

Throughput samples flow into `ThroughputDriver` from `NETWORK_RESPONSE`
events. The controller forwards segment responses to it.

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

Drivers return `VideoStream | null` directly. `null` means "no change"
/ "abstain". With one driver active per tick there is no reconciliation
to do, so a `SwitchRequest` wrapper would only carry a debug `reason`
string — not worth the type. Drivers can `Log.debug` their reasoning
inline.

```ts
// throughput_driver.ts (public surface)
export class ThroughputDriver {
  constructor(config: AbrConfig);
  sample(durationSeconds: number, bytes: number): void;
  getEstimate(defaultEstimate: number): number;
  evaluate(input: DriverInput): VideoStream | null;
}

// bola_driver.ts (public surface)
export class BolaDriver {
  constructor(config: PlayerConfig);
  evaluate(input: DriverInput): VideoStream | null;
}

type DriverInput = {
  streams: VideoStream[];
  activeStream: VideoStream | null;
  bufferLevel: number;
};
```

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

Combines today's `EwmaBandwidthEstimator`, `Ewma`, the existing
Throughput rule, and the InsufficientBuffer rule into one module:

- **Estimator** — dual EWMA (`fastHalfLife`, `slowHalfLife`), `min(fast,
  slow)` — unchanged math.
- **Steady-state decision** (`bufferLevel >= maxSegmentDuration`):
  highest stream `≤ estimate × factor`, with asymmetric upgrade
  (`bandwidthUpgradeTarget`) / downgrade (`bandwidthDowngradeTarget`).
  Subtract active audio bandwidth before comparing — same as today.
- **Low-buffer decision** (`bufferLevel < maxSegmentDuration`): use the
  proportional formula `estimate × 0.7 × (bufferLevel / segDuration)`
  (absorbed from the old InsufficientBuffer rule). When no active
  stream yet, fall back to the steady-state formula so the very first
  selection still works.
- Returns `streams[0]` as a floor when no stream fits.

## BOLA Driver

Mechanically identical to the current `evaluateBola_`. Only structural
changes:

- Lifted into its own class with `evaluate(input)`.
- State held on the instance (`gp`, `Vp`, `vM`, lowest/highest stream
  refs) — recomputed lazily when stream set changes via reference
  identity. Manifest objects have stable identity (per project DESIGN
  principles), so a `streams` reference check is sufficient.
- Abstains when `bufferLevel < activeTrack.maxSegmentDuration`. Startup
  is now handled by the controller — when BOLA abstains or isn't the
  active driver, Throughput drives.

Constants stay inline (`MINIMUM_BUFFER_S = 10`).

## AbrController

Reduced responsibilities:

- Wire events: `STREAMS_CREATED`, `NETWORK_RESPONSE`.
- Run evaluation timer at `evaluationInterval`.
- Compute `bufferLevel` (logic identical to today).
- Update active driver based on hysteresis.
- Forward segment-response samples to `ThroughputDriver`.
- Emit `ADAPTATION` when the active driver returns a different stream.

Public surface unchanged:

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;
  getBufferLevel(): number;
  destroy(): void;
}
```

`getThroughputEstimate()` delegates to `ThroughputDriver.getEstimate()`.

## Config

`AbrConfig` shape unchanged. `droppedFramesThreshold` retained in the
config for now (no consumer in this refactor — restored when dropped
frames returns). All other fields keep their meaning.

## Tests

Tests live in `packages/cmaf-lite/test/abr/`, mirroring `lib/abr/`.

- `throughput_driver.test.ts` — estimator math, steady-state selection,
  low-buffer proportional formula, audio bandwidth subtraction.
- `bola_driver.test.ts` — abstention below threshold, score selection
  across buffer levels, scoring monotonicity.
- `abr_controller.test.ts` — hysteresis transitions, driver selection
  with synthetic buffer levels, `ADAPTATION` emission, sample
  forwarding from `NETWORK_RESPONSE`.

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

- **Behavior drift on low-buffer recovery.** Old code ran all rules and
  took min, so InsufficientBuffer could pull below Throughput's pick.
  New code uses one driver. Mitigation: low-buffer mode inside
  ThroughputDriver applies the same proportional formula, producing the
  same result in that regime.
- **BOLA never selected if buffer can't reach `highMark`.** With
  `frontBufferLength = 30` and `highMark = 20`, normal VOD playback
  reaches BOLA quickly. Configurations with tight `frontBufferLength`
  may stay on Throughput throughout — acceptable; Throughput is safe.
- **Dropped-frames regression on capability-limited devices.** Accepted
  for this change; restored in a follow-up.
