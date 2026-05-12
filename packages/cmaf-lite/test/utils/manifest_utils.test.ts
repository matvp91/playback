import { describe, expect, it } from "vitest";
import type { Segment } from "../../lib/types/manifest";
import {
  evictSegments,
  isInitSegment,
  isMediaSegment,
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

  describe("evictSegments", () => {
    it("removes segments with start in [periodStart, firstKeptStart)", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        createSegment({ start: 8, end: 12 }),
      ];
      evictSegments(segments, 0, 8);
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
      evictSegments(segments, 0, 8);
      expect(segments[0]).toBe(kept);
    });

    it("is a no-op when firstKeptStart is at or below periodStart", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
      ];
      evictSegments(segments, 0, 0);
      expect(segments).toHaveLength(2);
    });

    it("is a no-op on an empty array", () => {
      const segments: Segment[] = [];
      evictSegments(segments, 0, 5);
      expect(segments).toHaveLength(0);
    });

    it("empties the array when firstKeptStart exceeds every segment in range", () => {
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
      ];
      evictSegments(segments, 0, 10);
      expect(segments).toHaveLength(0);
    });

    it("leaves earlier-period segments untouched", () => {
      // Simulates Period 2's call: only segments at or above periodStart=12
      // may be pruned. Prior-period segments must stay.
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        createSegment({ start: 8, end: 12 }),
        createSegment({ start: 12, end: 16 }),
        createSegment({ start: 16, end: 20 }),
      ];
      evictSegments(segments, 12, 16);
      expect(segments.map((s) => s.start)).toEqual([0, 4, 8, 16]);
    });

    it("is a no-op within a later period when its timeline hasn't slid", () => {
      // Simulates Period 2 where firstKeptStart === periodStart — the
      // common case. No segments should be removed from either period.
      const segments = [
        createSegment({ start: 0, end: 4 }),
        createSegment({ start: 4, end: 8 }),
        createSegment({ start: 12, end: 16 }),
        createSegment({ start: 16, end: 20 }),
      ];
      evictSegments(segments, 12, 12);
      expect(segments).toHaveLength(4);
    });
  });
});
