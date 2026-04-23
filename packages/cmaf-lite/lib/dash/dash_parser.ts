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
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";
import {
  resolveBaseUrl,
  resolveCodec,
  resolveDuration,
  resolveLanguage,
  resolvePeriodDuration,
  resolveSegmentTemplate,
  resolveType,
} from "./dash_helpers";

type ReadContext = {
  sets: SwitchingSet[];
  switchingSetsById: Map<string, SwitchingSet>;
  tracksById: Map<string, Track>;
  sourceUrl: string;
};

export function create(text: string, sourceUrl: string): Manifest {
  const manifest: Manifest = { duration: 0, isLive: false, switchingSets: [] };
  const mpd = XmlUtils.parseXml(text, "MPD");
  readMpd(manifest, mpd, sourceUrl);
  return manifest;
}

export function update(
  manifest: Manifest,
  text: string,
  sourceUrl: string,
): void {
  const mpd = XmlUtils.parseXml(text, "MPD");
  readMpd(manifest, mpd, sourceUrl);
}

function readMpd(manifest: Manifest, mpd: txml.TNode, sourceUrl: string): void {
  const periods = XmlUtils.children(mpd, "Period");
  if (periods.length === 0) {
    throw new Error("No Period found in manifest");
  }

  const ctx = createContext(manifest, sourceUrl);
  for (let i = 0; i < periods.length; i++) {
    readPeriod(ctx, mpd, periods, i);
  }

  const type = XmlUtils.attr(mpd, "type", XmlUtils.parseString);
  manifest.isLive = type === "dynamic";
  manifest.duration = resolveDuration(mpd, manifest.switchingSets);
}

function readPeriod(
  ctx: ReadContext,
  mpd: txml.TNode,
  periods: txml.TNode[],
  periodIndex: number,
): void {
  const period = periods[periodIndex];
  asserts.assertExists(period, "Period not found");
  const periodDuration = resolvePeriodDuration(mpd, periods, periodIndex);

  for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
    readAdaptationSet(ctx, mpd, period, adaptationSet, periodDuration);
  }
}

function readAdaptationSet(
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  periodDuration: number | null,
): void {
  const representations = XmlUtils.children(adaptationSet, "Representation");
  if (representations.length === 0) {
    return;
  }

  const switchingSet = upsertSwitchingSet(ctx, adaptationSet, representations);

  for (const representation of representations) {
    readRepresentation(
      ctx,
      mpd,
      period,
      adaptationSet,
      representation,
      switchingSet,
      periodDuration,
    );
  }
}

function readRepresentation(
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  switchingSet: SwitchingSet,
  periodDuration: number | null,
): void {
  const track = upsertTrack(ctx, switchingSet, adaptationSet, representation);
  const max = appendSegments(
    track.segments,
    ctx,
    mpd,
    period,
    adaptationSet,
    representation,
    periodDuration,
  );
  track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
}

function createContext(manifest: Manifest, sourceUrl: string): ReadContext {
  const ctx: ReadContext = {
    sets: manifest.switchingSets,
    switchingSetsById: new Map(),
    tracksById: new Map(),
    sourceUrl,
  };
  for (const switchingSet of manifest.switchingSets) {
    ctx.switchingSetsById.set(switchingSet.id, switchingSet);
    for (const track of switchingSet.tracks) {
      ctx.tracksById.set(`${switchingSet.id}:${track.id}`, track);
    }
  }
  return ctx;
}

function upsertSwitchingSet(
  ctx: ReadContext,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const id = getAdaptationSetId(adaptationSet, representations);
  return ctx.switchingSetsById.getOrInsertComputed(id, () => {
    const switchingSet = parseAdaptationSet(id, adaptationSet, representations);
    ctx.sets.push(switchingSet);
    return switchingSet;
  });
}

