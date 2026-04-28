import { EventEmitter } from "@matvp91/eventemitter3";
import type { PlayerConfig } from "../../lib/config";
import { DEFAULT_CONFIG } from "../../lib/config";
import type { EventMap } from "../../lib/events";
import type { Stream, VideoStream } from "../../lib/types/media";
import { MediaType } from "../../lib/types/media";
import { createVideoSwitchingSet, createVideoTrack } from "./factories";
import { createTimeRanges } from "./time_ranges";

export interface StubPlayer extends EventEmitter<EventMap> {
  getStreams<T extends MediaType>(type: T): Stream<T>[];
  getActiveStream<T extends MediaType>(type: T): Stream<T> | null;
  getBuffered(type: MediaType): TimeRanges;
  getConfig(): PlayerConfig;
  getMedia(): HTMLMediaElement | null;
  setBuffered(type: MediaType, ranges: TimeRanges): void;
  setMedia(media: HTMLMediaElement | null): void;
  setActiveVideoStream(stream: VideoStream | null): void;
  setVideoStreams(streams: VideoStream[]): void;
  setConfig(config: PlayerConfig): void;
}

export function createStubPlayer(opts?: {
  streams?: VideoStream[];
  activeStream?: VideoStream | null;
  config?: PlayerConfig;
}): StubPlayer {
  let videoStreams = opts?.streams ?? [];
  let activeVideo = opts?.activeStream ?? null;
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
    getBuffered: (type: MediaType) =>
      type === MediaType.VIDEO ? videoBuffered : createTimeRanges(),
    getConfig: () => config,
    getMedia: () => media,
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
}

/**
 * Helper to build a video stream with a given bandwidth, sharing
 * a default track + switching set. The `hierarchy.track` reference
 * is what `AbrController` reads for `maxSegmentDuration`.
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
