import type * as txml from "txml";
import type { Manifest, SwitchingSet, Track } from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as LanguageUtils from "../utils/language_utils";
import * as XmlUtils from "../utils/xml_utils";

/**
 * Transient upsert index for a single `applyMpd` call. `sets` aliases
 * `manifest.switchingSets` — pushing through the context mutates the
 * manifest in place, which is what preserves identity across updates.
 */
export type ApplyContext = {
  sets: SwitchingSet[];
  switchingSetsById: Map<string, SwitchingSet>;
  tracksById: Map<string, Track>;
};

export function createContext(manifest: Manifest): ApplyContext {
  const ctx: ApplyContext = {
    sets: manifest.switchingSets,
    switchingSetsById: new Map(),
    tracksById: new Map(),
  };
  for (const set of manifest.switchingSets) {
    ctx.switchingSetsById.set(set.id, set);
    for (const track of set.tracks) {
      ctx.tracksById.set(`${set.id}:${track.id}`, track);
    }
  }
  return ctx;
}

export function upsertSwitchingSet(
  ctx: ApplyContext,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const id = getAdaptationSetId(adaptationSet, representations);
  let set = ctx.switchingSetsById.get(id);
  if (!set) {
    set = parseAdaptationSet(id, adaptationSet, representations);
    ctx.switchingSetsById.set(id, set);
    ctx.sets.push(set);
  }
  return set;
}

export function upsertTrack(
  ctx: ApplyContext,
  switchingSet: SwitchingSet,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const trackId = XmlUtils.attr(representation, "id", XmlUtils.parseString);
  asserts.assertExists(trackId, "Representation@id is mandatory");
  const key = `${switchingSet.id}:${trackId}`;
  let track = ctx.tracksById.get(key);
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
    ctx.tracksById.set(key, track);
    (switchingSet.tracks as Track[]).push(track);
  }
  return track;
}

export function getAdaptationSetId(
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

export function parseAdaptationSet(
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

export function buildTrack(
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

function resolveType(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): MediaType {
  const contentType = XmlUtils.attr(
    adaptationSet,
    "contentType",
    XmlUtils.parseString,
  );
  if (contentType === "video") {
    return MediaType.VIDEO;
  }
  if (contentType === "audio") {
    return MediaType.AUDIO;
  }
  if (contentType === "text") {
    return MediaType.SUBTITLE;
  }
  const mimeType =
    XmlUtils.attr(adaptationSet, "mimeType", XmlUtils.parseString) ??
    (representations[0]
      ? XmlUtils.attr(representations[0], "mimeType", XmlUtils.parseString)
      : undefined);
  if (mimeType?.startsWith("video/")) {
    return MediaType.VIDEO;
  }
  if (mimeType?.startsWith("audio/")) {
    return MediaType.AUDIO;
  }
  if (mimeType?.startsWith("text/") || mimeType?.startsWith("application/")) {
    return MediaType.SUBTITLE;
  }
  throw new Error("Failed to infer media type");
}

function resolveCodec(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const firstRep = representations[0];
  asserts.assertExists(firstRep, "No Representation found");

  const codec = Functional.findMap([firstRep, adaptationSet], (n) =>
    XmlUtils.attr(n, "codecs", XmlUtils.parseString),
  );
  asserts.assertExists(codec, "codecs is mandatory");

  return codec;
}
