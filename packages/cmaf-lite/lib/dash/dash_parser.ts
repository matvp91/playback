import { processUriTemplate } from "@svta/cml-dash";
import type * as txml from "txml";
import type {
  InitSegment,
  Manifest,
  Segment,
  SwitchingSet,
  Track,
} from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as LanguageUtils from "../utils/language_utils";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";
import {
  resolveBaseUrl,
  resolveCodec,
  resolveDuration,
  resolvePeriodDuration,
  resolveSegmentTemplate,
  resolveType,
} from "./dash_helpers";

/**
 * Transient upsert index for a single `readMpd` call. `sets` aliases
 * `manifest.switchingSets` — pushing through the context mutates the
 * manifest in place, which is what preserves identity across updates.
 */
type ReadContext = {
  sets: SwitchingSet[];
  switchingSetsById: Map<string, SwitchingSet>;
  tracksById: Map<string, Track>;
  mpd: txml.TNode;
  sourceUrl: string;
};

export function parseManifest(text: string, sourceUrl: string): Manifest {
  const manifest: Manifest = { duration: 0, switchingSets: [] };
  readMpd(manifest, text, sourceUrl);
  return manifest;
}

export function updateManifest(
  manifest: Manifest,
  text: string,
  sourceUrl: string,
): void {
  readMpd(manifest, text, sourceUrl);
}

function readMpd(manifest: Manifest, text: string, sourceUrl: string): void {
  const mpd = XmlUtils.parseXml(text, "MPD");

  const periods = XmlUtils.children(mpd, "Period");
  if (periods.length === 0) {
    throw new Error("No Period found in manifest");
  }

  const rc = createContext(manifest, mpd, sourceUrl);
  for (let i = 0; i < periods.length; i++) {
    readPeriod(rc, periods, i);
  }
  manifest.duration = resolveDuration(mpd, manifest.switchingSets);
}

function readPeriod(
  rc: ReadContext,
  periods: txml.TNode[],
  periodIndex: number,
): void {
  const period = periods[periodIndex];
  asserts.assertExists(period, "Period not found");
  const periodDuration = resolvePeriodDuration(rc.mpd, periods, periodIndex);

  for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
    readAdaptationSet(rc, period, adaptationSet, periodDuration);
  }
}

function readAdaptationSet(
  rc: ReadContext,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  periodDuration: number | null,
): void {
  const representations = XmlUtils.children(adaptationSet, "Representation");
  if (representations.length === 0) {
    return;
  }

  const switchingSet = upsertSwitchingSet(rc, adaptationSet, representations);

  for (const representation of representations) {
    readRepresentation(
      rc,
      period,
      adaptationSet,
      representation,
      switchingSet,
      periodDuration,
    );
  }
}

function readRepresentation(
  rc: ReadContext,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  switchingSet: SwitchingSet,
  periodDuration: number | null,
): void {
  const track = upsertTrack(rc, switchingSet, adaptationSet, representation);
  const max = appendSegments(
    track.segments,
    rc,
    period,
    adaptationSet,
    representation,
    periodDuration,
  );
  track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
}

function createContext(
  manifest: Manifest,
  mpd: txml.TNode,
  sourceUrl: string,
): ReadContext {
  const rc: ReadContext = {
    sets: manifest.switchingSets,
    switchingSetsById: new Map(),
    tracksById: new Map(),
    mpd,
    sourceUrl,
  };
  for (const set of manifest.switchingSets) {
    rc.switchingSetsById.set(set.id, set);
    for (const track of set.tracks) {
      rc.tracksById.set(`${set.id}:${track.id}`, track);
    }
  }
  return rc;
}

function upsertSwitchingSet(
  rc: ReadContext,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const id = getAdaptationSetId(adaptationSet, representations);
  let set = rc.switchingSetsById.get(id);
  if (!set) {
    set = parseAdaptationSet(id, adaptationSet, representations);
    rc.switchingSetsById.set(id, set);
    rc.sets.push(set);
  }
  return set;
}

function upsertTrack(
  rc: ReadContext,
  switchingSet: SwitchingSet,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const trackId = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  asserts.assertExists(trackId, "Representation@id is mandatory");
  const key = `${switchingSet.id}:${trackId}`;
  let track = rc.tracksById.get(key);
  if (!track) {
    track = buildTrack(
      switchingSet.type,
      trackId,
      adaptationSet,
      representation,
    );
    asserts.assert(
      track.type === switchingSet.type,
      "Track type must match SwitchingSet type",
    );
    rc.tracksById.set(key, track);
    (switchingSet.tracks as Track[]).push(track);
  }
  return track;
}

function getAdaptationSetId(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const type = resolveType(adaptationSet, representations);
  const codec = resolveCodec(adaptationSet, representations);
  const id = `${type}:${codec}`;

  if (type === MediaType.VIDEO) {
    return id;
  }
  if (type === MediaType.AUDIO) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return `${id}:${language}`;
  }
  if (type === MediaType.SUBTITLE) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return `${id}:${language}`;
  }
  throw new Error("Unsupported media type");
}

