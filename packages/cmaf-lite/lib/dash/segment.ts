import { processUriTemplate } from "@svta/cml-dash";
import type * as txml from "txml";
import type { InitSegment, Segment } from "../types/manifest";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";

export function appendSegments(
  target: Segment[],
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodDuration: number | null,
): number {
  const baseUrl = resolveBaseUrl(
    sourceUrl,
    mpd,
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
    ...baseUrls.filter((u): u is string => u != null),
  ]);
}

function resolveSegmentTemplate(
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): txml.TNode {
  const templates = [
    XmlUtils.child(representation, "SegmentTemplate"),
    XmlUtils.child(adaptationSet, "SegmentTemplate"),
    XmlUtils.child(period, "SegmentTemplate"),
  ].filter((t): t is txml.TNode => t !== undefined);

  if (templates.length === 0) {
    throw new Error("We've got to have some sort of templating");
  }

  const attributes: Record<string, string | null> = {};
  for (const t of templates.slice().reverse()) {
    Object.assign(attributes, t.attributes);
  }

  const segmentTimeline = Functional.findMap(templates, (t) =>
    XmlUtils.child(t, "SegmentTimeline"),
  );

  return {
    tagName: "SegmentTemplate",
    attributes,
    children: segmentTimeline ? [segmentTimeline] : [],
  };
}
