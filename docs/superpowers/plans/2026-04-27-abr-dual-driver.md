# ABR Dual-Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure cmaf-lite's ABR around two explicit drivers — Throughput (dual EWMA) and BOLA — selected by a buffer-fullness hysteresis. Replace the four-rule min-merge model.

**Architecture:** `AbrController` owns the eval loop, hysteresis, throughput-pick algorithm, and `BolaScorer` lifecycle. `ThroughputEstimator` is pure dual-EWMA math fed by `NETWORK_RESPONSE`. `BolaScorer` is self-contained: takes `(Player, HTMLMediaElement)`, binds its own `BUFFER_APPENDED`/`BUFFER_FLUSHED`/`seeking` listeners, gates on a two-condition trust state. `Player` gains `getBufferFullness()` (0..1, clamped) and `getThroughputEstimate()` (delegates) as observability hooks.

**Tech Stack:** TypeScript, vitest + happy-dom, biome (formatting/lint), `@matvp91/eventemitter3` for event bus.

**Spec:** [`docs/superpowers/specs/2026-04-26-abr-dual-driver-design.md`](../specs/2026-04-26-abr-dual-driver-design.md)

---

## File Structure

**New files:**
- `packages/cmaf-lite/lib/abr/throughput_estimator.ts` — `Ewma` (file-private) + `ThroughputEstimator` class.
- `packages/cmaf-lite/lib/abr/bola_scorer.ts` — `BolaScorer` class.
- `packages/cmaf-lite/test/abr/throughput_estimator.test.ts` — pure-math unit tests.
- `packages/cmaf-lite/test/abr/bola_scorer.test.ts` — gate + math tests using stub `Player` and a real happy-dom `HTMLVideoElement`.
- `packages/cmaf-lite/test/abr/abr_controller.test.ts` — controller unit tests.
- `packages/cmaf-lite/test/__framework__/abr_stubs.ts` — stub-Player factory for ABR tests.

**Modified files:**
- `packages/cmaf-lite/lib/player.ts` — add `getBufferFullness()` and `getThroughputEstimate()`.
- `packages/cmaf-lite/lib/abr/abr_controller.ts` — replace internals.

**Deleted files:**
- `packages/cmaf-lite/lib/abr/ewma.ts` — folded into `throughput_estimator.ts`.
- `packages/cmaf-lite/lib/abr/ewma_bandwidth_estimator.ts` — replaced by `ThroughputEstimator`.

**Doc updates:**
- `packages/cmaf-lite/docs/abr.md` — rewrite around drivers, not rules.
- `packages/cmaf-lite/docs/DESIGN.md` — update AbrController paragraph.

**Order rationale:** Add new helpers first (parallel to old code, all compiles + tests pass at every commit); then rewrite the controller atomically while deleting old files; then docs.

---

## Task 1: Add `Player.getBufferFullness()`

The buffer computation lives on `Player` so both `AbrController` (hysteresis) and `BolaScorer` can read it. Returns 0..1, clamped — front buffer in seconds divided by `frontBufferLength`.

**Files:**
- Modify: `packages/cmaf-lite/lib/player.ts`
- Test: `packages/cmaf-lite/test/player.test.ts` (new)

- [ ] **Step 1.1: Write the failing test**

Create `packages/cmaf-lite/test/player.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { Player } from "../lib/player";
import { MediaType } from "../lib/types/media";

describe("Player", () => {
  describe("getBufferFullness", () => {
    let player: Player;

    beforeEach(() => {
      player = new Player();
    });

    it("returns 0 when no media is attached", () => {
      expect(player.getBufferFullness()).toBe(0);
    });

    it("returns 0 when buffered ranges don't cover currentTime", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "buffered", {
        value: { length: 0, start: () => 0, end: () => 0 },
        configurable: true,
      });
      Object.defineProperty(video, "currentTime", { value: 0, configurable: true });
      player.attachMedia(video);
      expect(player.getBufferFullness()).toBe(0);
    });

    it("returns ahead/frontBufferLength when buffered", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "buffered", {
        value: {
          length: 1,
          start: (i: number) => (i === 0 ? 0 : 0),
          end: (i: number) => (i === 0 ? 15 : 0),
        },
        configurable: true,
      });
      Object.defineProperty(video, "currentTime", { value: 0, configurable: true });
      player.attachMedia(video);
      // frontBufferLength default = 30, ahead = 15 → 0.5
      expect(player.getBufferFullness()).toBeCloseTo(0.5);
    });

    it("clamps at 1 when ahead > frontBufferLength", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "buffered", {
        value: {
          length: 1,
          start: (i: number) => (i === 0 ? 0 : 0),
          end: (i: number) => (i === 0 ? 60 : 0),
        },
        configurable: true,
      });
      Object.defineProperty(video, "currentTime", { value: 0, configurable: true });
      player.attachMedia(video);
      expect(player.getBufferFullness()).toBe(1);
    });
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
cd packages/cmaf-lite && pnpm vitest run test/player.test.ts
```

Expected: FAIL — `player.getBufferFullness is not a function`.

- [ ] **Step 1.3: Implement `getBufferFullness` on Player**

In `packages/cmaf-lite/lib/player.ts`, add the import for `getBufferedEnd`:

```ts
import { getBufferedEnd } from "./utils/buffer_utils";
```

(If a `MediaType` import already exists, leave it; `getBufferFullness` uses `MediaType.VIDEO`.)

Add the method on the `Player` class, near the other getters (after `getBuffered`):

