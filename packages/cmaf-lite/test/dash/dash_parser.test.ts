import { describe, expect, it } from "vitest";
import { parseManifest } from "../../lib/dash/dash_parser";
import { MediaType } from "../../lib/types/media";
import { loadFixture } from "../fixtures";

describe("DashParser", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  it("parses a basic MPD into a manifest with correct duration", () => {
    const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    expect(manifest.duration).toBe(60);
    expect(manifest.switchingSets).toHaveLength(2);
  });

  it("extracts a video switching set with the declared codec", () => {
    const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    );
    expect(video).toBeDefined();
    expect(video!.codec).toBe("avc1.64001f");
    expect(video!.tracks).toHaveLength(2);
  });

  it("extracts an audio switching set with the declared codec", () => {
    const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    const audio = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.AUDIO,
    );
    expect(audio).toBeDefined();
    expect(audio!.codec).toBe("mp4a.40.2");
    expect(audio!.tracks).toHaveLength(1);
  });

  it("resolves video track dimensions from representations", () => {
    const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const track1080 = video.tracks.find(
      (t) => t.type === MediaType.VIDEO && t.height === 1080,
    );
    const track720 = video.tracks.find(
      (t) => t.type === MediaType.VIDEO && t.height === 720,
    );
    expect(track1080).toBeDefined();
    expect(track720).toBeDefined();
  });

  it("generates segments with URLs derived from the SegmentTemplate", () => {
    const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const track = video.tracks[0]!;
    expect(track.segments.length).toBeGreaterThan(0);

    const firstSeg = track.segments[0]!;
    expect(firstSeg.url).toContain("video-");
    expect(firstSeg.start).toBe(0);
    expect(firstSeg.initSegment.url).toContain("video-init.mp4");
  });

  it("generates the correct number of segments for the presentation duration", () => {
    const manifest = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const track = video.tracks[0]!;
    // 60s duration / 4s segments = 15 segments
    expect(track.segments).toHaveLength(15);
  });

  it("flattens multi-period MPD into a single manifest with concatenated segments", () => {
    const manifest = parseManifest(loadFixture("multi-period.mpd"), sourceUrl);
    expect(manifest.duration).toBe(60);
    expect(manifest.switchingSets).toHaveLength(2);

    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    // Single track with segments from both periods
    expect(video.tracks).toHaveLength(1);
    const segments = video.tracks[0]!.segments;
    // 30s / 4s = 7.5 → 8 segments per period × 2 = 16
    // Verify segments span the full duration
    expect(segments[0]!.start).toBe(0);
    expect(segments.at(-1)!.end).toBeGreaterThanOrEqual(60);
  });

  it("concatenates segments from multiple periods in timeline order", () => {
    const manifest = parseManifest(loadFixture("multi-period.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const segments = video.tracks[0]!.segments;
    // Period 2 segments should start at or after 30s
    const p2Segments = segments.filter((s) => s.start >= 30);
    expect(p2Segments.length).toBeGreaterThan(0);
    expect(p2Segments[0]!.url).toContain("p2-video-");
  });

  it("infers media type from mimeType when contentType is absent", () => {
    const manifest = parseManifest(
      loadFixture("mimetype-fallback.mpd"),
      sourceUrl,
    );
    expect(manifest.switchingSets).toHaveLength(2);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    );
    const audio = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.AUDIO,
    );
    expect(video).toBeDefined();
    expect(audio).toBeDefined();
  });

  it("computes maxSegmentDuration on each track", () => {
    const result = parseManifest(loadFixture("basic.mpd"), sourceUrl);
    for (const ss of result.switchingSets) {
      for (const track of ss.tracks) {
        expect(track.maxSegmentDuration).toBe(4);
      }
    }
  });

  it("throws when MPD contains no Period elements", () => {
    const emptyMpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     mediaPresentationDuration="PT60S">
</MPD>`;
    expect(() => parseManifest(emptyMpd, sourceUrl)).toThrow();
  });

  it("parses a subtitle AdaptationSet into a subtitle switching set with language", () => {
    const manifest = parseManifest(loadFixture("subtitle.mpd"), sourceUrl);
    const subtitle = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.SUBTITLE,
    );
    expect(subtitle).toBeDefined();
    expect(subtitle!.codec).toBe("wvtt");
    expect(subtitle!.type).toBe(MediaType.SUBTITLE);
    if (subtitle!.type === MediaType.SUBTITLE) {
      expect(subtitle!.language).toBe("en");
    }
    expect(subtitle!.tracks).toHaveLength(1);
  });

  it("builds subtitle track segments from the SegmentTemplate", () => {
    const manifest = parseManifest(loadFixture("subtitle.mpd"), sourceUrl);
    const subtitle = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.SUBTITLE,
    )!;
    const track = subtitle.tracks[0]!;
    expect(track.segments.length).toBeGreaterThan(0);
    expect(track.segments[0]!.url).toContain("subtitle-");
    expect(track.segments[0]!.initSegment.url).toContain("subtitle-init.mp4");
  });
});
