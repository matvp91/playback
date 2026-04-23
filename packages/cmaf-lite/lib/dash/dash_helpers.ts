import type * as txml from "txml";
import type { SwitchingSet } from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";

export function resolveType(
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

export function resolveCodec(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const firstRepresentation = representations[0];
  asserts.assertExists(firstRepresentation, "No Representation found");

  const codec = Functional.findMap(
    [firstRepresentation, adaptationSet],
    (node) => XmlUtils.attr(node, "codecs", XmlUtils.parseString),
  );
  asserts.assertExists(codec, "codecs is mandatory");

  return codec;
}

export function resolveSegmentTemplate(
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): txml.TNode {
  const templates = [
    XmlUtils.child(representation, "SegmentTemplate"),
    XmlUtils.child(adaptationSet, "SegmentTemplate"),
    XmlUtils.child(period, "SegmentTemplate"),
  ].filter((template): template is txml.TNode => template !== undefined);

  if (templates.length === 0) {
    throw new Error("We've got to have some sort of templating");
  }

  const attributes: Record<string, string | null> = {};
  for (const template of templates.slice().reverse()) {
    Object.assign(attributes, template.attributes);
  }

  const segmentTimeline = Functional.findMap(templates, (template) =>
    XmlUtils.child(template, "SegmentTimeline"),
  );

  return {
    tagName: "SegmentTemplate",
    attributes,
    children: segmentTimeline ? [segmentTimeline] : [],
  };
}

export function resolveBaseUrl(
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): string {
  const baseUrls = [mpd, period, adaptationSet, representation].flatMap(
    (node) => XmlUtils.children(node, "BaseURL").map(XmlUtils.text),
  );
  return UrlUtils.resolveUrls([
    sourceUrl,
    ...baseUrls.filter((url): url is string => url != null),
  ]);
}

export function resolvePeriodDuration(
  mpd: txml.TNode,
  periods: txml.TNode[],
  periodIndex: number,
): number | null {
  const period = periods[periodIndex];
  asserts.assertExists(period, "Period not found");

  const duration = XmlUtils.attr(period, "duration", XmlUtils.parseDuration);
  if (duration != null) {
    return duration;
  }

  const start = XmlUtils.attr(period, "start", XmlUtils.parseDuration) ?? 0;

  const nextPeriod = periods[periodIndex + 1];
  const nextStart = nextPeriod
    ? XmlUtils.attr(nextPeriod, "start", XmlUtils.parseDuration)
    : undefined;
  if (nextStart != null) {
    return nextStart - start;
  }

  const mpdDuration = XmlUtils.attr(
    mpd,
    "mediaPresentationDuration",
    XmlUtils.parseDuration,
  );
  if (mpdDuration != null) {
    return mpdDuration - start;
  }

  return null;
}

export function resolveDuration(
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