```ts
/**
 * Returns the front-buffer fullness for video, clamped to [0, 1].
 * `0` when no media is attached or no buffered range covers the
 * playhead. Otherwise: `ahead / frontBufferLength` where `ahead` is
 * seconds buffered ahead of `currentTime`, clamped at 1.
 *
 * @public
 */
getBufferFullness(): number {
  const media = this.media_;
  if (!media) {
    return 0;
  }
  const buffered = this.getBuffered(MediaType.VIDEO);
  const { maxBufferHole, frontBufferLength } = this.config_;
  const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
  if (end === null) {
    return 0;
  }
  const ahead = end - media.currentTime;
  return Math.min(1, ahead / frontBufferLength);
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
cd packages/cmaf-lite && pnpm vitest run test/player.test.ts
```

Expected: PASS — all four `getBufferFullness` tests.

- [ ] **Step 1.5: Run full test suite + tsc to verify nothing else broke**

```bash
cd packages/cmaf-lite && pnpm test && pnpm tsc
```

Expected: all tests pass; no type errors.

- [ ] **Step 1.6: Commit**

```bash
git add packages/cmaf-lite/lib/player.ts packages/cmaf-lite/test/player.test.ts
git commit -m "$(cat <<'EOF'
feat(player): add getBufferFullness() observability hook

Returns 0..1 clamped — front buffer in seconds / frontBufferLength.
Used by ABR (hysteresis + BOLA gate) and available for UI consumers.
EOF
)"
```

---

## Task 2: Create `ThroughputEstimator`

Pure dual-EWMA estimator. New file replaces the existing `Ewma` + `EwmaBandwidthEstimator` pair, with one signature change: `getEstimate()` returns `number | null` (null while undersampled).

**Files:**
- Create: `packages/cmaf-lite/lib/abr/throughput_estimator.ts`
- Test: `packages/cmaf-lite/test/abr/throughput_estimator.test.ts`

- [ ] **Step 2.1: Create the test file with the first failing test**

Create `packages/cmaf-lite/test/abr/throughput_estimator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AbrConfig } from "../../lib/config";
import { ThroughputEstimator } from "../../lib/abr/throughput_estimator";

const TEST_CONFIG: AbrConfig = {
  defaultBandwidthEstimate: 1_000_000,
  bandwidthUpgradeTarget: 0.7,
  bandwidthDowngradeTarget: 0.95,
  evaluationInterval: 8,
  fastHalfLife: 3,
  slowHalfLife: 9,
  minTotalBytes: 128_000,
  droppedFramesThreshold: 0.15,
};

describe("ThroughputEstimator", () => {
  it("returns null before any sample", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    expect(est.getEstimate()).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/throughput_estimator.test.ts
```

Expected: FAIL — `Cannot find module 'lib/abr/throughput_estimator'`.

- [ ] **Step 2.3: Create `throughput_estimator.ts` with `Ewma` and `ThroughputEstimator`**

Create `packages/cmaf-lite/lib/abr/throughput_estimator.ts`:

```ts
import type { AbrConfig } from "../config";

/**
 * Weighted exponentially-weighted moving average with bias correction.
 * Math unchanged from the previous `lib/abr/ewma.ts`.
 */
class Ewma {
  private alpha_: number;
  private estimate_ = 0;
  private totalWeight_ = 0;

  constructor(halfLife: number) {
    // Convert half-life to a per-unit-time decay factor in (0, 1).
    this.alpha_ = 0.5 ** (1 / halfLife);
  }

  sample(weight: number, value: number) {
    const adjAlpha = this.alpha_ ** weight;
    const newEstimate = value * (1 - adjAlpha) + adjAlpha * this.estimate_;
    if (!Number.isNaN(newEstimate)) {
      this.estimate_ = newEstimate;
      this.totalWeight_ += weight;
    }
  }

  getEstimate(): number {
    const zeroFactor = 1 - this.alpha_ ** this.totalWeight_;
    return this.estimate_ / zeroFactor;
  }
}

/**
 * Dual-EWMA throughput estimator. Samples bandwidth from
 * `(durationSeconds, bytes)` and reports the conservative estimate
 * `min(fast, slow)` once `totalBytes >= config.minTotalBytes`.
 *
 * Returns `null` while undersampled — caller decides what to do
 * (typically falling back to `config.defaultBandwidthEstimate`).
 */
export class ThroughputEstimator {
  private fast_: Ewma;
  private slow_: Ewma;
  private totalBytes_ = 0;
  private config_: AbrConfig;

  constructor(config: AbrConfig) {
    this.config_ = config;
    this.fast_ = new Ewma(config.fastHalfLife);
    this.slow_ = new Ewma(config.slowHalfLife);
  }

  sample(durationSeconds: number, bytes: number) {
    if (durationSeconds <= 0 || bytes <= 0) {
      return;
    }
    const bitsPerSecond = (bytes * 8) / durationSeconds;
    this.fast_.sample(durationSeconds, bitsPerSecond);
    this.slow_.sample(durationSeconds, bitsPerSecond);
    this.totalBytes_ += bytes;
  }

  /**
   * Returns the conservative throughput estimate in bits/second, or
   * `null` while `totalBytes_ < config_.minTotalBytes` (insufficient
   * data for the EWMA to be trustworthy).
   */
  getEstimate(): number | null {
    if (this.totalBytes_ < this.config_.minTotalBytes) {
      return null;
    }
    return Math.min(this.fast_.getEstimate(), this.slow_.getEstimate());
  }
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/throughput_estimator.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Add the rest of the tests**

Append to `packages/cmaf-lite/test/abr/throughput_estimator.test.ts` (inside the same `describe` block):

```ts
  it("ignores invalid samples", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    est.sample(0, 100_000);
    est.sample(-1, 100_000);
    est.sample(1, 0);
    est.sample(1, -100);
    expect(est.getEstimate()).toBeNull();
  });

  it("returns null while totalBytes < minTotalBytes", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    // 64 KB worth of samples — under the 128 KB threshold.
    est.sample(1, 64_000);
    expect(est.getEstimate()).toBeNull();
  });

  it("returns min(fast, slow) once over the threshold", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    // Steady 8 Mbps over enough bytes to clear minTotalBytes.
    // Each sample: 1MB in 1s = 8 Mbps; 200 KB chunks for granularity.
    for (let i = 0; i < 10; i++) {
      est.sample(0.2, 200_000);
    }
    const estimate = est.getEstimate();
    expect(estimate).not.toBeNull();
    // At steady ~8 Mbps with the same input to both Ewmas, both
    // return ~8e6, so min is also ~8e6.
    expect(estimate).toBeGreaterThan(7_500_000);
    expect(estimate).toBeLessThan(8_500_000);
  });

  it("fast EWMA drops faster than slow on a sudden bandwidth dip", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    // Prime with steady 8 Mbps for plenty of samples.
    for (let i = 0; i < 20; i++) {
      est.sample(0.2, 200_000);
    }
    const before = est.getEstimate()!;
    // Sudden dip to 1 Mbps for a few samples (each: 25 KB in 0.2s = 1 Mbps).
    for (let i = 0; i < 5; i++) {
      est.sample(0.2, 25_000);
    }
    const after = est.getEstimate()!;
    expect(after).toBeLessThan(before);
    // min(fast, slow) should reflect the dip — fast reacts in seconds.
    expect(after).toBeLessThan(5_000_000);
  });
