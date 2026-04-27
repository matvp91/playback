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
- `AbrController` is not exported from `index.ts`; its public surface
  consists of `destroy()` and `getThroughputEstimate(): number`.
  `getThroughputEstimate` returns a non-nullable number (default
  applied internally). `BolaScorer` reads its inputs from `Player`
  directly, not via the controller.
- `Player` gains two new public methods exposing ABR observability
  to library consumers: `getBufferFullness(): number` (0..1, clamped
  ratio of front buffer over `frontBufferLength`) and
  `getThroughputEstimate(): number` (delegates to the controller).
  `getBufferLevel` on `AbrController` is removed; the buffer
  computation lives in `Player`.
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
Player (gains getBufferFullness + getThroughputEstimate)
 └── AbrController (NETWORK_RESPONSE hook, hysteresis, picking,
                    BolaScorer lifecycle)
      ├── ThroughputEstimator — class. Bandwidth-only.
      └── BolaScorer          — class. Created on MEDIA_ATTACHED,
                                destroyed on MEDIA_ATTACHING.
                                Takes (Player, HTMLMediaElement).
                                Binds `seeking` on media directly.
```

The split:

- **`ThroughputEstimator`** — narrowest possible: a dual-EWMA over
  `(durationSec, bytes)` samples. Owns sampling state.
- **`BolaScorer`** — BOLA math + an explicit trust state machine.
  Created when media attaches; takes the media element and the
  `Player` in its constructor. Binds `seeking` on the media element
  directly. Reads streams / active stream / front buffer / config via
  `Player` methods. Destroyed (and seeking listener unbound) when
  media detaches.
- **`AbrController`** — owns event wiring at the player-bus level
  (`NETWORK_RESPONSE` → `throughput.sample`; `MEDIA_ATTACHED` /
  `MEDIA_ATTACHING` → `BolaScorer` lifecycle). Owns the timer,
  hysteresis, the throughput-pick algorithm, and BOLA dispatch.
  Public surface: `destroy()` and `getThroughputEstimate(): number`.
  Not exported from `index.ts`.
- **`Player`** — gains `getBufferFullness()` (0..1, clamped: front
  buffer in seconds divided by `frontBufferLength`) and
  `getThroughputEstimate()` (delegates to `AbrController`). Both
  are public observability hooks for library consumers. Internally,
  ABR converts fullness back to seconds (multiplied by
  `frontBufferLength`) where the algorithm needs absolute time.

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

1. Reads `streams`, `activeStream`, buffer fullness (via
   `player.getBufferFullness()`), `frontBufferLength`.
2. Updates the active driver via hysteresis (see Driver Selection).
3. If active driver is BOLA and `bola_` exists (media attached):
   `pick = bola_.getRecommendedStream()`. `BolaScorer` pulls state it
   needs (streams, active stream, front buffer, frontBufferLength)
   from `Player` directly.
4. If `pick` is `null` (BOLA abstained, no media, or active driver is
   Throughput): run `pickFromThroughput_(...)` —
   `bw = throughput.getEstimate() ?? abr.defaultBandwidthEstimate`,
   walk video streams, return highest fitting `bw × factor`, fall back
   to `streams[0]`.
5. Emits `ADAPTATION` if `pick` differs from `activeStream`.

The controller subscribes to:
- `NETWORK_RESPONSE` → forwards segment responses to
  `throughput.sample(...)`.
- `MEDIA_ATTACHED` → constructs `BolaScorer(player, media)`.
- `MEDIA_ATTACHING` → destroys current `BolaScorer` (which unbinds its
  own `seeking` listener), then nulls the field.

The evaluation timer starts in the constructor; `evaluate_` no-ops
when `player.getStreams(MediaType.VIDEO)` returns an empty list.

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
  constructor(player: Player, media: HTMLMediaElement);
  // null = startup abstain (controller falls back to throughput).
  getRecommendedStream(): VideoStream | null;
  destroy(): void;                         // unbinds all listeners
}
```

`ThroughputEstimator` is fed via `sample()` from the controller's
`NETWORK_RESPONSE` handler. `BolaScorer` binds three listeners in its
constructor — `BUFFER_APPENDED` and `BUFFER_FLUSHED` on the player
bus (filtered to video), and `seeking` on the media element — and
unbinds them all in `destroy()`. It reads streams / front buffer /
config via `Player`. No controller ↔ scorer callbacks.

## Driver Selection

