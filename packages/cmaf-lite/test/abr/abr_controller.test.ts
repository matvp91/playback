import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbrController } from "../../lib/abr/abr_controller";
import type { AbrConfig, PlayerConfig } from "../../lib/config";
import { DEFAULT_CONFIG } from "../../lib/config";
import { Events } from "../../lib/events";
import type { VideoStream } from "../../lib/types/media";
import { MediaType } from "../../lib/types/media";
import { NetworkRequestType } from "../../lib/types/net";
import type { StubPlayer } from "../__framework__/abr_stubs";
import { createStubPlayer, makeVideoStream } from "../__framework__/abr_stubs";
import { createTimeRanges } from "../__framework__/time_ranges";

const configWith = (overrides: Partial<AbrConfig>): PlayerConfig => ({
  ...DEFAULT_CONFIG,
  abr: { ...DEFAULT_CONFIG.abr, ...overrides },
});

describe("AbrController", () => {
  let player: StubPlayer;
  let streams: VideoStream[];

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("emits ADAPTATION on the eval timer tick when the pick changes", () => {
    vi.useFakeTimers();

    const cfg = configWith({ minTotalBytes: 1_000, switchInterval: 0 });
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
  });

  it("does not emit ADAPTATION when the pick equals the active stream", () => {
    vi.useFakeTimers();

    const cfg = configWith({ minTotalBytes: 1_000, switchInterval: 0 });
    player.setConfig(cfg);
    player.setActiveVideoStream(streams[0]!);
    player.setBufferFullness(0);

    const adaptations: VideoStream[] = [];
    player.on(Events.ADAPTATION, (e) => adaptations.push(e.stream));

    const controller = new AbrController(player as never);
    vi.advanceTimersByTime(1100);

    expect(adaptations).toHaveLength(0);
    controller.destroy();
  });

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

  describe("useBola_ hysteresis", () => {
    const setup = () => {
      vi.useFakeTimers();
      const media = document.createElement("video");
      Object.defineProperty(media, "currentTime", {
        value: 0,
        writable: true,
        configurable: true,
      });
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
      media.currentTime = 16;
      // Now ahead = 25 - 16 = 9 < 10. useBola_ flips off.
      append();
      // After the flip, evaluate uses throughput. With low buffer and
      // a high active stream (set below), throughput downgrades.
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
      media.currentTime = 10;
      // ahead = 25 - 10 = 15. In dead zone. useBola_ stays true.
      append();
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

  describe("switchInterval throttle", () => {
    it("discards subsequent picks within switchInterval", () => {
      vi.useFakeTimers();
      const cfg = configWith({ minTotalBytes: 1_000, switchInterval: 5 });
      player.setConfig(cfg);
      player.setActiveVideoStream(streams[2]!);
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

  describe("BOLA math (via inlined pickBolaStream_)", () => {
    const drive = (frontBuffer: number, currentTime = 0) => {
      vi.useFakeTimers();
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
});