```

- [ ] **Step 2.6: Run all the new tests**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/throughput_estimator.test.ts
```

Expected: PASS — five tests.

- [ ] **Step 2.7: Run full suite + tsc**

```bash
cd packages/cmaf-lite && pnpm test && pnpm tsc
```

Expected: all green.

- [ ] **Step 2.8: Commit**

```bash
git add packages/cmaf-lite/lib/abr/throughput_estimator.ts \
        packages/cmaf-lite/test/abr/throughput_estimator.test.ts
git commit -m "$(cat <<'EOF'
feat(abr): add ThroughputEstimator with nullable getEstimate

New dual-EWMA estimator that returns null while undersampled
(totalBytes < config.minTotalBytes), letting the caller apply the
default fallback explicitly. Replaces the previous
EwmaBandwidthEstimator (deleted in a later commit) once AbrController
is rewritten.
EOF
)"
```

---

## Task 3: Add ABR test stub helper

Shared stub-`Player` factory used by `bola_scorer.test.ts` and `abr_controller.test.ts`. Saves duplicate plumbing.

**Files:**
- Create: `packages/cmaf-lite/test/__framework__/abr_stubs.ts`

- [ ] **Step 3.1: Write the helper**

Create `packages/cmaf-lite/test/__framework__/abr_stubs.ts`:

```ts
import { EventEmitter } from "@matvp91/eventemitter3";
import type { PlayerConfig } from "../../lib/config";
import { DEFAULT_CONFIG } from "../../lib/config";
import type { EventMap } from "../../lib/events";
import { MediaType } from "../../lib/types/media";
import type { Stream, VideoStream } from "../../lib/types/media";
import { createVideoSwitchingSet, createVideoTrack } from "./factories";

export interface StubPlayer extends EventEmitter<EventMap> {
  getStreams<T extends MediaType>(type: T): Stream<T>[];
  getActiveStream<T extends MediaType>(type: T): Stream<T> | null;
  getBufferFullness(): number;
  getConfig(): PlayerConfig;
  setBufferFullness(value: number): void;
  setActiveVideoStream(stream: VideoStream | null): void;
  setVideoStreams(streams: VideoStream[]): void;
  setConfig(config: PlayerConfig): void;
}

export function createStubPlayer(opts?: {
  streams?: VideoStream[];
  activeStream?: VideoStream | null;
  bufferFullness?: number;
  config?: PlayerConfig;
}): StubPlayer {
  let videoStreams = opts?.streams ?? [];
  let activeVideo = opts?.activeStream ?? null;
  let fullness = opts?.bufferFullness ?? 0;
  let config = opts?.config ?? DEFAULT_CONFIG;

  const emitter = new EventEmitter<EventMap>();
  return Object.assign(emitter, {
    getStreams<T extends MediaType>(type: T): Stream<T>[] {
      if (type === MediaType.VIDEO) return videoStreams as Stream<T>[];
      return [] as Stream<T>[];
    },
    getActiveStream<T extends MediaType>(type: T): Stream<T> | null {
      if (type === MediaType.VIDEO) return activeVideo as Stream<T> | null;
      return null;
    },
    getBufferFullness: () => fullness,
    getConfig: () => config,
    setBufferFullness(v: number) {
      fullness = v;
    },
    setActiveVideoStream(s: VideoStream | null) {
      activeVideo = s;
    },
    setVideoStreams(s: VideoStream[]) {
      videoStreams = s;
    },
    setConfig(c: PlayerConfig) {
      config = c;
    },
  }) as unknown as StubPlayer;
}

/**
 * Helper to build a video stream with a given bandwidth, sharing
 * a default track + switching set. The `hierarchy.track` reference
 * is what `BolaScorer` reads for `maxSegmentDuration`.
 */
export function makeVideoStream(
  bandwidth: number,
  overrides?: { maxSegmentDuration?: number },
): VideoStream {
  const track = createVideoTrack({
    bandwidth,
    maxSegmentDuration: overrides?.maxSegmentDuration ?? 4,
  });
  const switchingSet = createVideoSwitchingSet({ tracks: [track] });
  return {
    type: MediaType.VIDEO,
    bandwidth,
    codec: switchingSet.codec,
    width: track.width,
    height: track.height,
    hierarchy: { switchingSet, track },
  };
}
```

- [ ] **Step 3.2: Verify it compiles**

```bash
cd packages/cmaf-lite && pnpm tsc
```

Expected: no type errors. (No tests yet — file compiles in isolation.)

- [ ] **Step 3.3: Commit**

