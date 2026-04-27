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
- Dual EWMA throughput estimation isolated in `ThroughputEstimator`.
- BOLA math unchanged in formula, isolated in `bolaScore()`.
- Public `AbrController` API roughly unchanged (one rename:
  `getBufferLevel()` → `getFrontBuffer()`).
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
 └── bolaScore()         — exported function. Pure BOLA math. No
                           state, no Player.
```

The split:

- **`ThroughputEstimator`** — narrowest possible: a dual-EWMA over
  `(durationSec, bytes)` samples. Owns sampling state. Class because
  it has cross-call state worth encapsulating.
- **`bolaScore()`** — pure BOLA math as an exported function (~30
  LOC). Stateless. If we later restore placeholder buffer or BOLA-O,
  this gets promoted to a class with state at that point.
- **`AbrController`** — owns the `Player`, streams access, front
  buffer computation, the hysteresis switch, the throughput-pick
  algorithm (audio-free; just bandwidth + factors), and the BOLA
  dispatch. It feeds samples to the estimator and arguments to
  `bolaScore`.

The "is BOLA representable" gate (dash.js's `BOLA_STATE_STARTUP`) is
**handled by the controller's buffer hysteresis** — `frontBuffer <
lowMark → throughput`. On seek, real buffer drains, hysteresis routes
to throughput automatically. Same logic as dash.js's startup mode,
expressed at the controller layer.

**Scope: video-only.** `AbrController` consumes
`player.getStreams(MediaType.VIDEO)` only. Audio is not consulted —
not subtracted from the throughput budget, not switched. Multi-bitrate
audio ABR would be a separate per-type controller; out of scope here.

Both `ThroughputEstimator` and `bolaScore()` are **pure logic** —
testable in isolation, no event bus, no Player coupling. The
controller does all wiring and all policy.

Per evaluation tick, the controller:

1. Reads `streams`, `activeStream`, front buffer (via
   `getFrontBuffer()`), config.
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA and `activeStream` exists:
   `pick = bolaScore(streams, frontBuffer,
   activeStream.hierarchy.track.maxSegmentDuration, frontBufferLength)`.
4. If `pick` is `null` (BOLA abstained or active driver is Throughput):
   run the controller's `pickFromThroughput_(...)` —
   `bw = throughput.getEstimate() ?? abr.defaultBandwidthEstimate`,
   walk video streams, return highest fitting `bw × factor`, fall back
   to `streams[0]`.
5. Emits `ADAPTATION` if `pick` differs from `activeStream`.

The controller subscribes only to `NETWORK_RESPONSE` (forwards
segment responses to `throughput.sample(...)`). The evaluation timer
starts in the constructor; `evaluate_` no-ops when
`player.getStreams(MediaType.VIDEO)` returns an empty list (i.e.
manifest not yet loaded).

## File Layout

```
lib/abr/
  abr_controller.ts        — controller: events, hysteresis, picking
  throughput_estimator.ts  — Ewma (file-private) + ThroughputEstimator
  bola_scorer.ts           — bolaScore() function
```

Files removed: `ewma.ts`, `ewma_bandwidth_estimator.ts` (their code
moves into `throughput_estimator.ts`).

## Types

```ts
// throughput_estimator.ts (public surface)
export class ThroughputEstimator {
  constructor(config: AbrConfig);
  sample(durationSec: number, bytes: number): void;
  getEstimate(): number | null;            // null while totalBytes_ < config.minTotalBytes
}

// bola_scorer.ts (public surface)
export function bolaScore(
  streams: VideoStream[],
  frontBuffer: number,
  maxSegmentDuration: number,
  frontBufferLength: number,
): VideoStream | null;                     // null = abstain (startup)
```

Neither takes the `Player`. `ThroughputEstimator` is fed via `sample()`
from the controller's `NETWORK_RESPONSE` handler. `bolaScore` receives
all inputs by argument — the controller pulls them from the player
and passes them through.

## Driver Selection

Hysteresis around buffer level prevents flapping between drivers:

```
lowMark  = MINIMUM_BUFFER_S          // 10s — BOLA's own minimum
highMark = MINIMUM_BUFFER_S * 2      // 20s

frontBuffer < lowMark   → Throughput
frontBuffer > highMark  → BOLA
otherwise               → keep current driver
```

Initial driver is `Throughput` (buffer is 0 at startup). The controller
stores the current driver as a private field.

## Throughput Estimator

Pure dual-EWMA estimator. No streams, no Player, no events. Sampled
from outside via `sample()`. Captures the `AbrConfig` at construction
to know its EWMA half-lives and reliability threshold.

File: `throughput_estimator.ts` contains:
- `class Ewma` — file-private primitive. Weighted EWMA with bias
  correction. Math unchanged from today's `lib/abr/ewma.ts`.
- `class ThroughputEstimator` — exported.

### State
- `fast_: Ewma` (`config.fastHalfLife`).
- `slow_: Ewma` (`config.slowHalfLife`).
- `totalBytes_: number` — running sum of valid sample bytes.
- `config_: AbrConfig` — captured for `minTotalBytes` lookup.

### API

```ts
sample(durationSec: number, bytes: number): void
  // Ignores invalid input (durationSec <= 0 || bytes <= 0).
  // bps = (bytes * 8) / durationSec
  // fast_.sample(durationSec, bps); slow_.sample(durationSec, bps)
  // totalBytes_ += bytes

getEstimate(): number | null
  // Returns null when totalBytes_ < config_.minTotalBytes (estimate
  // not yet trustworthy). Otherwise: Math.min(fast_.getEstimate(),
  // slow_.getEstimate()).
