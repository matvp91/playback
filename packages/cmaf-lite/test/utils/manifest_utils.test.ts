import { describe, expect, it } from "vitest";
import { isInitSegment, isMediaSegment } from "../../lib/utils/manifest_utils";
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
});
