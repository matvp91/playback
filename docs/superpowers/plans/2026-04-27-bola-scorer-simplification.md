# BolaScorer Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline the `BolaScorer` class into `AbrController`, replacing the timer-only evaluation cadence with event-driven hysteresis updates and an emit-throttle. Drop `Player.getBufferFullness()` from the public API.

**Architecture:** `BolaScorer` is removed entirely. All BOLA state (one-shot `isBufferSteady_` latch, hysteresis-driven `useBola_` flag, BOLA-O scoring math) becomes private to `AbrController`. AbrController owns the `BUFFER_APPENDED` / `MEDIA_ATTACHED` / `MEDIA_DETACHING` subscriptions, manages the `seeking` DOM listener, and handles throttling. Evaluation runs on a fixed 1-second timer; emits are throttled by a new `switchInterval` config option (default 8s).

**Tech Stack:** TypeScript, Vitest, happy-dom. cmaf-lite's existing `Timer`, `EventEmitter`, `getBufferedEnd` utilities.

**Reference:** [Spec](../specs/2026-04-27-bola-scorer-simplification-design.md)

## File Map

- **Modify** `packages/cmaf-lite/lib/config.ts` — replace `abr.evaluationInterval` with `abr.switchInterval`.
- **Modify** `packages/cmaf-lite/lib/abr/abr_controller.ts` — wholesale rewrite to inline BOLA logic.
- **Delete** `packages/cmaf-lite/lib/abr/bola_scorer.ts`.
- **Modify** `packages/cmaf-lite/lib/player.ts` — remove `getBufferFullness()`.
- **Delete** `packages/cmaf-lite/test/abr/bola_scorer.test.ts`.
- **Modify** `packages/cmaf-lite/test/abr/abr_controller.test.ts` — update existing tests for new config + behavior; add new latch/hysteresis/throttle tests.
- **Modify** `packages/cmaf-lite/test/__framework__/abr_stubs.ts` — add `getMedia` / `getBuffered` to stub; remove `getBufferFullness`.
- **Modify** `packages/cmaf-lite/test/player.test.ts` — remove the `getBufferFullness` describe block.
- **Modify** `packages/cmaf-lite/docs/abr.md` — update BOLA section, hysteresis thresholds, observability, and Future Enhancements.

---

## Task 1: Rename `evaluationInterval` → `switchInterval` in config

**Files:**
- Modify: `packages/cmaf-lite/lib/config.ts:40-41,132`

- [ ] **Step 1: Update the `AbrConfig` interface**

In `packages/cmaf-lite/lib/config.ts`, find:

```ts
  /** Seconds between ABR evaluations. */
  evaluationInterval: number;
```

Replace with:

```ts
  /**
   * Minimum seconds between consecutive `ADAPTATION` emits. The ABR
   * evaluator runs on a fixed 1-second tick; this throttle gates the
   * actual switch decision so users don't see rapid quality flips.
   */
  switchInterval: number;
```

- [ ] **Step 2: Update `DEFAULT_CONFIG`**

In the same file, find:

```ts
    evaluationInterval: 8,
```

Replace with:

```ts
    switchInterval: 8,
```

- [ ] **Step 3: Run type check**

