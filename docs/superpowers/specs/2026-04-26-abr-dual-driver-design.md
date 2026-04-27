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
- BOLA math unchanged in formula, isolated in `BolaScorer`.
- `AbrController` is not exported from `index.ts` and has no external
  consumers besides `Player.destroy()`. The class's surface is
  **internal** — methods exist for `Player` lifecycle and for
  `BolaScorer` to read state. Drop `getThroughputEstimate()` (no
  callers); rename `getBufferLevel()` → `getFrontBuffer()`; add
  narrow accessors for `BolaScorer` (`getStreams`, `getActiveStream`,
  `getFrontBuffer`, `getFrontBufferLength`).
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
AbrController (Player + all event hooks + hysteresis + picking)
 ├── ThroughputEstimator — class. Bandwidth-only. No Player.
 │                         Fed via sample() from controller's
 │                         NETWORK_RESPONSE handler.
 └── BolaScorer          — class. BOLA math + startup/steady state.
                           Takes AbrController for state lookup
                           callbacks. Controller calls onSeeking() on
                           media seek; controller calls
                           getRecommendedStream() per tick.
```

The split:

- **`ThroughputEstimator`** — narrowest possible: a dual-EWMA over
  `(durationSec, bytes)` samples. Owns sampling state.
- **`BolaScorer`** — BOLA math + an explicit trust state machine.
  Standalone (no Player binding). Receives the `AbrController` at
  construction so it can pull streams / active stream / front buffer /
  config when computing a recommendation. Exposes `onSeeking()` for
  the controller to drive the state reset.
- **`AbrController`** — single owner of all event wiring. Hooks
  `NETWORK_RESPONSE` (→ `throughput.sample`), `MEDIA_ATTACHED` /
  `MEDIA_ATTACHING` (→ bind/unbind `seeking` on media), media
  `seeking` (→ `bola.onSeeking()`). Owns the timer, hysteresis, the
  throughput-pick algorithm, and BOLA dispatch. Exposes narrow
  accessors (`getStreams`, `getActiveStream`, `getFrontBuffer`,
  `getFrontBufferLength`) for `BolaScorer`. The class is not
  exported from `index.ts`.

**Two-layer "is BOLA representable" gate** (matches dash.js):

1. **Buffer hysteresis** in the controller — handles low-buffer
   regime (network slowdown, gradual). Routes between throughput and
   BOLA based on front buffer level.
2. **BOLA state machine** inside `BolaScorer` — handles seek
   (transient, event-driven; can preserve high buffer level when
   seeking inside a buffered range). Resets on `seeking`, transitions
   to steady when buffer reaches at least one segment duration.

Buffer alone isn't sufficient: a seek inside an already-buffered
range preserves the buffer level, but BOLA's prior trajectory
(EWMA-derived expectations of bitrate-vs-buffer) doesn't reflect the
new playback position. The state machine catches that case.

**Scope: video-only.** `AbrController` consumes
`player.getStreams(MediaType.VIDEO)` only. Audio is not consulted —
not subtracted from the throughput budget, not switched. Multi-bitrate
audio ABR would be a separate per-type controller; out of scope here.

Neither helper binds to `Player`. `ThroughputEstimator` is pure math
(testable as a standalone). `BolaScorer` carries state but is
controller-driven — testable with a stub `AbrController`. The
controller does all event wiring.

Per evaluation tick, the controller:

1. Reads `streams`, `activeStream`, front buffer (via
   `getFrontBuffer()`).
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA: `pick = bola.getRecommendedStream()`.
   `BolaScorer` pulls all the state it needs from the controller.
4. If `pick` is `null` (BOLA abstained or active driver is Throughput):
   run the controller's `pickFromThroughput_(...)` —
   `bw = throughput.getEstimate() ?? abr.defaultBandwidthEstimate`,
   walk video streams, return highest fitting `bw × factor`, fall back
   to `streams[0]`.
5. Emits `ADAPTATION` if `pick` differs from `activeStream`.

The controller subscribes to `NETWORK_RESPONSE` (forwards segment
responses to `throughput.sample(...)`), `MEDIA_ATTACHED` /
`MEDIA_ATTACHING` (binds/unbinds the media element's `seeking`
listener), and the media element's `seeking` event (forwards to
`bola.onSeeking()`). The evaluation timer starts in the constructor;
`evaluate_` no-ops when `getStreams()` returns an empty list (manifest
not yet loaded).

## File Layout

```
lib/abr/
  abr_controller.ts        — controller: events, hysteresis, picking
  throughput_estimator.ts  — Ewma (file-private) + ThroughputEstimator
  bola_scorer.ts           — BolaScorer class
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
export class BolaScorer {
  constructor(controller: AbrController);  // pulls state via controller
  // null = startup abstain (controller falls back to throughput).
  getRecommendedStream(): VideoStream | null;
  // Called by AbrController when the media element fires `seeking`.
  onSeeking(): void;
}
```

Neither binds to `Player`. `ThroughputEstimator` is fed via `sample()`
from the controller's `NETWORK_RESPONSE` handler. `BolaScorer` reads
its inputs by calling back into the controller's accessors.

`BolaScorer` has no `destroy()` — it owns no listeners. The
controller binds and unbinds everything.

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

Class with explicit trust state. Standalone — no Player binding, no
event subscriptions of its own. Constructor takes the `AbrController`
so it can pull streams / active stream / front buffer / config when
asked.

File: `bola_scorer.ts` contains:
- `MINIMUM_BUFFER_S = 10` — file-private constant.
- `class BolaScorer` — exported.

### State
- `private controller_: AbrController` — for state lookups.
- `private isSteady_: boolean = false` — startup state machine. False
  initially and after a seek; true once front buffer reaches one
  segment duration.

### State machine

| From | To | Trigger |
|---|---|---|
| (init) | `isSteady_ = false` | constructor |
| `false` | `true` | `getRecommendedStream()` called with `frontBuffer >= maxSegmentDuration` |
| `true` | `false` | `onSeeking()` called by controller (media `seeking` event) |

Why this matches dash.js's three-trigger model:
- **Initial → startup**: matches dash.js's `BOLA_STATE_STARTUP` at init.
- **Buffer threshold transition**: matches dash.js's `_handleBolaStateStartup` flipping to `STEADY` once `bufferLevel >= lastSegmentDurationS`.
- **Seek → startup**: matches dash.js's `_onPlaybackSeeking`. Buffer alone isn't sufficient — seeking inside an already-buffered range preserves the buffer level, but BOLA's prior trajectory is invalid for the new playback position.
- **`BUFFER_EMPTY` does NOT reset state**: matches dash.js — a stall mid-playback doesn't mean BOLA was wrong, just that the network briefly underdelivered.

### API

```ts
getRecommendedStream(): VideoStream | null
  // Pull state via this.controller_.
  // streams      = controller.getStreams()
  // active       = controller.getActiveStream()
  // frontBuffer  = controller.getFrontBuffer()
  // fbl          = controller.getFrontBufferLength()
  // If !active or streams.length === 0, return null.
  // segDur = active.hierarchy.track.maxSegmentDuration
  //
  // If !isSteady_:
  //   if (frontBuffer < segDur) return null;
  //   isSteady_ = true;
  //
  // Compute lnS1, vM, Qmax, gp, V (BOLA math).
  // Return streams[argmax_i (V*(vm_i - 1 + gp) - frontBuffer) / streams[i].bandwidth]
  //   where vm_i = log(streams[i].bandwidth) - lnS1 + 1.

