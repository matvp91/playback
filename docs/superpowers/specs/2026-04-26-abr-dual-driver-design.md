# ABR Dual-Driver Restructure

## Overview

Restructure cmaf-lite's ABR around two explicit drivers — Throughput
(dual EWMA) and BOLA — selected by a buffer-fullness hysteresis.
Replaces the four-rule min-merge model. Modeled after dash.js v5's
`_updateDynamicAbrStrategy` toggle, scaled to cmaf-lite's size.

## Motivation

The current `AbrController` evaluates four rules — Throughput, BOLA,
InsufficientBuffer, DroppedFrames — and picks the lowest bandwidth
among proposals. The pattern conflates independent concerns:

- Throughput and BOLA are competing *strategies*. Min-merge means
  BOLA's buffer-aware advantages are erased whenever Throughput is
  more conservative — BOLA never gets to drive.
- InsufficientBuffer is a low-buffer adjustment to throughput, not a
  peer signal — encoding it as a rule duplicates throughput's role.
- DroppedFrames is a device-capability cap, not a quality strategy.

dash.js v5 resolved these by running only one of BOLA/Throughput at a
time, folding low-buffer behavior into Throughput, and treating
dropped frames / abandonment as separate concerns.

## Goals

- One active driver per evaluation, selected by buffer fullness.
- Dual EWMA throughput estimation isolated in `ThroughputEstimator`.
- BOLA math unchanged in formula, isolated in `BolaScorer`.
- `AbrController` exposes `destroy()` and `getThroughputEstimate()`.
  Not exported from `index.ts`.
- `Player` gains `getBufferFullness()` (0..1) and
  `getThroughputEstimate()` (delegates) as ABR observability hooks.

## Non-goals

- Dropped-frames handling — removed; restored in a follow-up with
  per-stream history.
- InsufficientBuffer rule — removed; the dual-driver model with
  hysteresis subsumes it.
- Abandon-fragment rule — `NetworkService` has no in-flight progress
  events; deferred.
- BOLA placeholder buffer — already deferred per `docs/abr.md`.
- Multi-period state, manual-switch queueing, L2A/LoL+.
- Renaming `Stream`/`VideoStream` to `Representation`.

## Architecture

```
Player (gains getBufferFullness + getThroughputEstimate)
 └── AbrController (NETWORK_RESPONSE hook, hysteresis, picking,
                    BolaScorer lifecycle)
      ├── ThroughputEstimator — dual-EWMA over (durationSec, bytes)
      │                         samples. No Player, no events.
      └── BolaScorer          — BOLA math + isSteady_ trust gate.
                                Lives only while media is attached;
                                binds BUFFER_APPENDED, BUFFER_FLUSHED,
                                and media `seeking` itself.
```

**Per evaluation tick:** controller updates the active driver via
hysteresis; if BOLA, calls `bola_.getRecommendedStream()`; on `null`
or no `bola_`, falls back to `pickFromThroughput_()`. Emits
`ADAPTATION` if the pick differs from the active stream.

**Scope: video-only.** ABR consumes `getStreams(MediaType.VIDEO)`
only. Audio is not switched and not subtracted from the throughput
budget.

## File Layout

```
lib/abr/
  abr_controller.ts        — events, hysteresis, picking, BOLA lifecycle
  throughput_estimator.ts  — Ewma (file-private) + ThroughputEstimator
  bola_scorer.ts           — BolaScorer
```

Deleted: `lib/abr/ewma.ts`, `lib/abr/ewma_bandwidth_estimator.ts`.

## Types

```ts
// throughput_estimator.ts
export class ThroughputEstimator {
  constructor(config: AbrConfig);
  sample(durationSec: number, bytes: number): void;
  getEstimate(): number | null;            // null while undersampled
}

// bola_scorer.ts
export class BolaScorer {
  constructor(player: Player, media: HTMLMediaElement);
  getRecommendedStream(): VideoStream | null;   // null = abstain
  destroy(): void;
}
```

`ThroughputEstimator` is fed via `sample()` from the controller's
`NETWORK_RESPONSE` handler. `BolaScorer` is self-contained: binds its
own listeners, reads streams / fullness / config from `Player`. No
controller ↔ scorer callbacks.

## Driver Selection

