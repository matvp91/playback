import type * as txml from "txml";
import type { SwitchingSet, Track } from "../types/manifest";
import * as asserts from "../utils/asserts";
import * as XmlUtils from "../utils/xml_utils";
import {
  buildTrack,
  getAdaptationSetId,
  parseAdaptationSet,
} from "./dash_adaptations";
import { appendSegments } from "./dash_segments";

export function flattenPeriods(
  sourceUrl: string,
  mpd: txml.TNode,
  periods: txml.TNode[],
): SwitchingSet[] {
  const switchingSetsById = new Map<string, SwitchingSet>();
  const tracksById = new Map<string, Track>();

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    asserts.assertExists(period, "Period not found");
    const duration = resolvePeriodDuration(mpd, periods, i);

    for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
      const representations = XmlUtils.children(
        adaptationSet,
        "Representation",
      );
      if (representations.length === 0) {
        continue;
      }

      const setId = getAdaptationSetId(adaptationSet, representations);
      let switchingSet = switchingSetsById.get(setId);
      if (!switchingSet) {
        switchingSet = parseAdaptationSet(adaptationSet, representations);
        switchingSetsById.set(setId, switchingSet);
      }

      for (const representation of representations) {
        const trackId = XmlUtils.attr(
          representation,
          "id",
          XmlUtils.parseString,
        );
        asserts.assertExists(trackId, "Representation@id is mandatory");
        const key = `${setId}:${trackId}`;

        let track = tracksById.get(key);
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
          tracksById.set(key, track);
          (switchingSet.tracks as Track[]).push(track);
        }

        const max = appendSegments(
          track.segments,
          sourceUrl,
          mpd,
          period,
          adaptationSet,
          representation,
          duration,
        );
        track.maxSegmentDuration = Math.max(track.maxSegmentDuration, max);
      }
    }
  }

  return [...switchingSetsById.values()];
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