```bash
git add packages/cmaf-lite/test/__framework__/abr_stubs.ts
git commit -m "$(cat <<'EOF'
test(abr): add stub Player + makeVideoStream helpers

Shared fixtures for BolaScorer and AbrController tests. StubPlayer
satisfies the methods both consumers call (getStreams, getActiveStream,
getBufferFullness, getConfig) and exposes setters for test mutation.
makeVideoStream produces a VideoStream with a real track reference so
hierarchy.track.maxSegmentDuration is readable.
EOF
)"
```

---

## Task 4: Create `BolaScorer`

Two-gate trust state machine: event gate (`isSteady_`) flipped by `BUFFER_APPENDED`/`BUFFER_FLUSHED`/media `seeking`, and threshold gate (`frontBuffer >= maxSegmentDuration`) checked per call.

**Files:**
- Create: `packages/cmaf-lite/lib/abr/bola_scorer.ts`
- Test: `packages/cmaf-lite/test/abr/bola_scorer.test.ts`

- [ ] **Step 4.1: Write the first failing test (event gate closed initially)**

Create `packages/cmaf-lite/test/abr/bola_scorer.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { BolaScorer } from "../../lib/abr/bola_scorer";
import { Events } from "../../lib/events";
import { MediaType } from "../../lib/types/media";
import type { VideoStream } from "../../lib/types/media";
import { createStubPlayer, makeVideoStream } from "../__framework__/abr_stubs";
import type { StubPlayer } from "../__framework__/abr_stubs";

function makeMedia(): HTMLVideoElement {
  return document.createElement("video");
}

describe("BolaScorer", () => {
  let player: StubPlayer;
  let media: HTMLVideoElement;
  let scorer: BolaScorer;
  let streams: VideoStream[];

  beforeEach(() => {
    streams = [
      makeVideoStream(500_000, { maxSegmentDuration: 4 }),
      makeVideoStream(1_500_000, { maxSegmentDuration: 4 }),
      makeVideoStream(3_000_000, { maxSegmentDuration: 4 }),
    ];
    player = createStubPlayer({
      streams,
      activeStream: streams[0]!,
      bufferFullness: 1,    // 30s with default frontBufferLength
    });
    media = makeMedia();
    scorer = new BolaScorer(player, media);
  });

  it("returns null before any BUFFER_APPENDED (event gate closed)", () => {
    expect(scorer.getRecommendedStream()).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/bola_scorer.test.ts
```

Expected: FAIL — `Cannot find module 'lib/abr/bola_scorer'`.

- [ ] **Step 4.3: Implement `BolaScorer`**

Create `packages/cmaf-lite/lib/abr/bola_scorer.ts`:

```ts
import type {
  BufferAppendedEvent,
  BufferFlushedEvent,
} from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import { MediaType } from "../types/media";
import type { VideoStream } from "../types/media";

/**
 * BOLA paper minimum-buffer constant (arxiv 1601.06748). The buffer
 * level at which BOLA prefers the lowest-bitrate stream. A real-world
 * time constant — does not scale with `frontBufferLength`.
 */
const MINIMUM_BUFFER_S = 10;

/**
 * BOLA scorer with a two-gate trust state machine.
 *
 * - **Event gate** (`isSteady_`): true once a video segment has been
 *   appended since the last reset. Cleared on video buffer flush or
 *   media `seeking`.
 * - **Threshold gate**: front buffer in seconds must reach at least
 *   one segment duration before BOLA's math runs.
 *
 * When either gate is closed, `getRecommendedStream()` returns
 * `null` and the controller falls back to throughput.
 *
 * Lifetime is tied to media attachment: `AbrController` constructs
 * a `BolaScorer` on `MEDIA_ATTACHED` and calls `destroy()` on
 * `MEDIA_DETACHING`.
 */
export class BolaScorer {
  private player_: Player;
  private media_: HTMLMediaElement;
  private isSteady_ = false;

  constructor(player: Player, media: HTMLMediaElement) {
    this.player_ = player;
    this.media_ = media;
    this.player_.on(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.on(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.media_.addEventListener("seeking", this.onSeeking_);
  }

  /**
   * Returns the BOLA-recommended video stream, or `null` while
   * either gate is closed.
   */
  getRecommendedStream(): VideoStream | null {
    if (!this.isSteady_) {
      return null;
    }
    const streams = this.player_.getStreams(MediaType.VIDEO);
    const lowest = streams[0];
    const highest = streams[streams.length - 1];
    if (!lowest || !highest) {
      return null;
    }
    const config = this.player_.getConfig();
    const fbl = config.frontBufferLength;
    const frontBuffer = this.player_.getBufferFullness() * fbl;
    const maxSegDur = lowest.hierarchy.track.maxSegmentDuration;
    if (frontBuffer < maxSegDur) {
      return null;
    }

    const lnS1 = Math.log(lowest.bandwidth);
    const vM = Math.log(highest.bandwidth) - lnS1 + 1;
    const Qmax = Math.max(fbl, MINIMUM_BUFFER_S + 2 * streams.length);
    const gp = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1);
    const V = MINIMUM_BUFFER_S / gp;

    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      if (!stream) continue;
      const vm = Math.log(stream.bandwidth) - lnS1 + 1;
      // Paper score is (V * (v_m + gp) - Q) / S_m with lowest v_m = 0.
      // Our vm is +1 shifted, so subtract 1 to recover the paper's v_m.
      const score = (V * (vm - 1 + gp) - frontBuffer) / stream.bandwidth;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    return streams[bestIndex] ?? null;
  }

  destroy(): void {
    this.player_.off(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.off(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.media_.removeEventListener("seeking", this.onSeeking_);
  }

  private onBufferAppended_ = (event: BufferAppendedEvent) => {
    if (event.type !== MediaType.VIDEO) return;
    this.isSteady_ = true;
  };

  private onBufferFlushed_ = (event: BufferFlushedEvent) => {
    if (event.type !== MediaType.VIDEO) return;
    this.isSteady_ = false;
  };

  private onSeeking_ = () => {
    this.isSteady_ = false;
  };
}
```

