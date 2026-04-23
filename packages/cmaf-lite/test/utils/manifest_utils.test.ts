import { describe, expect, it } from "vitest";
import type { Segment } from "../../lib/types/manifest";
import {
  isInitSegment,
  isMediaSegment,
  pruneSegments,
} from "../../lib/utils/manifest_utils";
import { createInitSegment, createSegment } from "../__framework__/factories";

describe("ManifestUtils", () => {
  describe("isMediaSegment", () => {
    it("returns true for a media segment", () => {
      expect(isMediaSegment(createSegment())).toBe(true);
    });

    it("returns false for an init segment", () => {
      expect(isMediaSegment(createInitSegment())).toBe(false);
    });
  });

  describe("isInitSegment", () => {
    it("returns true for an init segment", () => {
      expect(isInitSegment(createInitSegment())).toBe(true);
    });

    it("returns false for a media segment", () => {
      expect(isInitSegment(createSegment())).toBe(false);
    });
  });

  describe("pruneSegments", () => {
    it("removes segments with start below the threshold", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        createSegment({ start: 8, end: 12 }),
      ];
      pruneSegments(segments, 8);
      expect(segments).toHaveLength(1);
      expect(segments[0]!.start).toBe(8);
    });

    it("preserves object identity for kept segments", () => {
      const kept = createSegment({ start: 8, end: 12 });
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        kept,
      ];
      pruneSegments(segments, 8);
      expect(segments[0]).toBe(kept);
    });

    it("is a no-op when threshold is below the first segment", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
      ];
      pruneSegments(segments, -Infinity);
      expect(segments).toHaveLength(2);
    });

    it("is a no-op on an empty array", () => {
      const segments: Segment[] = [];
      pruneSegments(segments, 5);
      expect(segments).toHaveLength(0);
    });

    it("empties the array when threshold exceeds all starts", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
      ];
      pruneSegments(segments, 10);
      expect(segments).toHaveLength(0);
    });
  });
});
