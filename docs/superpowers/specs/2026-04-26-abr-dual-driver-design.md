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
 ├── ThroughputEstimator — class. Pure dual-EWMA estimator over a
 │                         sample stream. Inputs: bandwidth samples.
 │                         Output: bits/s estimate or null.
 └── bolaScore()         — pure function. No state. Inputs: streams,
                           buffer level, segment duration, front
                           buffer length. Output: VideoStream or null.
```

ThroughputEstimator is a class because it accumulates samples across
calls (genuine state). BOLA is a pure function because its math is a
snapshot — no history dependence in our simplified impl.

Drivers are **pure logic objects** — testable in isolation, no event
bus, no Player coupling. The controller does all wiring and all policy.

Per evaluation tick, the controller:

1. Reads `bufferLevel`, `streams`, `activeStream`, config.
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA and `activeStream` exists:
   `pick = bolaScore(streams, bufferLevel,
   activeStream.hierarchy.track.maxSegmentDuration, frontBufferLength)`.
4. If `pick` is still unresolved (active driver is Throughput, or BOLA
   abstained, or no active stream yet): run the throughput pick —
   `bandwidth = (throughput.getEstimate() ?? defaultBandwidthEstimate)
   - audioBandwidth`, walk video streams, return highest stream fitting
   `bandwidth × {upgrade,downgrade}Target`, fall back to `streams[0]`.
5. Emits `ADAPTATION` if `pick` differs from `activeStream`.

The controller subscribes to `NETWORK_RESPONSE` and forwards
`(durationSec, byteLength)` to `throughput.sample(...)`.

## File Layout

```
lib/abr/
  abr_controller.ts        — orchestrator, event wiring, hysteresis
  throughput_estimator.ts  — Ewma (file-private) + ThroughputEstimator
  bola_scorer.ts           — bolaScore() pure function
```

Files removed: `ewma.ts`, `ewma_bandwidth_estimator.ts` (their code
moves into `throughput_estimator.ts`).

## Types

```ts
// throughput_estimator.ts (public surface)
export class ThroughputEstimator {
  constructor(config: AbrConfig);
  sample(durationSec: number, bytes: number): void;
  getEstimate(): number | null;       // null while undersampled
}

// bola_scorer.ts (public surface)
export function bolaScore(
  streams: VideoStream[],
  bufferLevel: number,
  maxSegmentDuration: number,
  frontBufferLength: number,
): VideoStream | null;                 // null = abstain (startup)
```

Neither takes the controller. `ThroughputEstimator` receives samples
through `sample()`; `bolaScore` receives all inputs by argument.

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

## Throughput Estimator

Pure dual-EWMA estimator over bandwidth samples. No awareness of
streams, events, or Player.

File: `throughput_estimator.ts` contains:
- `MIN_TOTAL_BYTES = 128_000` — file-private constant. The threshold
  below which `getEstimate()` returns `null` (samples too sparse to
  trust). Was `AbrConfig.minTotalBytes` (removed); now hardcoded.
- `class Ewma` — file-private primitive. Weighted EWMA with bias
  correction. Math unchanged from today's `lib/abr/ewma.ts`.
- `class ThroughputEstimator` — exported. Wraps a fast and a slow
  `Ewma`, samples in bits/s, gates on `MIN_TOTAL_BYTES`.

State:
- `fast_: Ewma` (constructed with `config.fastHalfLife`).
- `slow_: Ewma` (constructed with `config.slowHalfLife`).
- `totalBytes_: number` — running sum of valid sample bytes.

API:
```ts
sample(durationSec: number, bytes: number): void
  // Ignores invalid input (durationSec <= 0 || bytes <= 0).
  // bps = (bytes * 8) / durationSec
  // fast_.sample(durationSec, bps)
  // slow_.sample(durationSec, bps)
  // totalBytes_ += bytes

getEstimate(): number | null
  // null when totalBytes_ < MIN_TOTAL_BYTES (insufficient data).
  // Otherwise: Math.min(fast_.getEstimate(), slow_.getEstimate()).
