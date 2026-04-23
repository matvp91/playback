import type * as txml from "txml";
import * as asserts from "../utils/asserts";
import * as XmlUtils from "../utils/xml_utils";
import { upsertSwitchingSet } from "./adaptation_set";
import type { ApplyContext } from "./context";
import { upsertTrack } from "./representation";
import { appendSegments } from "./segment";

export function applyPeriods(
  ctx: ApplyContext,
  sourceUrl: string,
  mpd: txml.TNode,
  periods: txml.TNode[],
): void {
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    asserts.assertExists(period, "Period not found");
    const periodDuration = resolvePeriodDuration(mpd, periods, i);

    for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
      const representations = XmlUtils.children(
        adaptationSet,
        "Representation",
      );
      if (representations.length === 0) {
        continue;
      }

      const switchingSet = upsertSwitchingSet(
        ctx,
        adaptationSet,
        representations,
      );

      for (const representation of representations) {
        const track = upsertTrack(
          ctx,
          switchingSet,
          adaptationSet,
          representation,
        );
        const max = appendSegments(
          track.segments,
          sourceUrl,
          mpd,
          period,
          adaptationSet,
          representation,
          periodDuration,
        );
        track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
      }
    }
  }
}

function resolvePeriodDuration(
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