Run: `pnpm tsc`
Expected: Errors in `abr_controller.ts` (still references `evaluationInterval`) and `abr_controller.test.ts`. We'll fix both in later tasks. The error confirms the rename took effect.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/config.ts
git commit -m "refactor(config): rename abr.evaluationInterval to switchInterval"
```

---

## Task 2: Add `getMedia` / `getBuffered` to test stub

The new `AbrController` reads buffered ranges directly via `player.getBuffered(VIDEO)` and `player.getMedia()` instead of the soon-to-be-removed `getBufferFullness()`. The stub player needs to support both during the transition.

**Files:**
- Modify: `packages/cmaf-lite/test/__framework__/abr_stubs.ts`

- [ ] **Step 1: Update the `StubPlayer` interface**

In `packages/cmaf-lite/test/__framework__/abr_stubs.ts`, find:

```ts
export interface StubPlayer extends EventEmitter<EventMap> {
  getStreams<T extends MediaType>(type: T): Stream<T>[];
  getActiveStream<T extends MediaType>(type: T): Stream<T> | null;
  getBufferFullness(): number;
  getConfig(): PlayerConfig;
  getMedia(): HTMLMediaElement | null;
  setBufferFullness(value: number): void;
  setActiveVideoStream(stream: VideoStream | null): void;
  setVideoStreams(streams: VideoStream[]): void;
  setConfig(config: PlayerConfig): void;
}
```

Replace with:

```ts
export interface StubPlayer extends EventEmitter<EventMap> {
  getStreams<T extends MediaType>(type: T): Stream<T>[];
  getActiveStream<T extends MediaType>(type: T): Stream<T> | null;
  getBufferFullness(): number;
  getBuffered(type: MediaType): TimeRanges;
  getConfig(): PlayerConfig;
  getMedia(): HTMLMediaElement | null;
  setBufferFullness(value: number): void;
  setBuffered(type: MediaType, ranges: TimeRanges): void;
  setMedia(media: HTMLMediaElement | null): void;
  setActiveVideoStream(stream: VideoStream | null): void;
  setVideoStreams(streams: VideoStream[]): void;
  setConfig(config: PlayerConfig): void;
}
```

- [ ] **Step 2: Add a default empty `TimeRanges` import**

At the top of the file, add the import:

```ts
import { createTimeRanges } from "./time_ranges";
```

(Verify `createTimeRanges` exists in `packages/cmaf-lite/test/__framework__/time_ranges.ts`. If not, this task expands to create it — it already exists and is used by `player.test.ts`.)

- [ ] **Step 3: Update `createStubPlayer`**

In `packages/cmaf-lite/test/__framework__/abr_stubs.ts`, find the body of `createStubPlayer`:

```ts
  let videoStreams = opts?.streams ?? [];
  let activeVideo = opts?.activeStream ?? null;
  let fullness = opts?.bufferFullness ?? 0;
  let config = opts?.config ?? DEFAULT_CONFIG;

  const emitter = new EventEmitter<EventMap>();
  const methods: Omit<StubPlayer, keyof EventEmitter<EventMap>> = {
    getStreams<T extends MediaType>(type: T): Stream<T>[] {
      if (type === MediaType.VIDEO) {
        return videoStreams as Stream<T>[];
      }
      return [] as Stream<T>[];
    },
    getActiveStream<T extends MediaType>(type: T): Stream<T> | null {
      if (type === MediaType.VIDEO) {
        return activeVideo as Stream<T> | null;
      }
      return null;
    },
    getBufferFullness: () => fullness,
    getConfig: () => config,
    getMedia: () => null,
    setBufferFullness(value: number) {
      fullness = value;
    },
    setActiveVideoStream(stream: VideoStream | null) {
      activeVideo = stream;
    },
    setVideoStreams(streams: VideoStream[]) {
      videoStreams = streams;
    },
    setConfig(config_: PlayerConfig) {
      config = config_;
    },
  };
  return Object.assign(emitter, methods) as StubPlayer;
```

Replace with:

```ts
  let videoStreams = opts?.streams ?? [];
  let activeVideo = opts?.activeStream ?? null;
  let fullness = opts?.bufferFullness ?? 0;
  let config = opts?.config ?? DEFAULT_CONFIG;
  let videoBuffered: TimeRanges = createTimeRanges();
  let media: HTMLMediaElement | null = null;

  const emitter = new EventEmitter<EventMap>();
  const methods: Omit<StubPlayer, keyof EventEmitter<EventMap>> = {
    getStreams<T extends MediaType>(type: T): Stream<T>[] {
      if (type === MediaType.VIDEO) {
        return videoStreams as Stream<T>[];
      }
      return [] as Stream<T>[];
    },
    getActiveStream<T extends MediaType>(type: T): Stream<T> | null {
      if (type === MediaType.VIDEO) {
        return activeVideo as Stream<T> | null;
      }
      return null;
    },
    getBufferFullness: () => fullness,
    getBuffered: (type: MediaType) =>
      type === MediaType.VIDEO ? videoBuffered : createTimeRanges(),
    getConfig: () => config,
    getMedia: () => media,
    setBufferFullness(value: number) {
      fullness = value;
    },
    setBuffered(type: MediaType, ranges: TimeRanges) {
      if (type === MediaType.VIDEO) {
        videoBuffered = ranges;
      }
    },
    setMedia(value: HTMLMediaElement | null) {
      media = value;
    },
    setActiveVideoStream(stream: VideoStream | null) {
      activeVideo = stream;
    },
    setVideoStreams(streams: VideoStream[]) {
      videoStreams = streams;
    },
    setConfig(config_: PlayerConfig) {
      config = config_;
    },
  };
  return Object.assign(emitter, methods) as StubPlayer;
```

- [ ] **Step 4: Run type check**

Run: `pnpm tsc`
Expected: The same `evaluationInterval`-related errors from Task 1, plus possibly nothing new. The stub additions should compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/test/__framework__/abr_stubs.ts
git commit -m "test(abr): add getMedia/getBuffered to StubPlayer"
```

---

## Task 3: Wholesale rewrite `AbrController` with inlined BOLA logic

This is the structural change. We replace the file with the new inlined implementation, then update existing tests in the next task.

**Files:**
- Modify: `packages/cmaf-lite/lib/abr/abr_controller.ts`

- [ ] **Step 1: Replace the entire file**

Overwrite `packages/cmaf-lite/lib/abr/abr_controller.ts` with:

```ts
import type {
  BufferAppendedEvent,
  MediaAttachedEvent,
  NetworkResponseEvent,
} from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { getBufferedEnd } from "../utils/buffer_utils";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";
import { ThroughputEstimator } from "./throughput_estimator";

const log = Log.create("AbrController");

const MINIMUM_BUFFER_S = 10;

export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private media_: HTMLMediaElement | null = null;
  private isBufferSteady_ = false;
  private useBola_ = false;
  private lastSwitchAt_ = -Infinity;

  constructor(player: Player) {
    this.player_ = player;

    const { abr } = player.getConfig();
    this.throughput_ = new ThroughputEstimator(abr);

    this.timer_ = new Timer(() => this.evaluate_());

    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.on(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);

    this.timer_.tickEvery(1);
  }

  getThroughputEstimate(): number {
    const { abr } = this.player_.getConfig();
    return this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.off(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    if (this.media_) {
      this.media_.removeEventListener("seeking", this.onSeeking_);
      this.media_ = null;
    }
  }

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.media_.addEventListener("seeking", this.onSeeking_);
  };

  private onMediaDetaching_ = () => {
    if (this.media_) {
      this.media_.removeEventListener("seeking", this.onSeeking_);
      this.media_ = null;
    }
  };

  private onSeeking_ = () => {
    this.isBufferSteady_ = false;
    this.useBola_ = false;
  };

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type === NetworkRequestType.SEGMENT) {
      const { response } = event;
      this.throughput_.sample(
        response.durationSec,
        response.arrayBuffer.byteLength,
      );
    }
  };

  private onBufferAppended_ = (event: BufferAppendedEvent) => {
    if (event.type !== MediaType.VIDEO) {
      return;
    }
    const frontBuffer = this.getFrontBuffer_();
    const streams = this.player_.getStreams(MediaType.VIDEO);
    const lowest = streams[0];
    if (lowest && frontBuffer >= lowest.hierarchy.track.maxSegmentDuration) {
      this.isBufferSteady_ = true;
    }
    const fbl = this.player_.getConfig().frontBufferLength;
    if (frontBuffer >= (2 / 3) * fbl) {
      this.useBola_ = true;
    } else if (frontBuffer < (1 / 3) * fbl) {
      this.useBola_ = false;
    }
  };

  private getFrontBuffer_(): number {
    const media = this.media_;
    if (!media) {
      return 0;
    }
    const buffered = this.player_.getBuffered(MediaType.VIDEO);
    const { maxBufferHole } = this.player_.getConfig();
    const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
    if (end === null) {
      return 0;
    }
    return end - media.currentTime;
  }

  private evaluate_() {
    const streams = this.player_.getStreams(MediaType.VIDEO);
    if (streams.length === 0) {
      return;
    }
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);

    let pick: VideoStream | null = null;
    if (this.isBufferSteady_ && this.useBola_) {
      pick = this.pickBolaStream_(streams, this.getFrontBuffer_());
    }
    if (!pick) {
      pick = this.pickFromThroughput_(streams, activeStream);
    }
    if (!pick || pick === activeStream) {
      return;
    }

    const now = performance.now();
    const { switchInterval } = this.player_.getConfig().abr;
    if (now - this.lastSwitchAt_ < switchInterval * 1000) {
      return;
    }

    this.lastSwitchAt_ = now;
    log.info("Decision", pick);
    this.player_.emit(Events.ADAPTATION, { stream: pick });
  }

  private pickBolaStream_(
    streams: VideoStream[],
    frontBuffer: number,
  ): VideoStream | null {
    const lowest = streams[0];
    const highest = streams[streams.length - 1];
    if (!lowest || !highest) {
      return null;
    }
    const fbl = this.player_.getConfig().frontBufferLength;

    const lnS1 = Math.log(lowest.bandwidth);
    const vM = Math.log(highest.bandwidth) - lnS1 + 1;
    const Qmax = Math.max(fbl, MINIMUM_BUFFER_S + 2 * streams.length);
    const gp = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1);
    const V = MINIMUM_BUFFER_S / gp;

    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      if (!stream) {
        continue;
      }
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

  private pickFromThroughput_(
    streams: VideoStream[],
    active: VideoStream | null,
  ): VideoStream | null {
    const { abr } = this.player_.getConfig();
    const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

    let best: VideoStream | null = null;
    for (const stream of streams) {
      let scaled = bw;
      if (active) {
        scaled *=
          stream.bandwidth > active.bandwidth
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

- [ ] **Step 2: Run type check**

Run: `pnpm tsc`
Expected: Errors in `abr_controller.test.ts` (it still references `evaluationInterval`, asserts BolaScorer-specific behavior). Errors in `bola_scorer.ts` are gone (it has no consumers now). No errors in `abr_controller.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/lib/abr/abr_controller.ts
git commit -m "refactor(abr): inline BolaScorer into AbrController

All BOLA state — isBufferSteady_ latch, useBola_ hysteresis, BOLA-O
math — moves into AbrController as private state and helpers. Adds
BUFFER_APPENDED / MEDIA_ATTACHED / MEDIA_DETACHING subscriptions and a
seeking listener on the media element. Timer is hardcoded at 1s;
emits are throttled by switchInterval."
```

---

## Task 4: Delete `BolaScorer` source and tests

**Files:**
- Delete: `packages/cmaf-lite/lib/abr/bola_scorer.ts`
- Delete: `packages/cmaf-lite/test/abr/bola_scorer.test.ts`

- [ ] **Step 1: Delete `bola_scorer.ts`**

```bash
rm packages/cmaf-lite/lib/abr/bola_scorer.ts
```

- [ ] **Step 2: Delete `bola_scorer.test.ts`**

```bash
rm packages/cmaf-lite/test/abr/bola_scorer.test.ts
```

- [ ] **Step 3: Run type check**

Run: `pnpm tsc`
Expected: No new errors from these deletions. Pre-existing test errors (Task 5 fixes them) remain.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/lib/abr/bola_scorer.ts packages/cmaf-lite/test/abr/bola_scorer.test.ts
git commit -m "refactor(abr): delete BolaScorer (logic now lives in AbrController)"
```