```

The `defaultBandwidthEstimate` fallback is the caller's responsibility:
`AbrController` does `throughput.getEstimate() ?? defaultBandwidthEstimate`.

Config staleness: `fastHalfLife` and `slowHalfLife` are captured at
construction and not re-read. This matches today's behavior. cmaf-lite
allows `setConfig` at runtime, but EWMA half-lives changing
mid-session is not a supported scenario.

## BOLA Scorer

Mechanically identical to today's `evaluateBola_`, lifted into a pure
function — no class, no state, no caching. Math is a snapshot of
`(streams, bufferLevel, maxSegmentDuration, frontBufferLength)`.

File: `bola_scorer.ts` contains:
- `MINIMUM_BUFFER_S = 10` — file-private constant.
- `bolaScore(...)` — exported pure function.

Algorithm (all derived params recomputed each call — cheap, ABR ticks
at multi-second cadence):

```ts
export function bolaScore(streams, bufferLevel, maxSegmentDuration, frontBufferLength): VideoStream | null {
  if (bufferLevel < maxSegmentDuration) return null;        // startup abstain
  const lowest = streams[0];
  const highest = streams[streams.length - 1];
  if (!lowest || !highest) return null;

  const lnS1 = Math.log(lowest.bandwidth);
  const vM   = Math.log(highest.bandwidth) - lnS1 + 1;
  const Qmax = Math.max(frontBufferLength, MINIMUM_BUFFER_S + 2 * streams.length);
  const gp   = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1);
  const V    = MINIMUM_BUFFER_S / gp;

  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < streams.length; i++) {
    const vm = Math.log(streams[i].bandwidth) - lnS1 + 1;
    const score = (V * (vm - 1 + gp) - bufferLevel) / streams[i].bandwidth;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return streams[bestIndex];
}
```

Why no state? Three reasons we'd want state — none apply:
- **Placeholder buffer** (deferred per Non-goals).
- **Last-segment metadata** (only feeds placeholder buffer).
- **Startup vs steady mode** — externalized to controller's hysteresis.

If we add placeholder buffer or BOLA-O anti-oscillation later, the
function gets promoted to a class. YAGNI now.

## AbrController

Owns all event wiring and all policy. Drivers are pure helpers it owns.

Responsibilities:
- Construct `ThroughputEstimator(abrConfig)`. (No BOLA object — call
  `bolaScore(...)` as a function.)
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

Throughput-pick logic lives in a private controller method:

```ts
private pickFromThroughput_(streams, activeStream, abr) {
  let bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
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

`AbrConfig` changes:
- **Removed:** `minTotalBytes` — moved into `throughput_estimator.ts`
  as a hardcoded `MIN_TOTAL_BYTES = 128_000`. Same gating behavior as
  today; just no longer user-configurable. `getEstimate()` returns
  `null` while undersampled.
- **Retained but unused in this refactor:** `droppedFramesThreshold` —
  restored when dropped-frames handling returns in a follow-up.

Other fields keep their meaning. `defaultBandwidthEstimate` is applied
in `AbrController` (`throughput.getEstimate() ?? default`) rather than
passed into the estimator.

Update sites: `lib/config.ts` (interface + `DEFAULT_CONFIG`),
`docs/abr.md`, any reference docs that mention `minTotalBytes`.

## Tests

Tests live in `packages/cmaf-lite/test/abr/`, mirroring `lib/abr/`.

- `throughput_estimator.test.ts` — dual-EWMA math, `getEstimate()`
  returns `null` while `totalBytes_ < MIN_TOTAL_BYTES`, `min(fast,
  slow)` once over the threshold, invalid samples are ignored.
- `bola_scorer.test.ts` — abstention below segment-duration buffer
  (returns `null`), correct argmax across buffer levels, monotonic
  preference shift toward higher streams as buffer grows.
- `abr_controller.test.ts` — hysteresis transitions, BOLA-null
  fallback to throughput, throughput-pick logic (audio subtraction,
  upgrade/downgrade asymmetry, lowest-stream floor),
  `NETWORK_RESPONSE → throughput.sample` forwarding, `ADAPTATION`
  emission.

Existing tests under `test/abr/` are migrated; rule-specific tests
collapse into the new tests above.

## Migration

- Delete `lib/abr/ewma.ts`, `lib/abr/ewma_bandwidth_estimator.ts` (code
  moves into `throughput_estimator.ts`).
- Replace `lib/abr/abr_controller.ts` with the slim orchestrator.
- Add `lib/abr/throughput_estimator.ts`, `lib/abr/bola_scorer.ts`.
- Remove `minTotalBytes` from `AbrConfig` and `DEFAULT_CONFIG` in
  `lib/config.ts`.
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
