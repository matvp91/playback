import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROP_DECODING_INFO, PROP_HIERARCHY } from "../../lib/constants";
import type { Preference, VideoStream } from "../../lib/types/media";
import { MediaType } from "../../lib/types/media";
import {
  buildStreams,
  findStreamsMatchingPreferences,
  pickClosestByBandwidth,
} from "../../lib/utils/stream_utils";
import {
  createDecodingInfo,
  createManifest,
  createVideoSwitchingSet,
  createVideoTrack,
  mockMediaCapabilities,
} from "../__framework__/factories";

beforeEach(() => {
  mockMediaCapabilities();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findStreamsMatchingPreferences", () => {
  const videoStreams = async (): Promise<VideoStream[]> => {
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({
          codec: "avc1.64001f",
          tracks: [
            createVideoTrack({ bandwidth: 1_000_000 }),
            createVideoTrack({
              bandwidth: 3_000_000,
              width: 1280,
              height: 720,
            }),
          ],
        }),
        createVideoSwitchingSet({
          codec: "av01.0.05M.08",
          tracks: [createVideoTrack({ bandwidth: 2_000_000 })],
        }),
      ],
    });
    const list = (await buildStreams(manifest)).get(MediaType.VIDEO) ?? [];
    return list.filter((s): s is VideoStream => s.type === MediaType.VIDEO);
  };

  it("returns all matching streams for the first type-matching preference", async () => {
    const streams = await videoStreams();
    const preferences: Preference[] = [{ type: MediaType.VIDEO, codec: "avc" }];
    const result = findStreamsMatchingPreferences(
      MediaType.VIDEO,
      streams,
      preferences,
    );
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.codec === "avc")).toBe(true);
  });

  it("skips preferences whose type does not match the requested type", async () => {
    const streams = await videoStreams();
    const preferences: Preference[] = [
      { type: MediaType.AUDIO, codec: "mp4a" },
      { type: MediaType.VIDEO, codec: "av1" },
    ];
    const result = findStreamsMatchingPreferences(
      MediaType.VIDEO,
      streams,
      preferences,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.codec).toBe("av1");
  });

  it("returns the match set for the earliest preference that yields hits", async () => {
    const streams = await videoStreams();
    const preferences: Preference[] = [
      { type: MediaType.VIDEO, codec: "hev" },
      { type: MediaType.VIDEO, codec: "avc" },
      { type: MediaType.VIDEO, codec: "av1" },
    ];
    const result = findStreamsMatchingPreferences(
      MediaType.VIDEO,
      streams,
      preferences,
    );
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.codec === "avc")).toBe(true);
  });

  it("returns an empty array when no preference matches any stream", async () => {
    const streams = await videoStreams();
    const preferences: Preference[] = [{ type: MediaType.VIDEO, codec: "hev" }];
    const result = findStreamsMatchingPreferences(
      MediaType.VIDEO,
      streams,
      preferences,
    );
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when preferences list is empty", async () => {
    const streams = await videoStreams();
    const result = findStreamsMatchingPreferences(MediaType.VIDEO, streams, []);
    expect(result).toHaveLength(0);
  });

  it("treats an undefined codec field as an unconstrained match", async () => {
    const streams = await videoStreams();
    const preferences: Preference[] = [{ type: MediaType.VIDEO }];
    const result = findStreamsMatchingPreferences(
      MediaType.VIDEO,
      streams,
      preferences,
    );
    expect(result).toHaveLength(streams.length);
  });
});

