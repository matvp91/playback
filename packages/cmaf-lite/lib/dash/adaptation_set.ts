import type * as txml from "txml";
import type { SwitchingSet } from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as LanguageUtils from "../utils/language_utils";
import * as XmlUtils from "../utils/xml_utils";
import type { ApplyContext } from "./context";

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