- [ ] **Step 4.4: Run test to verify it passes**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/bola_scorer.test.ts
```

Expected: PASS — single test "returns null before any BUFFER_APPENDED".

- [ ] **Step 4.5: Add gate tests**

Append to `packages/cmaf-lite/test/abr/bola_scorer.test.ts` (inside the same `describe` block):

```ts
  it("returns a stream after a video BUFFER_APPENDED", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    const pick = scorer.getRecommendedStream();
    expect(pick).not.toBeNull();
  });

  it("ignores audio BUFFER_APPENDED for the event gate", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.AUDIO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    expect(scorer.getRecommendedStream()).toBeNull();
  });

  it("video BUFFER_FLUSHED re-arms the event gate", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    expect(scorer.getRecommendedStream()).not.toBeNull();
    player.emit(Events.BUFFER_FLUSHED, { type: MediaType.VIDEO });
    expect(scorer.getRecommendedStream()).toBeNull();
  });

  it("audio BUFFER_FLUSHED does not affect the event gate", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    player.emit(Events.BUFFER_FLUSHED, { type: MediaType.AUDIO });
    expect(scorer.getRecommendedStream()).not.toBeNull();
  });

  it("media seeking re-arms the event gate", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    expect(scorer.getRecommendedStream()).not.toBeNull();
    media.dispatchEvent(new Event("seeking"));
    expect(scorer.getRecommendedStream()).toBeNull();
  });

  it("threshold gate closes when frontBuffer < maxSegmentDuration", () => {
    // Open event gate.
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    // maxSegmentDuration = 4 (from makeVideoStream); frontBufferLength = 30;
    // fullness = 0.1 → frontBuffer = 3 < 4. Threshold gate closes.
    player.setBufferFullness(0.1);
    expect(scorer.getRecommendedStream()).toBeNull();
  });
```

- [ ] **Step 4.6: Run gate tests**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/bola_scorer.test.ts
```

Expected: PASS — all seven tests so far.

- [ ] **Step 4.7: Add BOLA math tests**

Append to `packages/cmaf-lite/test/abr/bola_scorer.test.ts`:

```ts
  it("prefers lower stream when buffer is just over the threshold", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    // Just above threshold (4s). MINIMUM_BUFFER_S = 10s; well below.
    // BOLA should pick the lowest stream.
    player.setBufferFullness(5 / 30);
    expect(scorer.getRecommendedStream()).toBe(streams[0]);
  });

  it("prefers highest stream when buffer is at frontBufferLength", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    player.setBufferFullness(1);    // 30s
    expect(scorer.getRecommendedStream()).toBe(streams[2]);
  });

  it("monotonic preference: stream index never decreases as buffer grows", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    let prevIndex = 0;
    for (let f = 5 / 30; f <= 1; f += 0.05) {
      player.setBufferFullness(f);
      const pick = scorer.getRecommendedStream();
      if (pick === null) continue;
      const idx = streams.indexOf(pick);
      expect(idx).toBeGreaterThanOrEqual(prevIndex);
      prevIndex = idx;
    }
  });
```

- [ ] **Step 4.8: Run math tests**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/bola_scorer.test.ts
```

Expected: PASS — all ten tests.

- [ ] **Step 4.9: Add `destroy()` test**

Append to `packages/cmaf-lite/test/abr/bola_scorer.test.ts`:

```ts
  it("destroy() unbinds player and media listeners", () => {
    scorer.destroy();
    // Without an unbind, this would flip isSteady_ to true.
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    media.dispatchEvent(new Event("seeking"));
    expect(scorer.getRecommendedStream()).toBeNull();
  });
```

- [ ] **Step 4.10: Run all tests + tsc**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/bola_scorer.test.ts && pnpm tsc
```

Expected: PASS — eleven tests, no type errors.

- [ ] **Step 4.11: Commit**

```bash
git add packages/cmaf-lite/lib/abr/bola_scorer.ts \
        packages/cmaf-lite/test/abr/bola_scorer.test.ts
git commit -m "$(cat <<'EOF'
feat(abr): add BolaScorer with two-gate trust state machine

Self-contained class that owns its own listeners (BUFFER_APPENDED,
BUFFER_FLUSHED on the player bus; seeking on the media element) and
gates getRecommendedStream() on:

- Event gate (isSteady_): true once a video segment has been
  appended since the last reset; cleared on video flush or seek.
- Threshold gate: frontBuffer >= maxSegmentDuration; catches small
  and init-segment cases.

Created on MEDIA_ATTACHED, destroyed on MEDIA_DETACHING by
AbrController in the next commit.
EOF
)"
```

---

## Task 5: Rewrite `AbrController`, add `Player.getThroughputEstimate()`, delete old files

This is the atomic switch. The new controller uses `ThroughputEstimator` + `BolaScorer`. The old `Ewma` and `EwmaBandwidthEstimator` files are deleted in this commit.

**Files:**
- Modify: `packages/cmaf-lite/lib/abr/abr_controller.ts` (full rewrite)
- Modify: `packages/cmaf-lite/lib/player.ts` (add `getThroughputEstimate`)
- Delete: `packages/cmaf-lite/lib/abr/ewma.ts`
- Delete: `packages/cmaf-lite/lib/abr/ewma_bandwidth_estimator.ts`
- Test: `packages/cmaf-lite/test/abr/abr_controller.test.ts` (new)

