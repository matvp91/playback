import { describe, expect, it } from "vitest";
import * as DashParser from "../../lib/dash/dash_parser";
import { MediaType } from "../../lib/types/media";
import * as asserts from "../../lib/utils/asserts";
import { loadFixture } from "../fixtures";
import { findAudio, findSubtitle, findVideo } from "./helpers";

describe("DashParser", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  it("parses a basic MPD into a manifest with correct duration", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    expect(manifest.duration).toBe(60);
    expect(manifest.switchingSets).toHaveLength(2);
  });

  it("extracts a video switching set with the declared codec", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const video = findVideo(manifest);
    expect(video.codec).toBe("avc1.64001f");
    expect(video.tracks).toHaveLength(2);
  });

  it("extracts an audio switching set with the declared codec", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const audio = findAudio(manifest);
    expect(audio.codec).toBe("mp4a.40.2");
    expect(audio.tracks).toHaveLength(1);
  });

  it("resolves video track dimensions from representations", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const video = findVideo(manifest);
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
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const video = findVideo(manifest);
    const track = video.tracks[0]!;
    expect(track.segments.length).toBeGreaterThan(0);

    const firstSeg = track.segments[0]!;
    expect(firstSeg.url).toContain("video-");
    expect(firstSeg.start).toBe(0);
    expect(firstSeg.initSegment.url).toContain("video-init.mp4");
  });

  it("generates the correct number of segments for the presentation duration", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const video = findVideo(manifest);
    const track = video.tracks[0]!;
    // 60s duration / 4s segments = 15 segments
    expect(track.segments).toHaveLength(15);
  });

  it("flattens multi-period MPD into a single manifest with concatenated segments", () => {
    const manifest = DashParser.create(
      loadFixture("dash-parser/vod-multi-period.mpd"),
      sourceUrl,
    );
    expect(manifest.duration).toBe(60);
    expect(manifest.switchingSets).toHaveLength(2);

    const video = findVideo(manifest);
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
      loadFixture("dash-parser/vod-multi-period.mpd"),
      sourceUrl,
    );
    const video = findVideo(manifest);
    const segments = video.tracks[0]!.segments;
    // Period 2 segments should start at or after 30s
    const p2Segments = segments.filter((s) => s.start >= 30);
    expect(p2Segments.length).toBeGreaterThan(0);
    expect(p2Segments[0]!.url).toContain("p2-video-");
  });

  it("infers media type from mimeType when contentType is absent", () => {
    const manifest = DashParser.create(
      loadFixture("dash-parser/vod-mimetype-fallback.mpd"),
      sourceUrl,
    );
    expect(manifest.switchingSets).toHaveLength(2);
    findVideo(manifest);
    findAudio(manifest);
  });

  it("computes maxSegmentDuration on each track", () => {
    const result = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
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
    const manifest = DashParser.create(loadFixture("dash-parser/vod-subtitle.mpd"), sourceUrl);
    const subtitle = findSubtitle(manifest);
    expect(subtitle.codec).toBe("wvtt");
    expect(subtitle.type).toBe(MediaType.SUBTITLE);
    expect(subtitle.language).toBe("en");
    expect(subtitle.tracks).toHaveLength(1);
  });

  it("builds subtitle track segments from the SegmentTemplate", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-subtitle.mpd"), sourceUrl);
    const subtitle = findSubtitle(manifest);
    const track = subtitle.tracks[0]!;
    expect(track.segments.length).toBeGreaterThan(0);
    expect(track.segments[0]!.url).toContain("subtitle-");
    expect(track.segments[0]!.initSegment.url).toContain("subtitle-init.mp4");
  });

  it("concatenates audio segments across periods into a single track", () => {
    const manifest = DashParser.create(
      loadFixture("dash-parser/vod-multi-period.mpd"),
      sourceUrl,
    );
    const audio = findAudio(manifest);
    expect(audio.tracks).toHaveLength(1);
    const segments = audio.tracks[0]!.segments;
    const p1Segments = segments.filter((s) => s.url.includes("p1-audio-"));
    const p2Segments = segments.filter((s) => s.url.includes("p2-audio-"));
    expect(p1Segments.length).toBeGreaterThan(0);
    expect(p2Segments.length).toBeGreaterThan(0);
    expect(p2Segments[0]!.start).toBeGreaterThanOrEqual(30);
  });

  it("assigns SwitchingSet.id as type:codec for video and type:codec:language for audio", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const video = findVideo(manifest);
    const audio = findAudio(manifest);
    expect(video.id).toBe("video:avc1.64001f");
    expect(audio.id).toBe("audio:mp4a.40.2:unk");
  });

  it("assigns Track.id from Representation@id", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
    const video = findVideo(manifest);
    const ids = video.tracks.map((t) => t.id).sort();
    expect(ids).toEqual(["1", "2"]);
  });

  it("sets isLive to false for a static MPD", () => {
    const manifest = DashParser.create(loadFixture("dash-parser/vod-basic.mpd"), sourceUrl);
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
    const text = loadFixture("dash-parser/vod-basic.mpd");
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
    const sourceText = loadFixture("dash-parser/vod-timeline.mpd");
    const manifest = DashParser.create(sourceText, sourceUrl);

    const video = findVideo(manifest);
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

  describe("update — live reconciliation", () => {
    it("appends new tail segments and prunes expired head segments", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const track = manifest.switchingSets[0]?.tracks[0];
      asserts.assertExists(track, "track not found");
      expect(track.segments.map((s) => s.start)).toEqual([0, 4, 8, 12, 16]);

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      // After update: DVR window shifted — start=0,4 pruned, start=20,24 appended
      expect(track.segments.map((s) => s.start)).toEqual([8, 12, 16, 20, 24]);
    });

    it("preserves object identity for overlapping segments across an update", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const track = manifest.switchingSets[0]?.tracks[0];
      asserts.assertExists(track, "track not found");
      const kept = [
        track.segments[2],
        track.segments[3],
        track.segments[4],
      ];
      asserts.assertExists(kept[0], "kept[0]");
      asserts.assertExists(kept[1], "kept[1]");
      asserts.assertExists(kept[2], "kept[2]");

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      // Segments that straddle both MPD snapshots must remain the same object refs.
      expect(track.segments[0]).toBe(kept[0]);
      expect(track.segments[1]).toBe(kept[1]);
      expect(track.segments[2]).toBe(kept[2]);
    });

    it("preserves Track and SwitchingSet identity across an update", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const switchingSet = manifest.switchingSets[0];
      asserts.assertExists(switchingSet, "switchingSet not found");
      const track = switchingSet.tracks[0];
      asserts.assertExists(track, "track not found");
      const segmentsArray = track.segments;

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      expect(manifest.switchingSets[0]).toBe(switchingSet);
      expect(switchingSet.tracks[0]).toBe(track);
      expect(switchingSet.tracks[0]?.segments).toBe(segmentsArray);
    });

    it("preserves references for every segment across a multi-period update", () => {
      const text = loadFixture("dash-parser/vod-multi-period.mpd");
      const manifest = DashParser.create(text, sourceUrl);

      const switchingSetsRef = manifest.switchingSets;
      const video = findVideo(manifest);
      const audio = findAudio(manifest);
      const videoTrack = video.tracks[0]!;
      const audioTrack = audio.tracks[0]!;
      const videoSegmentsRef = videoTrack.segments;
      const audioSegmentsRef = audioTrack.segments;
      const videoSegmentsSnapshot = [...videoSegmentsRef];
      const audioSegmentsSnapshot = [...audioSegmentsRef];
      const videoInitSegment = videoSegmentsRef[0]!.initSegment;
      const audioInitSegment = audioSegmentsRef[0]!.initSegment;

      DashParser.update(manifest, text, sourceUrl);

      expect(manifest.switchingSets).toBe(switchingSetsRef);
      expect(
        manifest.switchingSets.find((ss) => ss.type === MediaType.VIDEO),
      ).toBe(video);
      expect(
        manifest.switchingSets.find((ss) => ss.type === MediaType.AUDIO),
      ).toBe(audio);
      expect(video.tracks[0]).toBe(videoTrack);
      expect(audio.tracks[0]).toBe(audioTrack);
      expect(videoTrack.segments).toBe(videoSegmentsRef);
      expect(audioTrack.segments).toBe(audioSegmentsRef);

      // Every segment — including those spanning both periods — must keep
      // its identity so downstream consumers' caches stay valid.
      expect(videoTrack.segments).toHaveLength(videoSegmentsSnapshot.length);
      for (let i = 0; i < videoSegmentsSnapshot.length; i++) {
        expect(videoTrack.segments[i]).toBe(videoSegmentsSnapshot[i]);
      }
      expect(audioTrack.segments).toHaveLength(audioSegmentsSnapshot.length);
      for (let i = 0; i < audioSegmentsSnapshot.length; i++) {
        expect(audioTrack.segments[i]).toBe(audioSegmentsSnapshot[i]);
      }
      expect(videoTrack.segments[0]!.initSegment).toBe(videoInitSegment);
      expect(audioTrack.segments[0]!.initSegment).toBe(audioInitSegment);
    });

    it("uses the refreshed MPD's first-segment start as the prune watermark", () => {
      // Edge case flagged in Task 7 review: first <S> in the updated MPD
      // has t != 0 (timeline-2 starts at t=8000 ms → start=8s).
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const track = manifest.switchingSets[0]?.tracks[0];
      asserts.assertExists(track, "track not found");

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      // Head trimmed to the MPD's new earliest start (8), not 0.
      expect(track.segments[0]?.start).toBe(8);
    });
  });
});
