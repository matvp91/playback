import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbrController } from "../../lib/abr/abr_controller";
import type { AbrConfig, PlayerConfig } from "../../lib/config";
import { DEFAULT_CONFIG } from "../../lib/config";
import { Events } from "../../lib/events";
import type { VideoStream } from "../../lib/types/media";
import { NetworkRequestType } from "../../lib/types/net";
import type { StubPlayer } from "../__framework__/abr_stubs";
import { createStubPlayer, makeVideoStream } from "../__framework__/abr_stubs";

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
});
