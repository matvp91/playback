import { describe, expect, it } from "vitest";
import * as DashParser from "../../lib/dash/dash_parser";
import type { Segment } from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";
import * as asserts from "../../lib/utils/asserts";
import * as XmlUtils from "../../lib/utils/xml_utils";
import { loadFixture } from "../fixtures";

const sourceUrl = "https://cdn.test/manifest.mpd";

describe("DashSegments", () => {
  describe("duration-based segments", () => {
    it("generates segments that cover the full presentation duration", () => {
      const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
      const video = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!;
      const last = video.tracks[0]!.segments.at(-1)!;
      expect(last.end).toBeCloseTo(60, 0);
    });

    it("produces contiguous segments with no gaps between them", () => {
      const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
      const segments = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!.tracks[0]!.segments;

      for (let i = 1; i < segments.length; i++) {
        expect(segments[i]!.start).toBeCloseTo(segments[i - 1]!.end, 5);
      }
    });

    it("attaches an init segment to every media segment", () => {
      const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
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
      const manifest = DashParser.create(
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
      const manifest = DashParser.create(
        loadFixture("timeline.mpd"),
        sourceUrl,
      );
      const segments = manifest.switchingSets.find(
        (ss) => ss.type === MediaType.VIDEO,
      )!.tracks[0]!.segments;

      // r="2" means 3 total segments (original + 2 repeats)
      expect(segments).toHaveLength(3);
    });

    it("calculates correct start and end times from timeline entries", () => {
      const manifest = DashParser.create(
        loadFixture("timeline.mpd"),
        sourceUrl,
      );
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
      const manifest = DashParser.create(
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

  describe("startAfter delta behavior", () => {
    it("emits all segments when startAfter is -Infinity", () => {
      // timeline.mpd: <S t="0" d="360000" r="2"/> with timescale=90000 → 3 segments
      //   at start = 0, 4, 8
      const segments: Segment[] = [];
      const mpd = XmlUtils.parseXml(loadFixture("timeline.mpd"), "MPD");
      const period = XmlUtils.child(mpd, "Period");
      asserts.assertExists(period, "Period not found");
      const adaptationSet = XmlUtils.child(period, "AdaptationSet");
      asserts.assertExists(adaptationSet, "AdaptationSet not found");
      const representation = XmlUtils.child(adaptationSet, "Representation");
      asserts.assertExists(representation, "Representation not found");

      const { firstAvailableStart } = DashParser.appendSegments(
        segments,
        sourceUrl,
        mpd,
        period,
        adaptationSet,
        representation,
        /* periodDuration */ 12,
        /* startAfter */ -Infinity,
      );

      expect(segments).toHaveLength(3);
      expect(segments.map((s) => s.start)).toEqual([0, 4, 8]);
      expect(firstAvailableStart).toBe(0);
    });

    it("skips segments at or below startAfter and emits only newer ones", () => {
      const segments: Segment[] = [];
      const mpd = XmlUtils.parseXml(loadFixture("timeline.mpd"), "MPD");
      const period = XmlUtils.child(mpd, "Period");
      asserts.assertExists(period, "Period not found");
      const adaptationSet = XmlUtils.child(period, "AdaptationSet");
      asserts.assertExists(adaptationSet, "AdaptationSet not found");
      const representation = XmlUtils.child(adaptationSet, "Representation");
      asserts.assertExists(representation, "Representation not found");

      const { firstAvailableStart } = DashParser.appendSegments(
        segments,
        sourceUrl,
        mpd,
        period,
        adaptationSet,
        representation,
        12,
        /* startAfter */ 4,
      );

      // segments with start <= 4 are skipped (start=0 and start=4)
      expect(segments).toHaveLength(1);
      expect(segments[0]?.start).toBe(8);
      // firstAvailableStart reports the MPD's earliest segment, not the emitted one
      expect(firstAvailableStart).toBe(0);
    });

    it("preserves init segment identity across appendSegments calls", () => {
      // StreamController uses `segment.initSegment !== lastInitSegment` to
      // decide whether to (re)fetch the init segment. A fresh object per
      // manifest refresh makes it refetch every cycle for the same URL.
      const segments: Segment[] = [];
      const mpd = XmlUtils.parseXml(loadFixture("timeline.mpd"), "MPD");
      const period = XmlUtils.child(mpd, "Period");
      asserts.assertExists(period, "Period not found");
      const adaptationSet = XmlUtils.child(period, "AdaptationSet");
      asserts.assertExists(adaptationSet, "AdaptationSet not found");
      const representation = XmlUtils.child(adaptationSet, "Representation");
      asserts.assertExists(representation, "Representation not found");

      DashParser.appendSegments(
        segments,
        sourceUrl,
        mpd,
        period,
        adaptationSet,
        representation,
        12,
        /* startAfter */ -Infinity,
      );
      const firstInit = segments[0]!.initSegment;

      DashParser.appendSegments(
        segments,
        sourceUrl,
        mpd,
        period,
        adaptationSet,
        representation,
        12,
        /* startAfter */ 4,
      );

      for (const seg of segments) {
        expect(seg.initSegment).toBe(firstInit);
      }
    });
  });
});