describe("pickClosestByBandwidth", () => {
  // Build distinct VideoStreams via the manifest factories. Each track
  // gets a slightly different width/height so `buildStreams` does not
  // dedupe them (dedup compares type + codec + resolution).
  const videoStreamsFor = async (bandwidths: number[]): Promise<VideoStream[]> => {
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({
          tracks: bandwidths.map((bandwidth, i) =>
            createVideoTrack({
              bandwidth,
              width: 1920 - i,
              height: 1080 - i,
            }),
          ),
        }),
      ],
    });
    const list = (await buildStreams(manifest)).get(MediaType.VIDEO) ?? [];
    return list.filter((s): s is VideoStream => s.type === MediaType.VIDEO);
  };

  it("returns the match whose bandwidth is closest to the lookup stream", async () => {
    const matches = await videoStreamsFor([500_000, 2_000_000, 5_000_000]);
    const lookup = matches[1]!;
    const result = pickClosestByBandwidth(matches, lookup);
    expect(result!.bandwidth).toBe(2_000_000);
  });

  it("keeps the earlier entry when two matches tie on distance", async () => {
    // matches ascending: [1_000_000, 3_000_000]; lookup is midpoint 2_000_000.
    // Distance ties → stable iteration keeps the earlier entry (1M).
    const matches = await videoStreamsFor([1_000_000, 3_000_000]);
    const lookup = (await videoStreamsFor([2_000_000]))[0]!;
    const result = pickClosestByBandwidth(matches, lookup);
    expect(result!.bandwidth).toBe(1_000_000);
  });

  it("returns the sole match when the set has a single entry", async () => {
    const matches = await videoStreamsFor([2_500_000]);
    const lookup = (await videoStreamsFor([9_999_000]))[0]!;
    const result = pickClosestByBandwidth(matches, lookup);
    expect(result!.bandwidth).toBe(2_500_000);
  });

  it("returns null when the match set is empty", async () => {
    const lookup = (await videoStreamsFor([1_000_000]))[0]!;
    const result = pickClosestByBandwidth([], lookup);
    expect(result).toBeNull();
  });
});

describe("StreamUtils", () => {
  describe("buildStreams", () => {
    it("extracts one stream per unique type and resolution", async () => {
      const manifest = createManifest();
      const streams = await buildStreams(manifest);
      expect(streams.get(MediaType.VIDEO)).toHaveLength(1);
      expect(streams.get(MediaType.AUDIO)).toHaveLength(1);
    });

    it("wires hierarchy to the manifest's own switching set and track", async () => {
      const manifest = createManifest();
      const streams = await buildStreams(manifest);
      const videoStream = streams.get(MediaType.VIDEO)![0]!;
      const expectedSwitchingSet = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!;
      const expectedTrack = expectedSwitchingSet.tracks[0]!;
      const { switchingSet, track } = videoStream[PROP_HIERARCHY];
      expect(switchingSet).toBe(expectedSwitchingSet);
      expect(track).toBe(expectedTrack);
    });

    it("sorts streams by bandwidth ascending for ABR", async () => {
      const manifest = createManifest({
        switchingSets: [
          createVideoSwitchingSet({
            tracks: [
              createVideoTrack({
                bandwidth: 5_000_000,
                width: 1920,
                height: 1080,
              }),
              createVideoTrack({
                bandwidth: 1_000_000,
                width: 640,
                height: 360,
              }),
              createVideoTrack({
                bandwidth: 3_000_000,
                width: 1280,
                height: 720,
              }),
            ],
          }),
        ],
      });
      const streams = await buildStreams(manifest);
      const video = streams.get(MediaType.VIDEO)!;
      const bandwidths = video.map((s) => s.bandwidth);
      expect(bandwidths).toEqual([1_000_000, 3_000_000, 5_000_000]);
    });

    it("produces separate streams for tracks with different resolutions", async () => {
      const manifest = createManifest({
        switchingSets: [
          createVideoSwitchingSet({
            tracks: [
              createVideoTrack({ width: 1920, height: 1080 }),
              createVideoTrack({ width: 1280, height: 720 }),
            ],
          }),
        ],
      });
      const streams = await buildStreams(manifest);
      expect(streams.get(MediaType.VIDEO)).toHaveLength(2);
    });

    it("attaches PROP_DECODING_INFO to every video and audio stream", async () => {
      const info = createDecodingInfo();
      mockMediaCapabilities(info);
      const manifest = createManifest();
      const streams = await buildStreams(manifest);
      const video = streams.get(MediaType.VIDEO) ?? [];
      const audio = streams.get(MediaType.AUDIO) ?? [];
      expect(video).toHaveLength(1);
      expect(audio).toHaveLength(1);
      expect(video[0]![PROP_DECODING_INFO]).toBe(info);
      expect(audio[0]![PROP_DECODING_INFO]).toBe(info);
    });
  });
});