function parseAdaptationSet(
  id: string,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const type = resolveType(adaptationSet, representations);
  const codec = resolveCodec(adaptationSet, representations);

  if (type === MediaType.VIDEO) {
    return {
      id,
      type,
      codec,
      tracks: [],
    };
  }
  if (type === MediaType.AUDIO) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return {
      id,
      type,
      codec,
      language,
      tracks: [],
    };
  }
  if (type === MediaType.SUBTITLE) {
    const language = LanguageUtils.toBCP47(
      XmlUtils.attr(adaptationSet, "lang", XmlUtils.parseString),
    );
    return {
      id,
      type,
      codec,
      language,
      tracks: [],
    };
  }
  throw new Error("Unsupported media type");
}

function buildTrack(
  type: MediaType,
  id: string,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const bandwidth = XmlUtils.attr(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );
  asserts.assertExists(bandwidth, "bandwidth is mandatory");

  if (type === MediaType.VIDEO) {
    const width = Functional.findMap([representation, adaptationSet], (n) =>
      XmlUtils.attr(n, "width", XmlUtils.parseNumber),
    );
    asserts.assertExists(width, "width is mandatory");
    const height = Functional.findMap([representation, adaptationSet], (n) =>
      XmlUtils.attr(n, "height", XmlUtils.parseNumber),
    );
    asserts.assertExists(height, "height is mandatory");
    return {
      id,
      type,
      width,
      height,
      bandwidth,
      segments: [],
      maxSegmentDuration: 0,
    };
  }
  if (type === MediaType.AUDIO) {
    return { id, type, bandwidth, segments: [], maxSegmentDuration: 0 };
  }
  if (type === MediaType.SUBTITLE) {
    return { id, type, bandwidth, segments: [], maxSegmentDuration: 0 };
  }
  throw new Error("Unsupported media type");
}

function appendSegments(
  target: Segment[],
  rc: ReadContext,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodDuration: number | null,
): number {
  const baseUrl = resolveBaseUrl(
    rc.sourceUrl,
    rc.mpd,
    period,
    adaptationSet,
    representation,
  );
  const bandwidth = XmlUtils.attr(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );
  asserts.assertExists(bandwidth, "bandwidth is mandatory");

  const st = resolveSegmentTemplate(period, adaptationSet, representation);

  const initialization = XmlUtils.attr(
    st,
    "initialization",
    XmlUtils.parseString,
  );
  asserts.assertExists(initialization, "initialization is mandatory");
  const media = XmlUtils.attr(st, "media", XmlUtils.parseString);
  asserts.assertExists(media, "media is mandatory");

  const id = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  const timescale = XmlUtils.attr(st, "timescale", XmlUtils.parseNumber) ?? 1;
  const startNumber =
    XmlUtils.attr(st, "startNumber", XmlUtils.parseNumber) ?? 1;
  const pto =
    XmlUtils.attr(st, "presentationTimeOffset", XmlUtils.parseNumber) ?? 0;
  const periodStart =
    XmlUtils.attr(period, "start", XmlUtils.parseDuration) ?? 0;

  const initSegment: InitSegment = {
    url: UrlUtils.resolveUrl(
      processUriTemplate(initialization, id, null, null, bandwidth, null),
      baseUrl,
    ),
  };

  let maxSegmentDuration = 0;

  const timeline = XmlUtils.child(st, "SegmentTimeline");
  if (timeline) {
    let time = 0;
    let number = startNumber;
    for (const s of XmlUtils.children(timeline, "S")) {
      const duration = XmlUtils.attr(s, "d", XmlUtils.parseNumber);
      asserts.assertExists(duration, "segment duration is mandatory");
      const r = XmlUtils.attr(s, "r", XmlUtils.parseNumber) ?? 0;
      time = XmlUtils.attr(s, "t", XmlUtils.parseNumber) ?? time;
      for (let i = 0; i <= r; i++) {
        const url = UrlUtils.resolveUrl(
          processUriTemplate(media, id, number, null, bandwidth, time),
          baseUrl,
        );
        const start = (time - pto) / timescale + periodStart;
        const end = (time - pto + duration) / timescale + periodStart;
        target.push({ url, start, end, initSegment });
        maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
        time += duration;
        number++;
      }
    }
    return maxSegmentDuration;
  }

  const duration = XmlUtils.attr(st, "duration", XmlUtils.parseNumber);
  asserts.assertExists(
    duration,
    "SegmentTemplate requires either SegmentTimeline or @duration",
  );
  asserts.assertExists(
    periodDuration,
    "Duration-based addressing requires a resolvable period duration",
  );

  const count = Math.ceil(periodDuration / (duration / timescale));
  for (let i = 0; i < count; i++) {
    const number = startNumber + i;
    const time = i * duration;
    const url = UrlUtils.resolveUrl(
      processUriTemplate(media, id, number, null, bandwidth, time),
      baseUrl,
    );
    const start = (time - pto) / timescale + periodStart;
    const end = (time - pto + duration) / timescale + periodStart;
    target.push({ url, start, end, initSegment });
    maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
  }
  return maxSegmentDuration;
}
