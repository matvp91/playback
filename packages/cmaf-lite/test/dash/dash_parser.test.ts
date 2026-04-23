import { describe, expect, it } from "vitest";
import * as DashParser from "../../lib/dash/dash_parser";
import { MediaType } from "../../lib/types/media";
import { loadFixture } from "../fixtures";

describe("DashParser", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  it("parses a basic MPD into a manifest with correct duration", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    expect(manifest.duration).toBe(60);
    expect(manifest.switchingSets).toHaveLength(2);
  });

  it("extracts a video switching set with the declared codec", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    );
    expect(video).toBeDefined();
    expect(video!.codec).toBe("avc1.64001f");
    expect(video!.tracks).toHaveLength(2);
  });

  it("extracts an audio switching set with the declared codec", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    const audio = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.AUDIO,
    );
    expect(audio).toBeDefined();
    expect(audio!.codec).toBe("mp4a.40.2");
    expect(audio!.tracks).toHaveLength(1);
  });

  it("resolves video track dimensions from representations", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
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
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
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
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const track = video.tracks[0]!;
    // 60s duration / 4s segments = 15 segments
    expect(track.segments).toHaveLength(15);
  });

  it("flattens multi-period MPD into a single manifest with concatenated segments", () => {
    const manifest = DashParser.create(
      loadFixture("multi-period.mpd"),
      sourceUrl,
    );
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
    const manifest = DashParser.create(
      loadFixture("multi-period.mpd"),
      sourceUrl,
    );
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
    const manifest = DashParser.create(
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
    const result = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
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
    expect(() => DashParser.create(emptyMpd, sourceUrl)).toThrow();
  });

  it("parses a subtitle AdaptationSet into a subtitle switching set with language", () => {
    const manifest = DashParser.create(loadFixture("subtitle.mpd"), sourceUrl);
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
    const manifest = DashParser.create(loadFixture("subtitle.mpd"), sourceUrl);
    const subtitle = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.SUBTITLE,
    )!;
    const track = subtitle.tracks[0]!;
    expect(track.segments.length).toBeGreaterThan(0);
    expect(track.segments[0]!.url).toContain("subtitle-");
    expect(track.segments[0]!.initSegment.url).toContain("subtitle-init.mp4");
  });

  it("concatenates audio segments across periods into a single track", () => {
    const manifest = DashParser.create(
      loadFixture("multi-period.mpd"),
      sourceUrl,
    );
    const audio = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.AUDIO,
    )!;
    expect(audio.tracks).toHaveLength(1);
    const segments = audio.tracks[0]!.segments;
    const p1Segments = segments.filter((s) => s.url.includes("p1-audio-"));
    const p2Segments = segments.filter((s) => s.url.includes("p2-audio-"));
    expect(p1Segments.length).toBeGreaterThan(0);
    expect(p2Segments.length).toBeGreaterThan(0);
    expect(p2Segments[0]!.start).toBeGreaterThanOrEqual(30);
  });

  it("assigns SwitchingSet.id as type:codec for video and type:codec:language for audio", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const audio = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.AUDIO,
    )!;
    expect(video.id).toBe("video:avc1.64001f");
    expect(audio.id).toBe("audio:mp4a.40.2:unk");
  });

  it("assigns Track.id from Representation@id", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const ids = video.tracks.map((t) => t.id).sort();
    expect(ids).toEqual(["1", "2"]);
  });

  it("sets isLive to false for a static MPD", () => {
    const manifest = DashParser.create(loadFixture("basic.mpd"), sourceUrl);
    expect(manifest.isLive).toBe(false);
  });

  it("sets isLive to true for a dynamic MPD", () => {
    const dynamicMpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <SegmentTemplate timescale="90000" media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="360000" />
      <Representation id="1" bandwidth="2000000" width="1920" height="1080" />
    </AdaptationSet>
  </Period>
</MPD>`;
    const manifest = DashParser.create(dynamicMpd, sourceUrl);
    expect(manifest.isLive).toBe(true);
  });
});

describe("DashParser.update", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  it("preserves manifest, switching set, track, and segment references when applied twice to the same MPD", () => {
    const text = loadFixture("basic.mpd");
    const manifest = DashParser.create(text, sourceUrl);

    const switchingSetsRef = manifest.switchingSets;
    const firstSet = switchingSetsRef[0]!;
    const firstTrack = firstSet.tracks[0]!;
    const tracksRef = firstSet.tracks;
    const segmentsRef = firstTrack.segments;
    const firstSegment = segmentsRef[0]!;
    const segmentCount = segmentsRef.length;

    DashParser.update(manifest, text, sourceUrl);

    expect(manifest.switchingSets).toBe(switchingSetsRef);
    expect(manifest.switchingSets[0]).toBe(firstSet);
    expect(firstSet.tracks).toBe(tracksRef);
    expect(firstSet.tracks[0]).toBe(firstTrack);
    expect(firstTrack.segments).toBe(segmentsRef);
    expect(firstTrack.segments[0]).toBe(firstSegment);
    expect(firstTrack.segments.length).toBeGreaterThanOrEqual(segmentCount);
  });

  it("extends an existing track's segments when a second MPD adds tail segments", () => {
    const sourceText = loadFixture("timeline.mpd");
    const manifest = DashParser.create(sourceText, sourceUrl);

    const video = manifest.switchingSets.find(
      (ss) => ss.type === MediaType.VIDEO,
    )!;
    const track = video.tracks[0]!;
    const originalSegments = track.segments;
    const originalCount = originalSegments.length;
    const originalFirst = originalSegments[0]!;
    const originalLast = originalSegments.at(-1)!;

    const extendedText = sourceText.replace(
      /<S t="0" d="360000" r="\d+" \/>/,
      (match) => {
        const rMatch = /r="(\d+)"/.exec(match);
        const nextR = rMatch ? Number(rMatch[1]) + 5 : 5;
        return `<S t="0" d="360000" r="${nextR}" />`;
      },
    );
    DashParser.update(manifest, extendedText, sourceUrl);

    expect(track.segments).toBe(originalSegments);
    expect(track.segments.length).toBeGreaterThan(originalCount);
    expect(track.segments[0]).toBe(originalFirst);
    expect(track.segments[originalCount - 1]).toBe(originalLast);
  });
});
