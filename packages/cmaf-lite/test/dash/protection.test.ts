import { describe, expect, it } from "vitest";
import { readProtection } from "../../lib/dash/protection";
import { KeySystem } from "../../lib/types/media";
import * as XmlUtils from "../../lib/utils/xml_utils";
import { loadFixture } from "../fixtures";

function adaptationSetFrom(fixture: string) {
  const mpd = XmlUtils.parseXml(loadFixture(fixture), "MPD");
  const period = XmlUtils.children(mpd, "Period")[0]!;
  const adaptationSet = XmlUtils.children(period, "AdaptationSet")[0]!;
  const representations = XmlUtils.children(adaptationSet, "Representation");
  return { adaptationSet, representations };
}

describe("readProtection", () => {
  it("returns null when no ContentProtection elements are present", () => {
    const { adaptationSet, representations } = adaptationSetFrom(
      "dash-parser/vod-basic.mpd",
    );
    expect(readProtection(adaptationSet, representations)).toBeNull();
  });

  it("parses scheme and default_KID from mp4protection", () => {
    const { adaptationSet, representations } = adaptationSetFrom(
      "dash-parser/vod-protected-widevine-playready.mpd",
    );
    const p = readProtection(adaptationSet, representations)!;
    expect(p.scheme).toBe("cenc");
    expect(p.defaultKid).toBe("abcdef01-2345-6789-abcd-ef0123456789");
  });

  it("extracts Widevine and PlayReady PSSH bytes", () => {
    const { adaptationSet, representations } = adaptationSetFrom(
      "dash-parser/vod-protected-widevine-playready.mpd",
    );
    const p = readProtection(adaptationSet, representations)!;
    expect(p.keySystems[KeySystem.WIDEVINE]?.pssh).toBeInstanceOf(Uint8Array);
    expect(p.keySystems[KeySystem.WIDEVINE]?.pssh?.byteLength).toBeGreaterThan(
      0,
    );
    expect(p.keySystems[KeySystem.PLAYREADY]?.pssh).toBeInstanceOf(Uint8Array);
  });

  it("extracts FairPlay contentId from skd:// URI", () => {
    const { adaptationSet, representations } = adaptationSetFrom(
      "dash-parser/vod-protected-fairplay.mpd",
    );
    const p = readProtection(adaptationSet, representations)!;
    expect(p.scheme).toBe("cbcs");
    expect(p.keySystems[KeySystem.FAIRPLAY]?.contentId).toBe(
      "skd://example/abc123",
    );
  });

  it("drops unknown ContentProtection UUIDs silently", () => {
    const { adaptationSet, representations } = adaptationSetFrom(
      "dash-parser/vod-protected-mp4protection-only.mpd",
    );
    const p = readProtection(adaptationSet, representations)!;
    expect(p.scheme).toBe("cenc");
    expect(p.keySystems).toEqual({});
  });

  it("falls back to the first Representation when AdaptationSet has no ContentProtection", () => {
    const { adaptationSet, representations } = adaptationSetFrom(
      "dash-parser/vod-protected-representation-level.mpd",
    );
    const p = readProtection(adaptationSet, representations)!;
    expect(p.scheme).toBe("cenc");
    expect(p.defaultKid).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    expect(p.keySystems[KeySystem.WIDEVINE]?.pssh).toBeInstanceOf(Uint8Array);
  });
});