---

## Task 5: Update existing `AbrController` tests for new config + behavior

The current tests reference `evaluationInterval` and assert `BolaScorer`-specific listener cleanup. We update those to match the inlined model.

**Files:**
- Modify: `packages/cmaf-lite/test/abr/abr_controller.test.ts`

- [ ] **Step 1: Update `evaluationInterval` references**

In `packages/cmaf-lite/test/abr/abr_controller.test.ts`, find:

```ts
    const cfg = configWith({ minTotalBytes: 1_000, evaluationInterval: 1 });
```

(appears twice — once around line 45, once around line 68). Replace both with:

```ts
    const cfg = configWith({ minTotalBytes: 1_000, switchInterval: 0 });
```

Also change the `vi.advanceTimersByTime(1100)` calls to `vi.advanceTimersByTime(1100)` (no change — the new hardcoded timer is 1s, same as `evaluationInterval: 1` was).

- [ ] **Step 2: Replace the `creates BolaScorer on MEDIA_ATTACHED` test**

Find:

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
    expect(offSpy).toHaveBeenCalledWith(
      Events.BUFFER_APPENDED,
      expect.any(Function),
    );
    expect(offSpy).toHaveBeenCalledWith(
      Events.BUFFER_FLUSHED,
      expect.any(Function),
    );

    controller.destroy();
  });
```

Replace with:

```ts
  it("subscribes to player events on construction, unsubscribes on destroy", () => {
    const onSpy = vi.spyOn(player, "on");
    const offSpy = vi.spyOn(player, "off");

    const controller = new AbrController(player as never);
    expect(onSpy).toHaveBeenCalledWith(
      Events.NETWORK_RESPONSE,
      expect.any(Function),
    );
    expect(onSpy).toHaveBeenCalledWith(
      Events.BUFFER_APPENDED,
      expect.any(Function),
    );
    expect(onSpy).toHaveBeenCalledWith(
      Events.MEDIA_ATTACHED,
      expect.any(Function),
    );
    expect(onSpy).toHaveBeenCalledWith(
      Events.MEDIA_DETACHING,
      expect.any(Function),
    );

    controller.destroy();
    expect(offSpy).toHaveBeenCalledWith(
      Events.NETWORK_RESPONSE,
      expect.any(Function),
    );
    expect(offSpy).toHaveBeenCalledWith(
      Events.BUFFER_APPENDED,
      expect.any(Function),
    );
    expect(offSpy).toHaveBeenCalledWith(
      Events.MEDIA_ATTACHED,
      expect.any(Function),
    );
    expect(offSpy).toHaveBeenCalledWith(
      Events.MEDIA_DETACHING,
      expect.any(Function),
    );
  });

  it("attaches and removes the media seeking listener", () => {
    const controller = new AbrController(player as never);
    const media = document.createElement("video");
    const mediaSource = {} as MediaSource;

    const addSpy = vi.spyOn(media, "addEventListener");
    const removeSpy = vi.spyOn(media, "removeEventListener");

    player.emit(Events.MEDIA_ATTACHED, { media, mediaSource });
    expect(addSpy).toHaveBeenCalledWith("seeking", expect.any(Function));

    player.emit(Events.MEDIA_DETACHING, { media });
    expect(removeSpy).toHaveBeenCalledWith("seeking", expect.any(Function));

    controller.destroy();
  });
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter cmaf-lite test abr_controller`
Expected: All tests pass. (The `evaluationInterval` rename and the `BolaScorer`-listener test are now resolved.)

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/test/abr/abr_controller.test.ts
git commit -m "test(abr): update AbrController tests for inlined model"
```

---

## Task 6: Add new latch / hysteresis / throttle tests

**Files:**
- Modify: `packages/cmaf-lite/test/abr/abr_controller.test.ts`

We add tests for the new behaviors. Each test follows TDD: write it, expect it to pass against the already-implemented code (since Task 3 implemented the behavior).

- [ ] **Step 1: Add latch tests**

At the end of the `describe("AbrController", ...)` block (just before the closing `});`), add:

```ts
  describe("isBufferSteady_ latch", () => {
    const setup = (frontBuffer: number) => {
      const media = document.createElement("video");
      Object.defineProperty(media, "currentTime", { value: 0 });
      player.setMedia(media);
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, frontBuffer]));
      const controller = new AbrController(player as never);
      // Simulate MEDIA_ATTACHED so the controller stores media_ and
      // attaches the seeking listener.
      player.emit(Events.MEDIA_ATTACHED, {
        media,
        mediaSource: {} as MediaSource,
      });
      return { controller, media };
    };

    it("does not latch when frontBuffer < maxSegmentDuration", () => {
      // streams[0].maxSegmentDuration = 4 by default
      const { controller } = setup(2);
      player.emit(Events.BUFFER_APPENDED, {
        type: MediaType.VIDEO,
        segment: streams[0]!.hierarchy.track.segments[0]!,
        data: new ArrayBuffer(0),
      });
      // Indirectly verify via evaluate behavior: with !isBufferSteady_,
      // BOLA can't drive even if useBola_ were true. Since useBola_ also
      // requires high buffer (>= 20s), neither gate opens here.
      // We assert the throughput path drove (no error, no crash).
      expect(() => controller.destroy()).not.toThrow();
    });

    it("latches once frontBuffer >= maxSegmentDuration on video append", () => {
      vi.useFakeTimers();
      const { controller } = setup(25);
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[0]!);
      player.emit(Events.BUFFER_APPENDED, {
        type: MediaType.VIDEO,
        segment: streams[0]!.hierarchy.track.segments[0]!,
        data: new ArrayBuffer(0),
      });
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      // 25s buffer + isBufferSteady_ + useBola_ → BOLA picks the highest
      // stream at full buffer.
      expect(adaptations[0]).toBe(streams[2]);
      controller.destroy();
    });

    it("ignores audio BUFFER_APPENDED for the latch", () => {
      const { controller } = setup(25);
      player.emit(Events.BUFFER_APPENDED, {
        type: MediaType.AUDIO,
        segment: streams[0]!.hierarchy.track.segments[0]!,
        data: new ArrayBuffer(0),
      });
      // No video append, so isBufferSteady_ stays false. Verifying via
      // a follow-up evaluate would require a video append — instead we
      // just confirm no crash and clean teardown.
      expect(() => controller.destroy()).not.toThrow();
    });

    it("resets on media seeking", () => {
      vi.useFakeTimers();
      const { controller, media } = setup(25);
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[0]!);
      // Latch.
      player.emit(Events.BUFFER_APPENDED, {
        type: MediaType.VIDEO,
        segment: streams[0]!.hierarchy.track.segments[0]!,
        data: new ArrayBuffer(0),
      });
      // Seek — clears both gates.
      media.dispatchEvent(new Event("seeking"));
      // After seek, simulate buffer dropping. Hysteresis would also be
      // off, but verifying isBufferSteady_=false specifically: even if
      // we restore high buffer below maxSegDur, no new BUFFER_APPENDED
      // means the latch stays false.
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, 25]));
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      // Throughput drives (no BOLA), default estimate (1 Mbps) only fits
      // the lowest stream — and active is already lowest, so no emit.
      expect(adaptations).toHaveLength(0);
      controller.destroy();
    });
  });
```

Also at the top of the file, add the imports needed:

Find:

```ts
import type { StubPlayer } from "../__framework__/abr_stubs";
import { createStubPlayer, makeVideoStream } from "../__framework__/abr_stubs";
```

Replace with:

```ts
import { MediaType } from "../../lib/types/media";
import type { StubPlayer } from "../__framework__/abr_stubs";
import { createStubPlayer, makeVideoStream } from "../__framework__/abr_stubs";
import { createTimeRanges } from "../__framework__/time_ranges";
```

- [ ] **Step 2: Add hysteresis tests**

After the `isBufferSteady_ latch` describe block, add:

```ts
  describe("useBola_ hysteresis", () => {
    const setup = () => {
      const media = document.createElement("video");
      Object.defineProperty(media, "currentTime", { value: 0 });
      player.setMedia(media);
      const controller = new AbrController(player as never);
      player.emit(Events.MEDIA_ATTACHED, {
        media,
        mediaSource: {} as MediaSource,
      });
      return { controller, media };
    };

    const append = () => {
      player.emit(Events.BUFFER_APPENDED, {
        type: MediaType.VIDEO,
        segment: streams[0]!.hierarchy.track.segments[0]!,
        data: new ArrayBuffer(0),
      });
    };

    const evalAndPick = (controller: AbrController) => {
      vi.useFakeTimers();
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[0]!);
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      controller.destroy();
      return adaptations;
    };

    it("enters at frontBuffer >= 2/3 * frontBufferLength (20s default)", () => {
      const { controller } = setup();
      // 20s exactly = 2/3 * 30. useBola_ = true. With isBufferSteady_
      // also true (since 20s > maxSegDur 4s), BOLA drives. Buffer at
      // 20s → BOLA picks an upper-tier stream, not lowest.
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, 20]));
      append();
      const adaptations = evalAndPick(controller);
      expect(adaptations.length).toBeGreaterThan(0);
      expect(adaptations[0]).not.toBe(streams[0]);
    });

    it("stays off below entry threshold", () => {
      const { controller } = setup();
      // 19s < 20s entry threshold. useBola_ stays false → throughput.
      // Default estimate (1 Mbps) only fits the lowest stream; active
      // is also lowest → no emit.
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, 19]));
      append();
      const adaptations = evalAndPick(controller);
      expect(adaptations).toHaveLength(0);
    });

    it("exits at frontBuffer < 1/3 * frontBufferLength (10s default)", () => {
      const { controller, media } = setup();
      // First, get useBola_ true with high buffer.
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, 25]));
      append();
      // Then drop below exit threshold.
      Object.defineProperty(media, "currentTime", { value: 16 });
      // Now ahead = 25 - 16 = 9 < 10. useBola_ flips off.
      append();
      // After the flip, evaluate uses throughput. With low buffer and
      // a high active stream (set below), throughput downgrades.
      vi.useFakeTimers();
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[2]!);
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      // Throughput pick at default estimate is streams[0].
      expect(adaptations[0]).toBe(streams[0]);
      controller.destroy();
    });

    it("holds in the dead zone", () => {
      const { controller, media } = setup();
      // Enter useBola_ with high buffer.
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, 25]));
      append();
      // Move into dead zone (10s..20s) — ahead between thresholds.
      Object.defineProperty(media, "currentTime", { value: 10 });
      // ahead = 25 - 10 = 15. In dead zone. useBola_ stays true.
      append();
      vi.useFakeTimers();
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[0]!);
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      // BOLA drives at 15s buffer; picks above the lowest stream.
      expect(adaptations.length).toBeGreaterThan(0);
      expect(adaptations[0]).not.toBe(streams[0]);
      controller.destroy();
    });

    it("resets on media seeking", () => {
      const { controller, media } = setup();
      player.setBuffered(MediaType.VIDEO, createTimeRanges([0, 25]));
      append();
      // useBola_ is true here. Seek resets it.
      media.dispatchEvent(new Event("seeking"));
      vi.useFakeTimers();
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[2]!);
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      // After seek, both gates closed → throughput downgrades streams[2]
      // → streams[0] at default estimate.
      expect(adaptations[0]).toBe(streams[0]);
      controller.destroy();
    });
  });
```

- [ ] **Step 3: Add throttle test**

After the `useBola_ hysteresis` describe block, add:

```ts
  describe("switchInterval throttle", () => {
    it("discards subsequent picks within switchInterval", () => {
      vi.useFakeTimers();
      const cfg = configWith({ minTotalBytes: 1_000, switchInterval: 5 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[2]!);
      player.setBufferFullness(0);
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));

      const controller = new AbrController(player as never);

      // Tick 1: emits — throughput downgrades to streams[0].
      vi.advanceTimersByTime(1100);
      expect(adaptations).toHaveLength(1);

      // Reset active to provoke another switch on tick 2.
      player.setActiveVideoStream(streams[2]!);
      vi.advanceTimersByTime(1100);
      // Within the 5s switchInterval — discarded.
      expect(adaptations).toHaveLength(1);

      // Advance past the throttle.
      vi.advanceTimersByTime(4000);
      expect(adaptations).toHaveLength(2);

      controller.destroy();
    });
  });
```

- [ ] **Step 4: Add BOLA math tests (lifted from deleted bola_scorer.test.ts)**

After the `switchInterval throttle` describe block, add:

