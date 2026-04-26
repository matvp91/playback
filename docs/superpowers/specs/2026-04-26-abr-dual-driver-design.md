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
AbrController (Player access, streams, buffer, hysteresis, picking)
 ├── ThroughputEstimator — class. Only computes bandwidth from
 │                         samples. No streams, no Player.
 └── BolaScorer          — class. Stateless math. Takes inputs by
                           argument, returns a recommended stream.
                           No Player.
```

The split:

- **`ThroughputEstimator`** — narrowest possible: a dual-EWMA over
  `(durationSec, bytes)` samples. Owns sampling state. Nothing else.
- **`BolaScorer`** — pure BOLA math packaged as a class. Recomputes
  derived params each call. The class shape is forward-compatible:
  if we later add placeholder buffer / BOLA-O, state lives here.
- **`AbrController`** — owns the `Player`, streams access, buffer
  level computation, the hysteresis switch, the throughput-pick
  algorithm (audio-free; just bandwidth + factors), and the BOLA
  dispatch. It feeds samples to the estimator and inputs to the
  scorer.

The "is BOLA representable" gate (dash.js's `BOLA_STATE_STARTUP`) is
**lifted out of BOLA into the controller's buffer hysteresis** — same
logic, expressed at a different layer.

**Scope: video-only.** `AbrController` consumes
`player.getStreams(MediaType.VIDEO)` only. Audio is not consulted —
not subtracted from the throughput budget, not switched. Multi-bitrate
audio ABR would be a separate per-type controller; out of scope here.

Drivers are **pure logic objects** — testable in isolation, no event
bus, no Player coupling. The controller does all wiring and all policy.

Per evaluation tick, the controller:

1. Reads `streams`, `activeStream`, `bufferLevel`, config.
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA and `activeStream` exists:
   `pick = bola.getRecommendedStream(streams, bufferLevel,
   activeStream.hierarchy.track.maxSegmentDuration, frontBufferLength)`.
4. If `pick` is `null` (BOLA abstained or active driver is Throughput):
   run the controller's `pickFromThroughput_(...)` — `bw =
   throughput.getEstimate() ?? defaultBandwidthEstimate`, walk video
   streams, return highest fitting `bw × factor`, fall back to
   `streams[0]`.
5. Emits `ADAPTATION` if `pick` differs from `activeStream`.

The controller subscribes to `STREAMS_CREATED` (kicks off the eval
timer) and `NETWORK_RESPONSE` (forwards segment responses to
`throughput.sample(...)`).

## File Layout

```
lib/abr/
  abr_controller.ts        — controller: events, hysteresis, picking
  throughput_estimator.ts  — Ewma (file-private) + ThroughputEstimator
  bola_scorer.ts           — BolaScorer
```

Files removed: `ewma.ts`, `ewma_bandwidth_estimator.ts` (their code
moves into `throughput_estimator.ts`).

## Types

```ts
// throughput_estimator.ts (public surface)
export class ThroughputEstimator {
  constructor(config: AbrConfig);
  sample(durationSec: number, bytes: number): void;
  getEstimate(): number | null;            // null while undersampled
}

// bola_scorer.ts (public surface)
export class BolaScorer {
  // Stateless today. Class shape reserved for placeholder buffer /
  // BOLA-O state if we restore those later.
  getRecommendedStream(
    streams: VideoStream[],
    bufferLevel: number,
    maxSegmentDuration: number,
    frontBufferLength: number,
  ): VideoStream | null;                   // null = abstain (startup)
}
```

Neither takes the `Player`. `ThroughputEstimator` is fed via `sample()`
from the controller's `NETWORK_RESPONSE` handler. `BolaScorer`
receives all inputs by argument — the controller pulls them from the
player and passes them through.

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

Pure dual-EWMA estimator. No streams, no Player, no events. Sampled
from outside via `sample()`.

File: `throughput_estimator.ts` contains:
- `MIN_TOTAL_BYTES = 128_000` — file-private constant. Below this,
  `getEstimate()` returns `null`. Was `AbrConfig.minTotalBytes`
  (removed); now hardcoded.
- `class Ewma` — file-private primitive. Weighted EWMA with bias
  correction. Math unchanged from today's `lib/abr/ewma.ts`.
- `class ThroughputEstimator` — exported.

### State
- `fast_: Ewma` (`config.fastHalfLife`).
- `slow_: Ewma` (`config.slowHalfLife`).
- `totalBytes_: number` — running sum of valid sample bytes.

### API

```ts
sample(durationSec: number, bytes: number): void
  // Ignores invalid input (durationSec <= 0 || bytes <= 0).
  // bps = (bytes * 8) / durationSec
  // fast_.sample(durationSec, bps); slow_.sample(durationSec, bps)
  // totalBytes_ += bytes