Hysteresis around buffer fullness prevents flapping between drivers.
Thresholds are anchored to absolute seconds (BOLA's `MINIMUM_BUFFER_S
= 10` from the paper) and converted to fullness against the active
`frontBufferLength`:

```
const fullness = player.getBufferFullness();
const fbl      = player.getConfig().frontBufferLength;
const lowMark  = MINIMUM_BUFFER_S       / fbl;   // 10s in fullness terms
const highMark = (MINIMUM_BUFFER_S * 2) / fbl;   // 20s in fullness terms

fullness < lowMark   → Throughput
fullness > highMark  → BOLA
otherwise            → keep current driver
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

Class with explicit trust state. Constructor takes the `Player` and
the attached `HTMLMediaElement` (so the seeking listener binds
immediately). Lifetime is tied to the media attachment: the
controller creates a `BolaScorer` on `MEDIA_ATTACHED` and destroys it
on `MEDIA_ATTACHING`.

File: `bola_scorer.ts` contains:
- `MINIMUM_BUFFER_S = 10` — file-private constant.
- `class BolaScorer` — exported.

### State
- `private player_: Player` — for state reads.
- `private media_: HTMLMediaElement` — for the seeking listener.
- `private isSteady_: boolean = false` — flips false on init / seek /
  video buffer flush; flips true on first video `BUFFER_APPENDED`.

### Listeners (bound in constructor, unbound in `destroy()`)

| Source | Event | Effect |
|---|---|---|
| `player` (event bus) | `BUFFER_APPENDED` | if `e.type === SourceBufferMediaType.VIDEO`: `isSteady_ = true` |
| `player` (event bus) | `BUFFER_FLUSHED` | if `e.type === SourceBufferMediaType.VIDEO`: `isSteady_ = false` |
| `media` (HTMLMediaElement) | `seeking` | `isSteady_ = false` |

### Steady gate

| From | To | Trigger |
|---|---|---|
| (init) | `isSteady_ = false` | constructor |
| `false` | `true` | first video `BUFFER_APPENDED` |
| `true` | `false` | video `BUFFER_FLUSHED` or media `seeking` |

While `isSteady_` is false, `getRecommendedStream()` returns `null` —
controller falls back to throughput. Once a video segment is appended
to the SourceBuffer, BOLA engages. Each seek (or video buffer flush)
re-arms the gate.

**Why `BUFFER_APPENDED`, not `NETWORK_RESPONSE`?** `NETWORK_RESPONSE`
fires on download completion, before the bytes hit the SourceBuffer.
`BUFFER_APPENDED` fires *after* the append succeeds — truthful "the
segment is now contributing to playback" signal. This matches dash.js's
intent (BolaRule.js:495 gates BOLA on `bufferLevel >=
lastSegmentDurationS`, written by `MEDIA_FRAGMENT_LOADED`) using
cmaf-lite's actually-buffered signal.

**Why also `BUFFER_FLUSHED`?** Defensive. cmaf-lite doesn't flush
mid-playback in normal flows today, so this listener may not fire in
practice. But future quality-switch flushing (dash.js-style fast
switching), DRM key rotation, or recovery flows could emit it. The
cost is one extra event handler; the benefit is forward-compatibility
without future churn on this class.

**Filter both player events for `MediaType.VIDEO`** — audio
appends/flushes shouldn't move BOLA's state.

Why this matches dash.js's three-trigger model:
- **Initial → startup**: matches dash.js's `BOLA_STATE_STARTUP` at init.
- **Buffer threshold transition**: matches dash.js's `_handleBolaStateStartup` flipping to `STEADY` once `bufferLevel >= lastSegmentDurationS`.
- **Seek → startup**: matches dash.js's `_onPlaybackSeeking`. Buffer alone isn't sufficient — seeking inside an already-buffered range preserves the buffer level, but BOLA's prior trajectory is invalid for the new playback position.
- **`BUFFER_EMPTY` does NOT reset state**: matches dash.js — a stall mid-playback doesn't mean BOLA was wrong, just that the network briefly underdelivered.

### API

```ts
getRecommendedStream(): VideoStream | null
  // Steady gate.
  if (!this.isSteady_) return null;

  // Pull state via this.player_.
  // streams      = player.getStreams(MediaType.VIDEO)
  // fullness     = player.getBufferFullness()       // 0..1
  // fbl          = player.getConfig().frontBufferLength
  // frontBuffer  = fullness * fbl                   // recover seconds
  // If streams.length === 0, return null.
  //
  // Compute lnS1, vM, Qmax, gp, V (BOLA math, in seconds).
  // Return streams[argmax_i (V*(vm_i - 1 + gp) - frontBuffer) / streams[i].bandwidth]
  //   where vm_i = log(streams[i].bandwidth) - lnS1 + 1.

destroy(): void
  // media_.removeEventListener("seeking", this.onSeeking_)
```

### `destroy()`

`BolaScorer` owns three listeners — two on the player bus
(`BUFFER_APPENDED`, `BUFFER_FLUSHED`) and one on the media element
(`seeking`). `destroy()` unbinds all of them. The controller calls
`destroy()` on `MEDIA_ATTACHING` (or from its own `destroy()` if media
was still attached).

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

Owns the `Player`, player-bus event wiring, the eval timer, and the
`BolaScorer` lifecycle.

Responsibilities:
- Construct `ThroughputEstimator(abrConfig)`. If media is already
  attached at construction, also construct
  `BolaScorer(player, media)`.
- Subscribe to `NETWORK_RESPONSE` → for segment responses, call
  `throughput.sample(...)`. (BolaScorer owns its own buffer-append
  and seeking listeners; controller doesn't forward.)
- Subscribe to `MEDIA_ATTACHED` → construct `BolaScorer(player, media)`.
- Subscribe to `MEDIA_ATTACHING` → call `bola_.destroy()`, null
  `bola_`.
- Start the evaluation timer at `evaluationInterval` immediately.
- `evaluate_` no-ops when `player.getStreams(MediaType.VIDEO)` is
  empty (manifest not yet loaded).
- Track active-driver state (`"throughput" | "bola"`) and update via
  hysteresis (uses `player.getBufferFullness()`).
- Per tick: if active is BOLA and `bola_` exists, call
  `bola_.getRecommendedStream()`. On null or no `bola_`, fall back to
  `pickFromThroughput_()`. Emit `ADAPTATION` when the pick differs
  from the active stream.

Surface:

```ts
class AbrController {
  constructor(player: Player);
  getThroughputEstimate(): number;            // default applied internally
  destroy(): void;
}
```

`getThroughputEstimate()` returns
`this.throughput_.getEstimate() ?? this.player_.getConfig().abr.defaultBandwidthEstimate`.
Always a number — consumers don't deal with null. `Player.getThroughputEstimate()`
delegates here.

`destroy()` stops the timer, unbinds `NETWORK_RESPONSE`,
`MEDIA_ATTACHED`, `MEDIA_ATTACHING`, and (if `bola_` is non-null)
calls `bola_.destroy()`.

`AbrController` is not exported from `index.ts`. External consumers
reach throughput observability via `Player.getThroughputEstimate()`.

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

## Player additions

Two new public methods on `Player` exposing ABR observability to
library consumers:

```ts
getBufferFullness(): number
  // 0..1, clamped. front buffer in seconds / config.frontBufferLength.
  // Implementation:
  //   const media = this.getMedia();
  //   if (!media) return 0;
  //   const buffered = this.getBuffered(MediaType.VIDEO);
  //   const { maxBufferHole, frontBufferLength } = this.getConfig();
  //   const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
  //   if (!end) return 0;
  //   return Math.min(1, (end - media.currentTime) / frontBufferLength);

getThroughputEstimate(): number
  // Delegates: this.abrController_.getThroughputEstimate().
  // Always a number (estimator's null is collapsed via the configured
  // default inside AbrController).
```

Both are observability-only — no setters. ABR consumers (analytics,
debug UIs) can read them at any time.

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
- `bola_scorer.test.ts` — `getRecommendedStream()` returns `null`
  before any video `BUFFER_APPENDED` (gate closed); after one video
  `BUFFER_APPENDED`, BOLA runs and returns the argmax stream; audio
  `BUFFER_APPENDED` is ignored; media `seeking` re-arms the gate;
  video `BUFFER_FLUSHED` re-arms the gate; audio `BUFFER_FLUSHED` is
  ignored; `destroy()` unbinds all listeners; correct argmax across
  buffer levels; monotonic preference shift toward higher streams as
  buffer grows. Tests use a stub `Player` (with `on`/`off` event
  bus + canned `getStreams()`/`getBufferFullness()`/`getConfig()`)
  and a fake `HTMLMediaElement` for the seeking dispatch.
- `abr_controller.test.ts` — hysteresis transitions (in fullness
  terms, anchored to `MINIMUM_BUFFER_S / fbl`), BOLA-null fallback to
  throughput, BolaScorer lifecycle (created on `MEDIA_ATTACHED`,
  destroyed on `MEDIA_ATTACHING`), throughput-pick logic
  (default-fallback on `getEstimate() === null`, upgrade/downgrade
  asymmetry, lowest-stream floor, no audio subtraction),
  `NETWORK_RESPONSE → throughput.sample` forwarding, `ADAPTATION`
  emission, `evaluate_` no-op on empty stream list,
  `getThroughputEstimate()` always returns a number.

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