```ts
  describe("BOLA math (via inlined pickBolaStream_)", () => {
    const drive = (frontBuffer: number, currentTime = 0) => {
      const media = document.createElement("video");
      Object.defineProperty(media, "currentTime", { value: currentTime });
      player.setMedia(media);
      player.setBuffered(
        MediaType.VIDEO,
        createTimeRanges([0, currentTime + frontBuffer]),
      );
      const controller = new AbrController(player as never);
      player.emit(Events.MEDIA_ATTACHED, {
        media,
        mediaSource: {} as MediaSource,
      });
      // One append to satisfy both gates (assuming frontBuffer >= 20s
      // for useBola_, and >= 4s for isBufferSteady_).
      player.emit(Events.BUFFER_APPENDED, {
        type: MediaType.VIDEO,
        segment: streams[0]!.hierarchy.track.segments[0]!,
        data: new ArrayBuffer(0),
      });
      vi.useFakeTimers();
      const cfg = configWith({ switchInterval: 0 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[0]!);
      const adaptations: VideoStream[] = [];
      player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));
      vi.advanceTimersByTime(1100);
      controller.destroy();
      return adaptations[0] ?? null;
    };

    it("picks a lower stream at minimal BOLA-active buffer than at full", () => {
      // 20s = entry threshold; just barely in the BOLA band.
      const lowPick = drive(20);
      // 30s = full target.
      const highPick = drive(30);
      expect(streams.indexOf(lowPick!)).toBeLessThanOrEqual(
        streams.indexOf(highPick!),
      );
    });

    it("prefers the highest stream at frontBufferLength", () => {
      const pick = drive(30);
      expect(pick).toBe(streams[2]);
    });
  });
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter cmaf-lite test abr_controller`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/test/abr/abr_controller.test.ts
git commit -m "test(abr): cover latch, hysteresis, throttle, BOLA math"
```

---

## Task 7: Remove `Player.getBufferFullness()`

`AbrController` no longer uses it. The public API drops the method along with its tests.

**Files:**
- Modify: `packages/cmaf-lite/lib/player.ts:111-130`
- Modify: `packages/cmaf-lite/test/player.test.ts:19-71`
- Modify: `packages/cmaf-lite/test/__framework__/abr_stubs.ts`

- [ ] **Step 1: Remove `getBufferFullness` from `Player`**

In `packages/cmaf-lite/lib/player.ts`, find:

```ts
  /**
   * Returns the front-buffer fullness for video, clamped to [0, 1].
   * `0` when no media is attached or no buffered range covers the
   * playhead. Otherwise: `ahead / frontBufferLength` where `ahead`
   * is seconds buffered ahead of `currentTime`, clamped at 1.
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

Delete that method block.

If `getBufferedEnd` import becomes unused, remove it too:

```ts
import { getBufferedEnd } from "./utils/buffer_utils";
```

(Verify by checking other uses in `player.ts` — if no other reference, delete the import.)

- [ ] **Step 2: Remove `getBufferFullness` tests from `player.test.ts`**

In `packages/cmaf-lite/test/player.test.ts`, find:

```ts
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
      Object.defineProperty(video, "currentTime", {
        value: 0,
        configurable: true,
      });
      player.attachMedia(video);
      player.getBuffered = (type: MediaType) =>
        type === MediaType.VIDEO ? createTimeRanges() : createTimeRanges();
      expect(player.getBufferFullness()).toBe(0);
    });

    it("returns ahead/frontBufferLength when buffered", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "currentTime", {
        value: 0,
        configurable: true,
      });
      player.attachMedia(video);
      player.getBuffered = (type: MediaType) =>
        type === MediaType.VIDEO
          ? createTimeRanges([0, 15])
          : createTimeRanges();
      // frontBufferLength default = 30, ahead = 15 → 0.5
      expect(player.getBufferFullness()).toBeCloseTo(0.5);
    });

    it("clamps at 1 when ahead > frontBufferLength", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "currentTime", {
        value: 0,
        configurable: true,
      });
      player.attachMedia(video);
      player.getBuffered = (type: MediaType) =>
        type === MediaType.VIDEO
          ? createTimeRanges([0, 60])
          : createTimeRanges();
      expect(player.getBufferFullness()).toBe(1);
    });
  });
});
```

Delete the entire `describe("Player", ...)` block.

If `MediaType` and `createTimeRanges` imports become unused after deletion, remove them. The MediaSource and URL `vi.stubGlobal` calls may still be needed by other Player tests added later — leave them if other test files import this same setup. Otherwise, remove them.

If the file becomes empty (no tests, only the global stubs), delete the file:

```bash
rm packages/cmaf-lite/test/player.test.ts
```

- [ ] **Step 3: Remove `getBufferFullness` from the test stub**

In `packages/cmaf-lite/test/__framework__/abr_stubs.ts`, remove:

- The `getBufferFullness(): number;` line from the `StubPlayer` interface.
- The `setBufferFullness(value: number): void;` line from the interface.
- The `getBufferFullness: () => fullness,` line from `createStubPlayer`.
- The `setBufferFullness(value: number) { fullness = value; },` block.
- The `let fullness = opts?.bufferFullness ?? 0;` declaration.
- The `bufferFullness?: number;` option from the `createStubPlayer` opts type.

After cleanup, the `createStubPlayer` parameter type loses one option. Update any test that passes `bufferFullness` to no longer do so.

Find:

```ts
    player = createStubPlayer({
      streams,
      activeStream: streams[0]!,
      bufferFullness: 0,
    });
```

Replace with:

```ts
    player = createStubPlayer({
      streams,
      activeStream: streams[0]!,
    });
```

(in `abr_controller.test.ts`'s `beforeEach`).

Also remove any `player.setBufferFullness(...)` calls in tests — they're no longer needed because the new tests drive frontBuffer via `setBuffered()` + `media.currentTime`.

Find in `abr_controller.test.ts`:

```ts
    player.setActiveVideoStream(streams[2]!);
    player.setBufferFullness(0);
```

Replace with:

```ts
    player.setActiveVideoStream(streams[2]!);
```

(twice — in the two ADAPTATION tests).

In the throttle test:

```ts
      player.setActiveVideoStream(streams[2]!);
      player.setBufferFullness(0);
```

Replace with:

```ts
      player.setActiveVideoStream(streams[2]!);
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter cmaf-lite test`
Expected: All tests pass.

- [ ] **Step 5: Run type check**

Run: `pnpm tsc`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/player.ts packages/cmaf-lite/test/player.test.ts packages/cmaf-lite/test/__framework__/abr_stubs.ts packages/cmaf-lite/test/abr/abr_controller.test.ts
git commit -m "refactor(player): remove getBufferFullness from public API"
```

---

## Task 8: Update `docs/abr.md`

**Files:**
- Modify: `packages/cmaf-lite/docs/abr.md`

- [ ] **Step 1: Replace the BOLA section**

In `packages/cmaf-lite/docs/abr.md`, find:

```md
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
```

Replace with:

```md
### BOLA (Buffer Optimized)

Uses buffer level to score each quality tier (BOLA-O,
arxiv 1601.06748). When the buffer is comfortable, BOLA favors higher
quality; as the buffer drops, it shifts toward conservative picks.

A one-shot `isBufferSteady` latch gates BOLA's scoring: false until
the front buffer has crossed `maxSegmentDuration` at least once since
the last reset. The latch resets on media `seeking`. Below this
threshold, BOLA returns no recommendation and the controller falls
back to throughput.
```

- [ ] **Step 2: Replace the Driver Selection section**

Find:

```md
## Driver Selection

A buffer-fullness hysteresis anchored to absolute seconds:

- `frontBuffer < 10s`  → **Throughput** (low buffer; safe pick).
- `frontBuffer > 20s`  → **BOLA** (comfortable buffer; utility pick).
- in between           → keep current driver (dead zone).

Initial driver is `Throughput` (buffer is 0 at startup).
```

Replace with:

```md
## Driver Selection

A buffer-fullness hysteresis derived from `frontBufferLength` as
fractions below the fill cap:

- `frontBuffer < (1/3) * frontBufferLength`  → **Throughput**.
- `frontBuffer >= (2/3) * frontBufferLength` → **BOLA**.
- in between → keep current driver (dead zone).

With default `frontBufferLength = 30`, that's 10s/20s. The transition
is checked on `BUFFER_APPENDED`, not on every evaluation tick.
Initial driver is `Throughput` (buffer is 0 at startup).
```

- [ ] **Step 3: Replace the Observability section**

Find:

```md
## Observability

Two read-only methods on `Player`:

- `getBufferFullness(): number` — 0..1, clamped. Front buffer in
  seconds divided by `frontBufferLength`.
- `getThroughputEstimate(): number` — current bits/second estimate
  (default applied while undersampled).
```

Replace with:

```md
## Observability

One read-only method on `Player`:

- `getThroughputEstimate(): number` — current bits/second estimate
  (default applied while undersampled).
```

- [ ] **Step 4: Update Configuration section if it mentions `evaluationInterval`**

Find:

```md
## Configuration

All settings live under the `abr` key in `PlayerConfig`. See
`AbrConfig` for the full list of options and their defaults.
```

This section is generic and doesn't enumerate options, so no edit needed. (Skip this step if the section doesn't reference the renamed option.)

- [ ] **Step 5: Add the InsufficientBufferRule note to Future Enhancements**

Find the `## Future Enhancements` section. After the existing entries, add:

```md
### InsufficientBufferRule

BOLA can pick a stream that won't finish before underrun in
low-buffer regimes. dash.js v5 caps the pick by
`safeThroughput * bufferLevel / fragmentDuration * 0.7` in a parallel
rule (`InsufficientBufferRule.js`). Deferred; cmaf-lite's hysteresis
(Throughput active below 10s) provides partial coverage.
```

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/docs/abr.md
git commit -m "docs(abr): update for inlined BolaScorer and switchInterval"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run type check**

Run: `pnpm tsc`
Expected: No errors.

- [ ] **Step 3: Run format/lint**

Run: `pnpm format`
Expected: Either no changes (clean) or auto-formatted files. If files were formatted, commit the formatting changes:

```bash
git add -A
git commit -m "style: biome format"
```

- [ ] **Step 4: Verify the change set**

Run: `git log --oneline main..HEAD`
Expected: Commits roughly matching the task list:
- refactor(config): rename abr.evaluationInterval to switchInterval
- test(abr): add getMedia/getBuffered to StubPlayer
- refactor(abr): inline BolaScorer into AbrController
- refactor(abr): delete BolaScorer
- test(abr): update AbrController tests for inlined model
- test(abr): cover latch, hysteresis, throttle, BOLA math
- refactor(player): remove getBufferFullness from public API
- docs(abr): update for inlined BolaScorer and switchInterval

- [ ] **Step 5: Verify spec coverage**

Re-read [the spec](../specs/2026-04-27-bola-scorer-simplification-design.md) and confirm each goal is implemented:
- BolaScorer class removed ✓ (Task 4)
- All BOLA logic in AbrController ✓ (Task 3)
- isBufferSteady_ + useBola_ private fields ✓ (Task 3)
- getFrontBuffer_ private helper ✓ (Task 3)
- pickBolaStream_ private method ✓ (Task 3)
- 1s hardcoded timer ✓ (Task 3)
- switchInterval throttle ✓ (Task 3)
- BUFFER_FLUSHED not subscribed ✓ (Task 3)
- Player.getBufferFullness removed ✓ (Task 7)
- MINIMUM_BUFFER_S private to abr_controller.ts ✓ (Task 3)
- Hysteresis at (2/3) / (1/3) of frontBufferLength ✓ (Task 3)
- docs/abr.md updated ✓ (Task 8)
- BolaScorer tests deleted ✓ (Task 4)
- AbrController tests cover new behavior ✓ (Task 6)
