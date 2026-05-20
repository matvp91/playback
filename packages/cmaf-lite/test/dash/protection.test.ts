import { describe, expect, it } from "vitest";
import { readProtection } from "../../lib/dash/protection";
import { KeySystem } from "../../lib/types/media";
import * as XmlUtils from "../../lib/utils/xml_utils";
import { loadFixture } from "../fixtures";

function adaptationSetFrom(fixture: string) {
  const mpd = XmlUtils.parseXml(loadFixture(fixture), "MPD");
  const period = XmlUtils.children(mpd, "Period")[0]!;
  return XmlUtils.children(period, "AdaptationSet")[0]!;
}

describe("readProtection", () => {
  it("returns null when no ContentProtection elements are present", () => {
    expect(
      readProtection(adaptationSetFrom("dash-parser/vod-basic.mpd")),
    ).toBeNull();
  });

  it("parses scheme and default_KID from mp4protection", () => {
    const p = readProtection(
      adaptationSetFrom("dash-parser/vod-protected-widevine-playready.mpd"),
    )!;
    expect(p.scheme).toBe("cenc");
    expect(p.defaultKid).toBe("abcdef01-2345-6789-abcd-ef0123456789");
  });

  it("extracts Widevine and PlayReady PSSH bytes", () => {
    const p = readProtection(
      adaptationSetFrom("dash-parser/vod-protected-widevine-playready.mpd"),
    )!;
    expect(p.keySystems[KeySystem.WIDEVINE]?.pssh).toBeInstanceOf(Uint8Array);
    expect(
      p.keySystems[KeySystem.WIDEVINE]?.pssh?.byteLength,
    ).toBeGreaterThan(0);
    expect(p.keySystems[KeySystem.PLAYREADY]?.pssh).toBeInstanceOf(Uint8Array);
  });

  it("extracts FairPlay contentId from skd:// URI", () => {
    const p = readProtection(
      adaptationSetFrom("dash-parser/vod-protected-fairplay.mpd"),
    )!;
    expect(p.scheme).toBe("cbcs");
    expect(p.keySystems[KeySystem.FAIRPLAY]?.contentId).toBe(
      "skd://example/abc123",
    );
  });

  it("drops unknown ContentProtection UUIDs silently", () => {
    const p = readProtection(
      adaptationSetFrom("dash-parser/vod-protected-mp4protection-only.mpd"),
    )!;
    expect(p.scheme).toBe("cenc");
    expect(p.keySystems).toEqual({});
  });
});