- [ ] **Step 5.1: Write the first failing controller test (constructor + destroy don't crash)**

Create `packages/cmaf-lite/test/abr/abr_controller.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AbrController } from "../../lib/abr/abr_controller";
import type { AbrConfig, PlayerConfig } from "../../lib/config";
import { DEFAULT_CONFIG } from "../../lib/config";
import { Events } from "../../lib/events";
import { MediaType } from "../../lib/types/media";
import type { VideoStream } from "../../lib/types/media";
import { NetworkRequestType } from "../../lib/types/net";
import {
  createStubPlayer,
  makeVideoStream,
} from "../__framework__/abr_stubs";
import type { StubPlayer } from "../__framework__/abr_stubs";

function configWith(overrides: Partial<AbrConfig>): PlayerConfig {
  return {
    ...DEFAULT_CONFIG,
    abr: { ...DEFAULT_CONFIG.abr, ...overrides },
  };
}

describe("AbrController", () => {
  let player: StubPlayer;
  let streams: VideoStream[];

  beforeEach(() => {
    streams = [
      makeVideoStream(500_000),
      makeVideoStream(1_500_000),
      makeVideoStream(3_000_000),
    ];
    player = createStubPlayer({
      streams,
      activeStream: streams[0]!,
      bufferFullness: 0,
    });
  });

  it("constructs and destroys without errors", () => {
    const controller = new AbrController(player as never);
    expect(() => controller.destroy()).not.toThrow();
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/abr_controller.test.ts
```

Expected: FAIL — current `AbrController` constructor calls `player.on(STREAMS_CREATED, ...)`, which the stub may handle differently, and the controller's existing `EwmaBandwidthEstimator` import will conflict once we delete the file. The test will fail in some form before the rewrite.

- [ ] **Step 5.3: Replace `lib/abr/abr_controller.ts` with the slim orchestrator**

Overwrite `packages/cmaf-lite/lib/abr/abr_controller.ts`:

```ts
import type {
  MediaAttachedEvent,
  MediaDetachingEvent,
  NetworkResponseEvent,
} from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";
import { BolaScorer } from "./bola_scorer";
import { ThroughputEstimator } from "./throughput_estimator";

const log = Log.create("AbrController");

/**
 * The buffer threshold (in seconds) at which BOLA's math becomes
 * meaningful. From the BOLA paper. Used by the controller's
 * hysteresis to choose between Throughput and BOLA.
 */
const MINIMUM_BUFFER_S = 10;

type ActiveDriver = "throughput" | "bola";

/**
 * Adaptive bitrate controller. Picks one of two drivers per
 * evaluation tick:
 *
 * - **Throughput**: highest stream fitting the current EWMA estimate
 *   (with upgrade/downgrade asymmetry). Active when buffer is low.
 * - **BOLA**: buffer-level utility scoring (BOLA-O). Active when
 *   buffer is comfortable. Falls back to throughput if its
 *   trust gate is closed.
 *
 * Selection between drivers is a buffer-fullness hysteresis anchored
 * to absolute seconds (`MINIMUM_BUFFER_S`).
 */
export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private bola_: BolaScorer | null = null;
  private activeDriver_: ActiveDriver = "throughput";

  constructor(player: Player) {
    this.player_ = player;
    const abr = player.getConfig().abr;
    this.throughput_ = new ThroughputEstimator(abr);
    this.timer_ = new Timer(() => this.evaluate_());

    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);

    const media = player.getMedia();
    if (media) {
      this.bola_ = new BolaScorer(player, media);
    }

    this.timer_.tickEvery(abr.evaluationInterval);
  }

  /**
   * Returns the current throughput estimate in bits/second. Falls
   * back to `config.abr.defaultBandwidthEstimate` while the EWMA is
   * undersampled — consumers always get a number.
   */
  getThroughputEstimate(): number {
    const abr = this.player_.getConfig().abr;
    return this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.bola_?.destroy();
    this.bola_ = null;
  }

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type !== NetworkRequestType.SEGMENT) {
      return;
    }
    const { durationSec, arrayBuffer } = event.response;
    this.throughput_.sample(durationSec, arrayBuffer.byteLength);
  };

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.bola_?.destroy();
    this.bola_ = new BolaScorer(this.player_, event.media);
  };

  private onMediaDetaching_ = (_event: MediaDetachingEvent) => {
    this.bola_?.destroy();
    this.bola_ = null;
  };

  private evaluate_() {
    const streams = this.player_.getStreams(MediaType.VIDEO);
    if (streams.length === 0) {
      return;
    }
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
    this.updateActiveDriver_();

    let pick: VideoStream | null = null;
    if (this.activeDriver_ === "bola" && this.bola_) {
      pick = this.bola_.getRecommendedStream();
    }
    if (!pick) {
      pick = this.pickFromThroughput_();
    }

    if (pick && pick !== activeStream) {
      log.info("Decision", pick);
      this.player_.emit(Events.ADAPTATION, { stream: pick });
    }
  }

  private updateActiveDriver_() {
    const fullness = this.player_.getBufferFullness();
    const fbl = this.player_.getConfig().frontBufferLength;
    const lowMark = MINIMUM_BUFFER_S / fbl;
    const highMark = (MINIMUM_BUFFER_S * 2) / fbl;
    if (fullness < lowMark) {
      this.activeDriver_ = "throughput";
    } else if (fullness > highMark) {
      this.activeDriver_ = "bola";
    }
    // Otherwise: stay in current state (hysteresis dead zone).
  }

  private pickFromThroughput_(): VideoStream | null {
    const streams = this.player_.getStreams(MediaType.VIDEO);
    const active = this.player_.getActiveStream(MediaType.VIDEO);
    const abr = this.player_.getConfig().abr;
    const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

    let best: VideoStream | null = null;
    for (const stream of streams) {
      let scaled = bw;
      if (active) {
        scaled *= stream.bandwidth > active.bandwidth
          ? abr.bandwidthUpgradeTarget
          : abr.bandwidthDowngradeTarget;
      }
      if (stream.bandwidth <= scaled) {
        best = stream;
      }
    }
    return best ?? streams[0] ?? null;
  }
}
```

- [ ] **Step 5.4: Add `getThroughputEstimate()` to Player**

In `packages/cmaf-lite/lib/player.ts`, add the method on `Player` (near `getBufferFullness`):

```ts
/**
 * Returns the current throughput estimate in bits/second. Always
 * returns a number — the configured default
 * (`config.abr.defaultBandwidthEstimate`) is applied while the
 * estimator is still undersampled.
 *
 * @public
 */
getThroughputEstimate(): number {
  return this.abrController_.getThroughputEstimate();
}
```

- [ ] **Step 5.5: Delete the old EWMA files**

```bash
rm packages/cmaf-lite/lib/abr/ewma.ts \
   packages/cmaf-lite/lib/abr/ewma_bandwidth_estimator.ts
```

- [ ] **Step 5.6: Run tsc to confirm everything compiles**

```bash
cd packages/cmaf-lite && pnpm tsc
```

Expected: no type errors. (The new controller imports only `ThroughputEstimator` and `BolaScorer`, not the deleted files.)

- [ ] **Step 5.7: Run the controller test from Step 5.1**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/abr_controller.test.ts
```

Expected: PASS — "constructs and destroys without errors".

- [ ] **Step 5.8: Add `ADAPTATION` emission test using fake timers**

Append to `packages/cmaf-lite/test/abr/abr_controller.test.ts`:

```ts
  it("emits ADAPTATION on the eval timer tick when the pick changes", () => {
    vi.useFakeTimers();

    const cfg = configWith({ minTotalBytes: 1_000, evaluationInterval: 1 });
    player.setConfig(cfg);
    // Active is the highest stream; default estimate (1 Mbps) only fits
    // the lowest. With buffer below lowMark, throughput drives. The pick
    // is a downgrade to streams[0].
    player.setActiveVideoStream(streams[2]!);
    player.setBufferFullness(0);

    const adaptations: VideoStream[] = [];
    player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));

    const controller = new AbrController(player as never);

    // Advance the eval timer one tick.
    vi.advanceTimersByTime(1100);

    expect(adaptations).toContain(streams[0]);
    controller.destroy();
    vi.useRealTimers();
  });

  it("does not emit ADAPTATION when the pick equals the active stream", () => {
    vi.useFakeTimers();

    const cfg = configWith({ minTotalBytes: 1_000, evaluationInterval: 1 });
    player.setConfig(cfg);
    player.setActiveVideoStream(streams[0]!);
    player.setBufferFullness(0);

    const adaptations: VideoStream[] = [];
    player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));

    const controller = new AbrController(player as never);
    vi.advanceTimersByTime(1100);

    expect(adaptations).toHaveLength(0);
    controller.destroy();
    vi.useRealTimers();
  });
