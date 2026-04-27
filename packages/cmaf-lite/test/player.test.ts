import { beforeEach, describe, expect, it, vi } from "vitest";
import { Player } from "../lib/player";
import { MediaType } from "../lib/types/media";
import { createTimeRanges } from "./__framework__/time_ranges";

// happy-dom does not implement MediaSource; stub it so attachMedia
// doesn't throw when BufferController reacts to MEDIA_ATTACHING.
vi.stubGlobal(
  "MediaSource",
  class {
    addEventListener() {}
    addSourceBuffer() {
      return { addEventListener() {} };
    }
  },
);
vi.stubGlobal("URL", { createObjectURL: () => "blob:mock" });

describe("Player", () => {
  describe("getBufferFullness", () => {
    let player: Player;

    beforeEach(() => {
      player = new Player();
    });

    it("returns 0 when no media is attached", () => {
      expect(player.getBufferFullness()).toBe(0);
    });

    it("returns 0 when buffered ranges don't cover currentTime", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "currentTime", {
        value: 0,
        configurable: true,
      });
      player.attachMedia(video);
      player.getBuffered = (type: MediaType) =>
        type === MediaType.VIDEO ? createTimeRanges() : createTimeRanges();
      expect(player.getBufferFullness()).toBe(0);
    });

    it("returns ahead/frontBufferLength when buffered", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "currentTime", {
        value: 0,
        configurable: true,
      });
      player.attachMedia(video);
      player.getBuffered = (type: MediaType) =>
        type === MediaType.VIDEO
          ? createTimeRanges([0, 15])
          : createTimeRanges();
      // frontBufferLength default = 30, ahead = 15 → 0.5
      expect(player.getBufferFullness()).toBeCloseTo(0.5);
    });

    it("clamps at 1 when ahead > frontBufferLength", () => {
      const video = document.createElement("video");
      Object.defineProperty(video, "currentTime", {
        value: 0,
        configurable: true,
      });
      player.attachMedia(video);
      player.getBuffered = (type: MediaType) =>
        type === MediaType.VIDEO
          ? createTimeRanges([0, 60])
          : createTimeRanges();
      expect(player.getBufferFullness()).toBe(1);
    });
  });
});