getEstimate(): number | null
  // null when totalBytes_ < MIN_TOTAL_BYTES.
  // Otherwise: Math.min(fast_.getEstimate(), slow_.getEstimate()).
```

Config staleness: `fastHalfLife` and `slowHalfLife` are captured at
construction. EWMA half-lives changing mid-session is not supported.

## BOLA Scorer

Pure BOLA math packaged as a class. No Player, no events, no listeners.
Stateless today — derived params recomputed each call (cheap; ABR ticks
at multi-second cadence).

File: `bola_scorer.ts` contains:
- `MINIMUM_BUFFER_S = 10` — file-private constant.
- `class BolaScorer` — exported.

### State
None today. Class shape reserved for placeholder buffer / BOLA-O
state if we restore those later.

### API

```ts
getRecommendedStream(
  streams: VideoStream[],
  bufferLevel: number,
  maxSegmentDuration: number,
  frontBufferLength: number,
): VideoStream | null
  // If bufferLevel < maxSegmentDuration → null (startup abstain).
  // Compute: lnS1 = log(streams[0].bandwidth)
  //          vM   = log(streams[last].bandwidth) - lnS1 + 1
  //          Qmax = max(frontBufferLength, MINIMUM_BUFFER_S + 2*streams.length)
  //          gp   = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1)
  //          V    = MINIMUM_BUFFER_S / gp
  // Return streams[argmax_i (V*(vm_i - 1 + gp) - bufferLevel) / streams[i].bandwidth]
  //   where vm_i = log(streams[i].bandwidth) - lnS1 + 1.
```

### Why a class with no state?

dash.js's `bolaState` exists for four concerns; analyzing each:

1. **Representability gate** (`STARTUP`/`STEADY` enum). dash.js bypasses
   BOLA's math when buffer is too low. **We externalize this** via the
   controller's buffer hysteresis: `bufferLevel < lowMark → throughput`.
   On seek, real buffer drains, hysteresis routes to throughput
   automatically. No internal state needed.

2. **Placeholder buffer** (virtual buffer with decay). Deferred per
   Non-goals.

3. **BOLA-O anti-oscillation** (tracks `currentRepresentation`).
   Not implemented; the simpler BOLA scoring is fine for VOD.

4. **Multi-period plumbing** (`bolaStateDict[streamId][mediaType]`).
   Out of scope; we're single-period, video-only.

So today the class holds no state. Class shape chosen for
**forward-compatibility**: if we later restore placeholder buffer or
BOLA-O, state lives inside `BolaScorer` without changing how the
controller calls it.

## AbrController

Owns the `Player`, all event wiring, and all policy. The estimator
and scorer are pure helpers it constructs and feeds.

Responsibilities:
- Construct `ThroughputEstimator(abrConfig)` and `BolaScorer()`.
- Subscribe to `STREAMS_CREATED` (kicks off eval timer) and
  `NETWORK_RESPONSE` (forwards segment responses to
  `throughput.sample(...)`).
- Run the evaluation timer at `evaluationInterval`.
- Compute `bufferLevel`.
- Track active-driver state (`"throughput" | "bola"`) and update via
  hysteresis.
- Per tick, dispatch to BOLA or throughput pick (with BOLA-null
  fallback to throughput) and emit `ADAPTATION` when the pick differs
  from the active stream.

Public surface (unchanged for consumers):

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;
  getBufferLevel(): number;
  destroy(): void;
}
```

`getThroughputEstimate()` delegates: `throughput.getEstimate() ??
config.abr.defaultBandwidthEstimate`. `destroy()` stops the timer and
unbinds listeners.

Throughput-pick logic lives in a private controller method:

```ts
private pickFromThroughput_(streams, activeStream, abr) {
  const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

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

(No audio-bandwidth subtraction — see Architecture: video-only.)

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
  fallback to throughput, throughput-pick logic (upgrade/downgrade
  asymmetry, lowest-stream floor, no audio subtraction),
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