```

Config staleness: `fastHalfLife` and `slowHalfLife` are captured at
construction. `minTotalBytes` is read fresh on each `getEstimate()`
call via `config_.minTotalBytes`, so runtime config updates take
effect. EWMA half-lives changing mid-session is not supported.

## BOLA Scorer

Pure BOLA math as an exported function. No Player, no events, no
listeners, no state. Derived params recomputed each call (cheap; ABR
ticks at multi-second cadence).

File: `bola_scorer.ts` contains:
- `MINIMUM_BUFFER_S = 10` — file-private constant.
- `bolaScore(...)` — exported function.

### Algorithm

```ts
export function bolaScore(
  streams: VideoStream[],
  frontBuffer: number,
  maxSegmentDuration: number,
  frontBufferLength: number,
): VideoStream | null
  // If frontBuffer < maxSegmentDuration → null (startup abstain).
  // Compute: lnS1 = log(streams[0].bandwidth)
  //          vM   = log(streams[last].bandwidth) - lnS1 + 1
  //          Qmax = max(frontBufferLength, MINIMUM_BUFFER_S + 2*streams.length)
  //          gp   = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1)
  //          V    = MINIMUM_BUFFER_S / gp
  // Return streams[argmax_i (V*(vm_i - 1 + gp) - frontBuffer) / streams[i].bandwidth]
  //   where vm_i = log(streams[i].bandwidth) - lnS1 + 1.
```

### Why a function (not a class)?

In our simplified impl, BOLA is genuinely stateless. dash.js's
`bolaState` exists for four concerns; we don't keep any of them:

1. **Representability gate** (`STARTUP`/`STEADY` enum). dash.js bypasses
   BOLA's math when buffer is too low. **We externalize this** via the
   controller's buffer hysteresis: `frontBuffer < lowMark → throughput`.
   On seek, real buffer drains, hysteresis routes to throughput
   automatically. No internal state needed.

2. **Placeholder buffer** (virtual buffer with decay). Deferred per
   Non-goals.

3. **BOLA-O anti-oscillation** (tracks `currentRepresentation`).
   Not implemented; the simpler BOLA scoring is fine for VOD.

4. **Multi-period plumbing** (`bolaStateDict[streamId][mediaType]`).
   Out of scope; we're single-period, video-only.

If we later restore (1)–(3), `bolaScore` gets promoted to a class with
state at that point. YAGNI now — a function is the honest shape for
stateless math.

## AbrController

Owns the `Player`, all event wiring, and all policy. The estimator
and scorer are pure helpers it constructs and feeds.

Responsibilities:
- Construct `ThroughputEstimator(abrConfig)`.
- Subscribe to `NETWORK_RESPONSE` (forwards segment responses to
  `throughput.sample(...)`).
- Start the evaluation timer at `evaluationInterval` immediately.
- `evaluate_` no-ops when `player.getStreams(MediaType.VIDEO)` is
  empty (manifest not yet loaded).
- Compute front buffer (`getFrontBuffer()`).
- Track active-driver state (`"throughput" | "bola"`) and update via
  hysteresis.
- Per tick, dispatch to `bolaScore(...)` or the throughput pick (with
  BOLA-null fallback to throughput) and emit `ADAPTATION` when the
  pick differs from the active stream.

Public surface (unchanged in shape; `getBufferLevel` renamed):

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;
  getFrontBuffer(): number;             // renamed from getBufferLevel()
  destroy(): void;
}
```

`getThroughputEstimate()` returns
`throughput.getEstimate() ?? config.abr.defaultBandwidthEstimate`.

`getFrontBuffer()` (rename of today's `getBufferLevel`): returns the
seconds of video buffered ahead of the current playback position.
Implementation unchanged — uses `getBufferedEnd(buffered, currentTime,
maxBufferHole)` over `player.getBuffered(MediaType.VIDEO)`. Returns
`0` when there's no media element or no continuous range.

`destroy()` stops the timer and unbinds the `NETWORK_RESPONSE`
listener.

### Throughput-pick logic

Lives in a private controller method:

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
- **Retained but unused in this refactor:** `droppedFramesThreshold` —
  restored when dropped-frames handling returns in a follow-up.

All other fields keep their meaning, including `minTotalBytes` (the
estimator reads it on each `getEstimate()` call to decide whether to
return a number or `null`) and `defaultBandwidthEstimate` (the
controller applies it on null via `?? defaultBandwidthEstimate`).

Update sites: `docs/abr.md` (rule-based prose → driver-based prose).

## Tests

Tests live in `packages/cmaf-lite/test/abr/`, mirroring `lib/abr/`.

- `throughput_estimator.test.ts` — dual-EWMA math, `getEstimate()`
  returns `null` while `totalBytes_ < config.minTotalBytes`, returns
  `min(fast, slow)` once over the threshold, invalid samples are
  ignored.
- `bola_scorer.test.ts` — abstention below segment-duration buffer
  (returns `null`), correct argmax across buffer levels, monotonic
  preference shift toward higher streams as buffer grows.
- `abr_controller.test.ts` — hysteresis transitions, BOLA-null
  fallback to throughput, throughput-pick logic (default-fallback
  on `getEstimate() === null`, upgrade/downgrade asymmetry,
  lowest-stream floor, no audio subtraction), `NETWORK_RESPONSE →
  throughput.sample` forwarding, `ADAPTATION` emission.

Existing tests under `test/abr/` are migrated; rule-specific tests
collapse into the new tests above.

## Migration

- Delete `lib/abr/ewma.ts`, `lib/abr/ewma_bandwidth_estimator.ts` (code
  moves into `throughput_estimator.ts`).
- Replace `lib/abr/abr_controller.ts` with the slim orchestrator.
- Add `lib/abr/throughput_estimator.ts`, `lib/abr/bola_scorer.ts`.
- `AbrConfig` retains `minTotalBytes` (used internally by the
  estimator's null-gating logic).
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