onSeeking(): void
  // isSteady_ = false
```

### Why no `destroy()`?

`BolaScorer` owns no event listeners and no resources requiring
cleanup. The `controller_` reference is just a pointer; when the
controller is destroyed, the scorer becomes unreachable through it
and is GC'd. The controller binds/unbinds the seeking listener on the
media element and forwards calls to `onSeeking()`.

### Why a class with state (now), not the earlier function?

dash.js's `bolaState` exists for four concerns; we now keep one:

1. **Representability gate** (`STARTUP`/`STEADY`). **Kept.** Buffer
   hysteresis catches network-driven low-buffer cases, but seeking
   inside a buffered range can preserve a high buffer level while
   invalidating BOLA's prior expectations. The state machine is the
   right tool. Lives in `isSteady_` + `onSeeking()`.

2. **Placeholder buffer** — deferred per Non-goals.

3. **BOLA-O anti-oscillation** — not implemented; simpler BOLA is
   fine for VOD.

4. **Multi-period plumbing** — out of scope.

If we later restore (2)–(3), state and methods grow on this same class
without touching call sites.

## AbrController

Owns the `Player`, all event wiring, and all policy. The estimator
and scorer are helpers it constructs and feeds.

Responsibilities:
- Construct `ThroughputEstimator(abrConfig)` and `BolaScorer(this)`.
- Subscribe to `NETWORK_RESPONSE` (forwards segment responses to
  `throughput.sample(...)`).
- Subscribe to `MEDIA_ATTACHED` and `MEDIA_ATTACHING` to bind/unbind a
  `seeking` listener on the video element. The media `seeking` event
  forwards to `bola.onSeeking()`.
- Start the evaluation timer at `evaluationInterval` immediately.
- `evaluate_` no-ops when `getStreams()` returns empty (manifest not
  yet loaded).
- Track active-driver state (`"throughput" | "bola"`) and update via
  hysteresis.
- Per tick, dispatch to `bola.getRecommendedStream()` or
  `pickFromThroughput_()` (with BOLA-null fallback to throughput) and
  emit `ADAPTATION` when the pick differs from the active stream.

Surface (intra-package; not exported from `index.ts`):

```ts
class AbrController {
  constructor(player: Player);
  // For Player lifecycle:
  destroy(): void;
  // For BolaScorer state lookup:
  getStreams(): VideoStream[];
  getActiveStream(): VideoStream | null;
  getFrontBuffer(): number;                  // renamed from getBufferLevel()
  getFrontBufferLength(): number;            // PlayerConfig.frontBufferLength
}
```

`getFrontBuffer()` (rename of today's `getBufferLevel`): returns the
seconds of video buffered ahead of the current playback position.
Implementation unchanged — uses `getBufferedEnd(buffered, currentTime,
maxBufferHole)` over `player.getBuffered(MediaType.VIDEO)`. Returns
`0` when there's no media element or no continuous range.

`getStreams()` and `getActiveStream()` — thin passthroughs to
`player.getStreams(MediaType.VIDEO)` and
`player.getActiveStream(MediaType.VIDEO)`. `getFrontBufferLength()` —
returns `player.getConfig().frontBufferLength`.

`destroy()` stops the timer, unbinds `NETWORK_RESPONSE`,
`MEDIA_ATTACHED`, `MEDIA_ATTACHING`, and the media element's
`seeking` listener.

`getThroughputEstimate()` (existed in today's controller as a
public-API hook) is **removed** — `AbrController` is not exported, so
nothing outside the package can reach it. The single internal caller
(`pickFromThroughput_`) reads
`this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate`
inline.

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
- `bola_scorer.test.ts` — startup state returns `null` until front
  buffer ≥ segment duration, transitions to steady on the next call,
  `onSeeking()` resets to startup, correct argmax across buffer
  levels, monotonic preference shift toward higher streams as buffer
  grows. Tests use a stub `AbrController` that returns canned values
  from `getStreams()` / `getActiveStream()` / `getFrontBuffer()` /
  `getFrontBufferLength()`.
- `abr_controller.test.ts` — hysteresis transitions, BOLA-null
  fallback to throughput, throughput-pick logic (default-fallback on
  `getEstimate() === null`, upgrade/downgrade asymmetry,
  lowest-stream floor, no audio subtraction), `NETWORK_RESPONSE →
  throughput.sample` forwarding, media `seeking → bola.onSeeking`
  forwarding (rebound across `MEDIA_ATTACHING` / `MEDIA_ATTACHED`),
  `ADAPTATION` emission, `evaluate_` no-op on empty stream list.

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