```

- [ ] **Step 5.9: Add `getThroughputEstimate` tests**

Append:

```ts
  it("getThroughputEstimate returns default when undersampled", () => {
    const controller = new AbrController(player as never);
    expect(controller.getThroughputEstimate()).toBe(
      DEFAULT_CONFIG.abr.defaultBandwidthEstimate,
    );
    controller.destroy();
  });

  it("forwards segment NETWORK_RESPONSE to the estimator", () => {
    const cfg = configWith({ minTotalBytes: 1_000 });
    player.setConfig(cfg);
    const controller = new AbrController(player as never);

    // Emit one segment response large enough to clear the threshold.
    player.emit(Events.NETWORK_RESPONSE, {
      type: NetworkRequestType.SEGMENT,
      response: {
        durationSec: 1,
        arrayBuffer: new ArrayBuffer(2_000),
        url: "x",
        status: 200,
        headers: new Headers(),
      } as never,
    });

    // After one sample of 2 KB / 1s = 16 kbps, estimator returns a number
    // (no longer null), so getThroughputEstimate is the EWMA, not the
    // default.
    const estimate = controller.getThroughputEstimate();
    expect(estimate).not.toBe(cfg.abr.defaultBandwidthEstimate);
    expect(estimate).toBeGreaterThan(0);
    controller.destroy();
  });

  it("ignores non-segment NETWORK_RESPONSE", () => {
    const cfg = configWith({ minTotalBytes: 1_000 });
    player.setConfig(cfg);
    const controller = new AbrController(player as never);

    player.emit(Events.NETWORK_RESPONSE, {
      type: NetworkRequestType.MANIFEST,
      response: {
        durationSec: 1,
        arrayBuffer: new ArrayBuffer(2_000),
        url: "x",
        status: 200,
        headers: new Headers(),
      } as never,
    });

    expect(controller.getThroughputEstimate()).toBe(
      cfg.abr.defaultBandwidthEstimate,
    );
    controller.destroy();
  });
