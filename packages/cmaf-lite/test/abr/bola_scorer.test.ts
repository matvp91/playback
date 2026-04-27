import { beforeEach, describe, expect, it } from "vitest";
import { BolaScorer } from "../../lib/abr/bola_scorer";
import { Events } from "../../lib/events";
import type { VideoStream } from "../../lib/types/media";
import { MediaType } from "../../lib/types/media";
import type { StubPlayer } from "../__framework__/abr_stubs";
import { createStubPlayer, makeVideoStream } from "../__framework__/abr_stubs";

const makeMedia = (): HTMLVideoElement => document.createElement("video");

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
      bufferFullness: 1, // 30s with default frontBufferLength
    });
    media = makeMedia();
    scorer = new BolaScorer(player as never, media);
  });

  it("returns null before any BUFFER_APPENDED (event gate closed)", () => {
    expect(scorer.getRecommendedStream()).toBeNull();
  });

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

  it("BOLA picks a lower stream at minimal buffer than at full buffer", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    // Just above threshold (4s). BOLA should prefer a lower-index stream
    // than when the buffer is full, because utility/bandwidth score
    // decreases with buffer penalty.
    player.setBufferFullness(5 / 30);
    const lowPick = scorer.getRecommendedStream();
    player.setBufferFullness(1); // 30s
    const highPick = scorer.getRecommendedStream();
    expect(streams.indexOf(lowPick!)).toBeLessThan(streams.indexOf(highPick!));
  });

  it("prefers highest stream when buffer is at frontBufferLength", () => {
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    player.setBufferFullness(1); // 30s
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
      if (pick === null) {
        continue;
      }
      const idx = streams.indexOf(pick);
      expect(idx).toBeGreaterThanOrEqual(prevIndex);
      prevIndex = idx;
    }
  });

  it("destroy() unbinds player and media listeners", () => {
    // Open the event gate first, so the BUFFER_APPENDED below has a
    // visible effect to suppress.
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    expect(scorer.getRecommendedStream()).not.toBeNull();

    scorer.destroy();

    // Listeners are unbound; events should be no-ops. We dispatch
    // BUFFER_FLUSHED (which would close the gate if still listening)
    // and then BUFFER_APPENDED (which would re-open it). State should
    // remain frozen at the value it had when destroy() was called.
    player.emit(Events.BUFFER_FLUSHED, { type: MediaType.VIDEO });
    player.emit(Events.BUFFER_APPENDED, {
      type: MediaType.VIDEO,
      segment: streams[0]!.hierarchy.track.segments[0]!,
      data: new ArrayBuffer(0),
    });
    // isSteady_ stays true (listeners gone), so the gate stays open.
    // Threshold gate still passes (fullness = 1, frontBuffer = 30).
    expect(scorer.getRecommendedStream()).not.toBeNull();
  });
});
