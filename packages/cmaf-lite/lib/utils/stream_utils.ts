import type { Manifest, SwitchingSet, Track } from "../types/manifest";
import type { Preference, Stream } from "../types/media";
import { MediaType } from "../types/media";
import * as asserts from "./asserts";
import * as CodecUtils from "./codec_utils";

export function buildStreams(manifest: Manifest): Map<MediaType, Stream[]> {
  const result = new Map<MediaType, Stream[]>([
    [MediaType.VIDEO, []],
    [MediaType.AUDIO, []],
  ]);
  for (const ss of manifest.switchingSets) {
    for (const track of ss.tracks) {
      const stream = projectStream(ss, track);
      const list = result.get(stream.type);
      asserts.assertExists(list, `No list for ${stream.type}`);
      list.push(stream);
    }
  }
  // Sorted by bandwidth ascending — index 0 is lowest quality.
  // Required for ABR rules to reason about the quality ladder.
  for (const streams of result.values()) {
    streams.sort((a, b) => a.bandwidth - b.bandwidth);
  }
  return result;
}

export function findStreamsMatchingPreferences(
  type: MediaType,
  streams: Stream[],
  preferences: Preference[],
): Stream[] {
  asserts.assertExists(streams[0], "No Streams");

  for (const preference of preferences) {
    if (preference.type !== type) {
      continue;
    }
    const matches = streams.filter((s) => matchesPreference(s, preference));
    if (matches.length === 0) {
      continue;
    }
    return matches;
  }

  return [];
}

function matchesPreference(stream: Stream, preference: Preference): boolean {
  if (stream.type !== preference.type) {
    throw new Error("Type is not the same for matching");
  }

  // BasePreference comparison
  if (preference.codec !== undefined) {
    if (stream.codec !== preference.codec) {
      return false;
    }
  }

  // TODO(matvp): language/channels matching once those fields
  // are added to AudioStream/SubtitleStream.

  return true;
}

function projectStream(ss: SwitchingSet, track: Track): Stream {
  const codec = CodecUtils.getNormalizedCodec(ss.codec);
  if (track.type === MediaType.VIDEO && ss.type === MediaType.VIDEO) {
    return {
      type: track.type,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      hierarchy: {
        switchingSet: ss,
        track,
      },
    };
  }
  if (track.type === MediaType.AUDIO && ss.type === MediaType.AUDIO) {
    return {
      type: track.type,
      codec,
      bandwidth: track.bandwidth,
      language: ss.language,
      hierarchy: {
        switchingSet: ss,
        track,
      },
    };
  }
  throw new Error(`Failed to map track for type ${track.type}`);
}

export function pickClosestByBandwidth(
  streams: Stream[],
  lookupStream: Stream,
): Stream | null {
  if (!streams[0]) {
    return null;
  }
  let best = streams[0];
  let bestDelta = Math.abs(best.bandwidth - lookupStream.bandwidth);
  for (let i = 1; i < streams.length; i++) {
    const candidate = streams[i];
    if (candidate === undefined) {
      break;
    }
    const delta = Math.abs(candidate.bandwidth - lookupStream.bandwidth);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}