```

- [ ] **Step 5.10: Add BolaScorer lifecycle test**

Append:

```ts
  it("creates BolaScorer on MEDIA_ATTACHED, destroys on MEDIA_DETACHING", () => {
    const controller = new AbrController(player as never);
    const media = document.createElement("video");
    const mediaSource = {} as MediaSource;

    // Spy on player.off to confirm BolaScorer's listener cleanup happens.
    const offSpy = vi.spyOn(player, "off");

    player.emit(Events.MEDIA_ATTACHED, { media, mediaSource });
    // BolaScorer listens for BUFFER_APPENDED and BUFFER_FLUSHED — those
    // listener bindings happened in the BolaScorer constructor.

    player.emit(Events.MEDIA_DETACHING, { media });
    // BolaScorer.destroy() runs — should off() the two buffer events.
    expect(offSpy).toHaveBeenCalledWith(Events.BUFFER_APPENDED, expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith(Events.BUFFER_FLUSHED, expect.any(Function));

    controller.destroy();
  });
```

- [ ] **Step 5.11: Run all controller tests**

```bash
cd packages/cmaf-lite && pnpm vitest run test/abr/abr_controller.test.ts
```

Expected: PASS — five tests.

- [ ] **Step 5.12: Run the full suite + tsc**

```bash
cd packages/cmaf-lite && pnpm test && pnpm tsc
```

Expected: all green. (If any other tests broke, they relied on the removed `AbrController.getBufferLevel` or `EwmaBandwidthEstimator` — fix the call sites before continuing.)

- [ ] **Step 5.13: Commit**

```bash
git add packages/cmaf-lite/lib/abr/abr_controller.ts \
        packages/cmaf-lite/lib/player.ts \
        packages/cmaf-lite/test/abr/abr_controller.test.ts
git rm packages/cmaf-lite/lib/abr/ewma.ts \
       packages/cmaf-lite/lib/abr/ewma_bandwidth_estimator.ts
git commit -m "$(cat <<'EOF'
feat(abr): rewrite AbrController around dual drivers + buffer hysteresis

- Replace four-rule min-merge with explicit Throughput / BOLA driver
  selection via a buffer-fullness hysteresis anchored to BOLA's
  MINIMUM_BUFFER_S (10s). One driver active per evaluation; BOLA
  falls back to throughput when its trust gate is closed.
- Throughput-pick logic stays inline (audio-free; just bandwidth +
  upgrade/downgrade factors).
- Drop InsufficientBuffer (subsumed by throughput-pick at low buffer),
  DroppedFrames (separate concern; restored in a follow-up).
- BolaScorer lifecycle tied to media attachment (MEDIA_ATTACHED /
  MEDIA_DETACHING).
- Add Player.getThroughputEstimate() — delegates to the controller,
  always returns a number.
- Delete lib/abr/ewma.ts and lib/abr/ewma_bandwidth_estimator.ts;
  their math lives in lib/abr/throughput_estimator.ts now.
EOF
)"
```

---

## Task 6: Update `docs/abr.md`

**Files:**
- Modify: `packages/cmaf-lite/docs/abr.md`

- [ ] **Step 6.1: Read the current `docs/abr.md`**

```bash
cat packages/cmaf-lite/docs/abr.md
```

(Read for context. The current doc describes four rules + min-merge. We rewrite it around drivers.)

- [ ] **Step 6.2: Replace the contents**

Overwrite `packages/cmaf-lite/docs/abr.md`:

```markdown
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
```

- [ ] **Step 6.3: Commit**

```bash
git add packages/cmaf-lite/docs/abr.md
git commit -m "docs: rewrite abr.md around drivers + hysteresis"
```

---

## Task 7: Update `docs/DESIGN.md`

**Files:**
- Modify: `packages/cmaf-lite/docs/DESIGN.md`

- [ ] **Step 7.1: Find the AbrController paragraph**

```bash
grep -n "AbrController" packages/cmaf-lite/docs/DESIGN.md
```

- [ ] **Step 7.2: Replace the AbrController paragraph**

Find this paragraph in `packages/cmaf-lite/docs/DESIGN.md`:

```markdown
### AbrController

Evaluates four independent rules (throughput, BOLA,
insufficient buffer, dropped frames) on a configurable
interval. Picks the most conservative result. See
[abr.md](abr.md) for details.
```

Replace with:

```markdown
### AbrController

Selects one of two drivers per evaluation tick — Throughput (dual
EWMA) or BOLA (buffer utility) — via a buffer-fullness hysteresis.
Owns the eval loop, the throughput-pick algorithm, and the
`BolaScorer` lifecycle. See [abr.md](abr.md) for details.
```

- [ ] **Step 7.3: Commit**

```bash
git add packages/cmaf-lite/docs/DESIGN.md
git commit -m "docs(DESIGN): update AbrController paragraph for dual-driver model"
```

---

## Task 8: Final verification

- [ ] **Step 8.1: Run the full test suite**

```bash
cd packages/cmaf-lite && pnpm test
```

Expected: all tests pass. Note that any tests previously checking the four-rule behavior should already be passing or removed because we never created old-shape ABR tests in `test/abr/`. If there are integration tests elsewhere that broke, fix them now.

- [ ] **Step 8.2: Run type check**

```bash
cd packages/cmaf-lite && pnpm tsc
```

Expected: no type errors.

- [ ] **Step 8.3: Run lint/format**

```bash
cd packages/cmaf-lite && pnpm check
```

Expected: no biome issues. If any: `pnpm format` to auto-fix, then re-check.

- [ ] **Step 8.4: Build to confirm no bundling issues**

```bash
cd packages/cmaf-lite && pnpm build
```

Expected: clean build.

- [ ] **Step 8.5: Smoke-test the demo**

```bash
cd /Users/matvp/Development/cmaf-lite && pnpm dev
```

In a browser: load the demo, play a manifest, observe (via DevTools or `Player.getThroughputEstimate()`) that throughput updates over time and that quality changes happen. Pause, seek; the BolaScorer's gate should re-arm and re-engage as expected. Stop the dev server.

This is a manual smoke test — explicitly call out if the UI affordances aren't there to verify the new APIs end-to-end.

- [ ] **Step 8.6: Final commit if any lint/format fixes**

If `pnpm check` produced auto-fixes, commit them:

```bash
git add -u
git commit -m "chore: format/lint after ABR refactor"
```

---

## Verification Checklist

After all tasks complete, the project should satisfy:

- ✅ `lib/abr/` contains exactly `abr_controller.ts`, `bola_scorer.ts`, `throughput_estimator.ts`. No `ewma.ts` or `ewma_bandwidth_estimator.ts`.
- ✅ `Player` exposes `getBufferFullness(): number` and `getThroughputEstimate(): number`.
- ✅ `AbrController.getBufferLevel` is gone; `AbrController` exposes only `destroy()` and `getThroughputEstimate()`.
- ✅ `lib/index.ts` exports do **not** include `AbrController` (verify `grep "AbrController" lib/index.ts` returns nothing).
- ✅ `pnpm test`, `pnpm tsc`, `pnpm check`, `pnpm build` all green.
- ✅ `docs/abr.md` and `docs/DESIGN.md` reflect the new model.