function upsertTrack(
  ctx: ReadContext,
  switchingSet: SwitchingSet,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const id = XmlUtils.attrRequired(representation, "id", XmlUtils.parseString);
  const key = `${switchingSet.id}:${id}`;
  return ctx.tracksById.getOrInsertComputed(key, () => {
    const track = buildTrack(
      switchingSet.type,
      id,
      adaptationSet,
      representation,
    );
    // We'll have to cast tracks to Track as it is the overarching type,
    // but we'll know that type is matching because we created the
    // track with the same type as the switchingSet.
    (switchingSet.tracks as Track[]).push(track);
    return track;
  });
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
    const language = resolveLanguage(adaptationSet);
    return `${id}:${language}`;
  }
  if (type === MediaType.SUBTITLE) {
    const language = resolveLanguage(adaptationSet);
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
    const language = resolveLanguage(adaptationSet);
    return {
      id,
      type,
      codec,
      language,
      tracks: [],
    };
  }
  if (type === MediaType.SUBTITLE) {
    const language = resolveLanguage(adaptationSet);
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
  const bandwidth = XmlUtils.attrRequired(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );

  if (type === MediaType.VIDEO) {
    const width = Functional.findMap([representation, adaptationSet], (node) =>
      XmlUtils.attr(node, "width", XmlUtils.parseNumber),
    );
    asserts.assertExists(width, "width is mandatory");
    const height = Functional.findMap([representation, adaptationSet], (node) =>
      XmlUtils.attr(node, "height", XmlUtils.parseNumber),
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
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodDuration: number | null,
): number {
  const baseUrl = resolveBaseUrl(
    ctx.sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
  );
  const bandwidth = XmlUtils.attrRequired(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );

  const segmentTemplate = resolveSegmentTemplate(
    period,
    adaptationSet,
    representation,
  );

  const initialization = XmlUtils.attrRequired(
    segmentTemplate,
    "initialization",
    XmlUtils.parseString,
  );
  const media = XmlUtils.attrRequired(
    segmentTemplate,
    "media",
    XmlUtils.parseString,
  );
  const id = XmlUtils.attrRequired(representation, "id", XmlUtils.parseString);

  const timescale = XmlUtils.attr(
    segmentTemplate,
    "timescale",
    XmlUtils.parseNumber,
    1,
  );
  const startNumber = XmlUtils.attr(
    segmentTemplate,
    "startNumber",
    XmlUtils.parseNumber,
    1,
  );
  const presentationTimeOffset = XmlUtils.attr(
    segmentTemplate,
    "presentationTimeOffset",
    XmlUtils.parseNumber,
    0,
  );
  const periodStart = XmlUtils.attr(period, "start", XmlUtils.parseDuration, 0);

  const uri = processUriTemplate(
    initialization,
    id,
    null,
    null,
    bandwidth,
    null,
  );
  const initSegment: InitSegment = {
    url: UrlUtils.resolveUrl(uri, baseUrl),
  };

  let maxSegmentDuration = 0;

  const timeline = XmlUtils.child(segmentTemplate, "SegmentTimeline");
  if (timeline) {
    let time = 0;
    let number = startNumber;
    for (const timelineEntry of XmlUtils.children(timeline, "S")) {
      const duration = XmlUtils.attrRequired(
        timelineEntry,
        "d",
        XmlUtils.parseNumber,
      );
      const repeat = XmlUtils.attr(timelineEntry, "r", XmlUtils.parseNumber, 0);
      time = XmlUtils.attr(timelineEntry, "t", XmlUtils.parseNumber, time);

      for (let i = 0; i <= repeat; i++) {
        const uri = processUriTemplate(
          media,
          id,
          number,
          null,
          bandwidth,
          time,
        );

        const url = UrlUtils.resolveUrl(uri, baseUrl);
        const start = (time - presentationTimeOffset) / timescale + periodStart;
        const end =
          (time - presentationTimeOffset + duration) / timescale + periodStart;

        target.push({ url, start, end, initSegment });

        maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
        time += duration;
        number++;
      }
    }

    return maxSegmentDuration;
  }

  asserts.assertExists(
    periodDuration,
    "Duration-based addressing requires a resolvable period duration",
  );

  const duration = XmlUtils.attrRequired(
    segmentTemplate,
    "duration",
    XmlUtils.parseNumber,
  );

  const count = Math.ceil(periodDuration / (duration / timescale));
  for (let i = 0; i < count; i++) {
    const number = startNumber + i;
    const time = i * duration;
    const uri = processUriTemplate(media, id, number, null, bandwidth, time);
    const url = UrlUtils.resolveUrl(uri, baseUrl);
    const start = (time - presentationTimeOffset) / timescale + periodStart;
    const end =
      (time - presentationTimeOffset + duration) / timescale + periodStart;
    target.push({ url, start, end, initSegment });
    maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
  }

  return maxSegmentDuration;
}
