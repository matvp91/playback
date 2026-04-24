import type {
  InitSegment,
  Manifest,
  Segment,
  SwitchingSet,
  Track,
} from "../../lib/types/manifest";
import { LANGUAGE_UNKNOWN } from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";

export function createInitSegment(
  overrides?: Partial<InitSegment>,
): InitSegment {
  return {
    url: "https://cdn.test/init.mp4",
    ...overrides,
  };
}

export function createSegment(overrides?: Partial<Segment>): Segment {
  return {
    url: "https://cdn.test/seg-1.m4s",
    start: 0,
    end: 4,
    initSegment: createInitSegment(),
    ...overrides,
  };
}

export function createVideoTrack(
  overrides?: Partial<Track<MediaType.VIDEO>>,
): Track<MediaType.VIDEO> {
  return {
    id: "video-track-1",
    type: MediaType.VIDEO,
    bandwidth: 2_000_000,
    width: 1920,
    height: 1080,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createAudioTrack(
  overrides?: Partial<Track<MediaType.AUDIO>>,
): Track<MediaType.AUDIO> {
  return {
    id: "audio-track-1",
    type: MediaType.AUDIO,
    bandwidth: 128_000,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createVideoSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.VIDEO>>,
): SwitchingSet<MediaType.VIDEO> {
  return {
    id: "video:avc1.64001f",
    type: MediaType.VIDEO,
    codec: "avc1.64001f",
    tracks: [createVideoTrack()],
    ...overrides,
  };
}

export function createAudioSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.AUDIO>>,
): SwitchingSet<MediaType.AUDIO> {
  return {
    id: "audio:mp4a.40.2:unk",
    type: MediaType.AUDIO,
    codec: "mp4a.40.2",
    language: LANGUAGE_UNKNOWN,
    tracks: [createAudioTrack()],
    ...overrides,
  };
}

export function createManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    start: 0,
    end: 60,
    isLive: false,
    switchingSets: [createVideoSwitchingSet(), createAudioSwitchingSet()],
    ...overrides,
  };
}
