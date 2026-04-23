import type * as txml from "txml";
import type { Manifest, SwitchingSet } from "../types/manifest";
import * as asserts from "../utils/asserts";
import * as XmlUtils from "../utils/xml_utils";
import { createContext } from "./context";
import { applyPeriods } from "./period";

export function parseManifest(text: string, sourceUrl: string): Manifest {
  const manifest: Manifest = { duration: 0, switchingSets: [] };
  applyMpd(manifest, text, sourceUrl);
  return manifest;
}

export function updateManifest(
  manifest: Manifest,
  text: string,
  sourceUrl: string,
): void {
  applyMpd(manifest, text, sourceUrl);
}

function applyMpd(manifest: Manifest, text: string, sourceUrl: string): void {
  const mpd = XmlUtils.parseXml(text, "MPD");

  const periods = XmlUtils.children(mpd, "Period");
  if (periods.length === 0) {
    throw new Error("No Period found in manifest");
  }

  const ctx = createContext(manifest);
  applyPeriods(ctx, sourceUrl, mpd, periods);
  manifest.duration = resolveDuration(mpd, manifest.switchingSets);
}

function resolveDuration(
  mpd: txml.TNode,
  switchingSets: SwitchingSet[],
): number {
  const mpdDuration = XmlUtils.attr(
    mpd,
    "mediaPresentationDuration",
    XmlUtils.parseDuration,
  );
  if (mpdDuration != null) {
    return mpdDuration;
  }

  const lastSegmentEnd = switchingSets[0]?.tracks[0]?.segments.at(-1)?.end;
  asserts.assertExists(lastSegmentEnd, "Cannot resolve duration");
  return lastSegmentEnd;
}
