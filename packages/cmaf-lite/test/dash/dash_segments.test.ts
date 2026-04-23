import { describe, expect, it } from "vitest";
import { parseManifest } from "../../lib/dash/dash_parser";
import { MediaType } from "../../lib/types/media";
import { loadFixture } from "../fixtures";

const sourceUrl = "https://cdn.test/manifest.mpd";

describe("DashSegments", () => {
  describe("duration-based segments", () => {
    it("generates segments that cover the full presentation duration", () => {
      const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
      const video = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!;
      const last = video.tracks[0]!.segments.at(-1)!;
      expect(last.end).toBeCloseTo(60, 0);
    });

    it("produces contiguous segments with no gaps between them", () => {
      const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
      const segments = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!.tracks[0]!.segments;

      for (let i = 1; i < segments.length; i++) {
        expect(segments[i]!.start).toBeCloseTo(segments[i - 1]!.end, 5);
      }
    });

    it("attaches an init segment to every media segment", () => {
      const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
      const segments = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!.tracks[0]!.segments;

      for (const seg of segments) {
        expect(seg.initSegment).toBeDefined();
        expect(seg.initSegment.url).toContain("init");
      }
    });
  });

  describe("SegmentTemplate inheritance", () => {
    it("merges SegmentTemplate attributes from period, adaptation set, and representation levels", () => {
      const manifest = parseManifest(
        loadFixture("inherited-template.mpd"),
        sourceUrl,
      );
      const video = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!;
      const segments = video.tracks[0]!.segments;
      // 12s / 4s = 3 segments
      expect(segments).toHaveLength(3);
      expect(segments[0]!.initSegment.url).toContain("video-init.mp4");
      expect(segments[0]!.url).toContain("video-");
    });
  });

  describe("timeline-based segments", () => {
    it("generates the correct number of segments from SegmentTimeline with repeat count", () => {
      const manifest = parseManifest(loadFixture("timeline.mpd"), sourceUrl);
      const segments = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!.tracks[0]!.segments;

      // r="2" means 3 total segments (original + 2 repeats)
      expect(segments).toHaveLength(3);
    });

    it("calculates correct start and end times from timeline entries", () => {
      const manifest = parseManifest(loadFixture("timeline.mpd"), sourceUrl);
      const segments = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!.tracks[0]!.segments;

      expect(segments[0]!.start).toBeCloseTo(0, 5);
      expect(segments[0]!.end).toBeCloseTo(4, 5);
      expect(segments[1]!.start).toBeCloseTo(4, 5);
      expect(segments[2]!.start).toBeCloseTo(8, 5);
    });
  });

  describe("timeline with time reset", () => {
    it("resets segment time when S entry has explicit @_t attribute", () => {
      const manifest = parseManifest(
        loadFixture("timeline-reset.mpd"),
        sourceUrl,
      );
      const video = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!;
      const segments = video.tracks[0]!.segments;

      expect(segments).toHaveLength(3);
      // First two segments: 0-4s, 4-8s
      expect(segments[0]!.start).toBeCloseTo(0, 5);
      expect(segments[0]!.end).toBeCloseTo(4, 5);
      expect(segments[1]!.start).toBeCloseTo(4, 5);
      expect(segments[1]!.end).toBeCloseTo(8, 5);
      // Third segment: time reset to 900000/90000 = 10s
      expect(segments[2]!.start).toBeCloseTo(10, 5);
      expect(segments[2]!.end).toBeCloseTo(12, 5);
    });
  });
});