Hysteresis around buffer fullness, anchored to absolute seconds
(BOLA's paper-derived `MINIMUM_BUFFER_S = 10`):

```ts
const fullness = player.getBufferFullness();
const fbl      = player.getConfig().frontBufferLength;
const lowMark  = MINIMUM_BUFFER_S       / fbl;   // 10s in fullness terms
const highMark = (MINIMUM_BUFFER_S * 2) / fbl;   // 20s in fullness terms

fullness < lowMark   → Throughput
fullness > highMark  → BOLA
otherwise            → keep current driver
```

Initial driver is `Throughput`. Stored in a private field on the
controller.

## ThroughputEstimator

Pure dual-EWMA estimator. Lives in `throughput_estimator.ts` alongside
a file-private `Ewma` primitive (math unchanged from today's
`lib/abr/ewma.ts`).

**State:** `fast_: Ewma`, `slow_: Ewma`, `totalBytes_: number`,
`config_: AbrConfig`.

**API:**

```ts
sample(durationSec, bytes): void
  // Ignores invalid input. Feeds bps = (bytes * 8) / durationSec
  // into both EWMAs; tracks totalBytes_.

getEstimate(): number | null
  // null when totalBytes_ < config_.minTotalBytes (undersampled).
  // Otherwise: Math.min(fast_.getEstimate(), slow_.getEstimate()).
```

The `defaultBandwidthEstimate` fallback is the controller's
responsibility (`?? abr.defaultBandwidthEstimate`).

## BolaScorer

Class with explicit trust state. Constructor takes the `Player` and
the attached `HTMLMediaElement`. Lifetime tied to media attachment:
controller creates on `MEDIA_ATTACHED`, destroys on `MEDIA_ATTACHING`.

**State:** `player_`, `media_`, `isSteady_: boolean = false`.

**Listeners** (bound in constructor, unbound in `destroy()`):

| Source | Event | Effect |
|---|---|---|
| `player` | `BUFFER_APPENDED` | if VIDEO: `isSteady_ = true` |
| `player` | `BUFFER_FLUSHED` | if VIDEO: `isSteady_ = false` |
| `media` | `seeking` | `isSteady_ = false` |

**Two-gate steady decision** in `getRecommendedStream()`:

1. **Event gate** (`isSteady_`) — at least one video append since
   reset. Catches seek-into-buffered (no fresh download since seek).
2. **Threshold gate** (`frontBuffer >= maxSegmentDuration`) — enough
   buffered media. Catches small-tail and init-segment cases (init
   adds zero buffered time, so threshold stays unsatisfied until a
   real media segment lands — no init-vs-media filter needed in the
   handler).

`maxSegmentDuration` reads `streams[0].hierarchy.track.maxSegmentDuration`
(uniform across video streams in cmaf-lite's neutral model). Avoids
re-introducing a `getActiveStream()` call.

`BUFFER_APPENDED` is the truthful "segment is in the buffer" signal —
fires *after* the SourceBuffer append. `NETWORK_RESPONSE` fires
earlier, before the bytes land. `BUFFER_FLUSHED` is defensive —
cmaf-lite doesn't flush mid-playback today, but listening costs ~3
LOC and forward-compatibly handles future quality-switch flushing.

**API:**

```ts
getRecommendedStream(): VideoStream | null
  if (!this.isSteady_) return null;                              // gate 1

  const streams = this.player_.getStreams(MediaType.VIDEO);
  if (streams.length === 0) return null;

  const fbl         = this.player_.getConfig().frontBufferLength;
  const frontBuffer = this.player_.getBufferFullness() * fbl;
  const maxSegDur   = streams[0]!.hierarchy.track.maxSegmentDuration;

  if (frontBuffer < maxSegDur) return null;                      // gate 2

  // BOLA-O math (in seconds):
  // Compute lnS1, vM, Qmax, gp, V.
  // Return streams[argmax_i (V*(vm_i - 1 + gp) - frontBuffer) / streams[i].bandwidth]
  //   where vm_i = log(streams[i].bandwidth) - lnS1 + 1.
```

## AbrController

Owns the `Player`, player-bus event wiring, the eval timer, and the
`BolaScorer` lifecycle. Surface (intra-package; not exported):

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;            // default applied internally
  destroy(): void;
}
```

`getThroughputEstimate()` returns `throughput.getEstimate() ??
config.abr.defaultBandwidthEstimate`. `Player.getThroughputEstimate()`
delegates here.

**Event subscriptions:**
- `NETWORK_RESPONSE` (segments) → `throughput.sample(...)`.
- `MEDIA_ATTACHED` → `bola_ = new BolaScorer(player, media)`.
- `MEDIA_ATTACHING` → `bola_.destroy(); bola_ = null`.

(BolaScorer owns its own buffer-append, buffer-flush, and seeking
listeners — controller doesn't forward.)

The eval timer starts in the constructor; `evaluate_` no-ops on empty
stream lists. `destroy()` stops the timer, unbinds the three player
events, and calls `bola_?.destroy()`.

**Throughput-pick** (private, parameterless — pulls from `this.player_`):

```ts
private pickFromThroughput_(): VideoStream | null {
  const streams = this.player_.getStreams(MediaType.VIDEO);
  const active  = this.player_.getActiveStream(MediaType.VIDEO);
  const abr     = this.player_.getConfig().abr;
  const bw      = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

  let best: VideoStream | null = null;
  for (const s of streams) {
    let scaled = bw;
    if (active) {
      scaled *= s.bandwidth > active.bandwidth
        ? abr.bandwidthUpgradeTarget
        : abr.bandwidthDowngradeTarget;
    }
    if (s.bandwidth <= scaled) best = s;
  }
  return best ?? streams[0] ?? null;
}
```

(No audio-bandwidth subtraction — see Architecture: video-only.)

## Player additions

```ts
getBufferFullness(): number
  // 0..1, clamped. Front-buffer-seconds / frontBufferLength.
  // Returns 0 when no media or no continuous range.

getThroughputEstimate(): number
  // Delegates to AbrController; always a number.
```

Implementation of `getBufferFullness` reuses today's
`getBufferLevel`-style buffer-end computation (`getBufferedEnd` over
`getBuffered(MediaType.VIDEO)`), divided by `config.frontBufferLength`,
clamped to `[0, 1]`.

## Config

`AbrConfig` is unchanged. `droppedFramesThreshold` retained but unused
in this refactor (restored when dropped-frames returns). All other
fields (`minTotalBytes`, `defaultBandwidthEstimate`, the EWMA
half-lives, the upgrade/downgrade targets) keep their meaning.

## Tests

Tests live in `packages/cmaf-lite/test/abr/`, mirroring `lib/abr/`.

- **`throughput_estimator.test.ts`** — dual-EWMA math; `getEstimate()`
  returns `null` while undersampled and `min(fast, slow)` afterward;
  invalid samples ignored.
- **`bola_scorer.test.ts`** — both gates: `null` before any video
  `BUFFER_APPENDED` (audio appends ignored); `null` while
  `frontBuffer < maxSegmentDuration` even after the event gate opens
  (covers small-tail and init-only cases); media `seeking` and video
  `BUFFER_FLUSHED` re-arm the gate; correct argmax across buffer
  levels with monotonic preference for higher streams as buffer
  grows; `destroy()` unbinds all listeners. Tests use a stub `Player`
  and a fake `HTMLMediaElement`.
- **`abr_controller.test.ts`** — hysteresis transitions; BOLA-null →
  throughput fallback; BolaScorer lifecycle on `MEDIA_ATTACHED` /
  `MEDIA_ATTACHING`; throughput-pick (default fallback,
  upgrade/downgrade asymmetry, lowest-stream floor); `NETWORK_RESPONSE
  → throughput.sample` forwarding; `ADAPTATION` emission;
  `evaluate_` no-op on empty streams; `getThroughputEstimate()`
  always returns a number.

Existing rule-specific tests collapse into the new tests above.

## Migration

- Delete `lib/abr/ewma.ts`, `lib/abr/ewma_bandwidth_estimator.ts`.
- Add `lib/abr/throughput_estimator.ts`, `lib/abr/bola_scorer.ts`.
- Replace `lib/abr/abr_controller.ts` with the slim orchestrator.
- Add `Player.getBufferFullness()` and `Player.getThroughputEstimate()`.
- Update `docs/abr.md` to describe drivers, not rules; note dropped
  frames and abandon-fragment as deferred.
- Update `docs/DESIGN.md` AbrController paragraph (currently mentions
  "four independent rules").

## Risks

- **Sudden network drop with stale slow-EWMA.** Old InsufficientBuffer
  rule pulled below Throughput's pick when buffer was thin. New code
  relies on the fast EWMA (3s half-life). Mitigation: if traces show
  rebuffering on sudden drops, add a buffer-safety cap in the
  controller (~15 LOC, additive).
- **BOLA never selected if buffer can't reach `highMark`.** With
  `frontBufferLength = 30` and 20s `highMark`, normal VOD reaches
  BOLA quickly. Tight `frontBufferLength` configs may stay on
  Throughput throughout — acceptable.
- **Dropped-frames regression on capability-limited devices.**
  Accepted; restored in a follow-up.
