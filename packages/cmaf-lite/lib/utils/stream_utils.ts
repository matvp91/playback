import { PROP_DECODING_INFO, PROP_HIERARCHY } from "../constants";
import type { Manifest, SwitchingSet, Track } from "../types/manifest";
import type { Preference, Stream } from "../types/media";
import { MediaType } from "../types/media";
import * as asserts from "./asserts";
import * as CodecUtils from "./codec_utils";

export async function buildStreams(
  manifest: Manifest,
): Promise<Map<MediaType, Stream[]>> {
  const promises: Promise<Stream | null>[] = [];
  for (const switchingSet of manifest.switchingSets) {
    for (const track of switchingSet.tracks) {
      promises.push(buildStream(switchingSet, track));
    }
  }

  const maybeStreams = await Promise.all(promises);
  const streams = maybeStreams.filter((s): s is Stream => s !== null);

  const result = new Map<MediaType, Stream[]>([
    [MediaType.VIDEO, []],
    [MediaType.AUDIO, []],
    [MediaType.SUBTITLE, []],
  ]);
  for (const stream of streams) {
    const list = result.get(stream.type);
    asserts.assertExists(list, `No list for ${stream.type}`);
    list.push(stream);
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

async function buildStream(
  switchingSet: SwitchingSet,
  track: Track,
): Promise<Stream | null> {
  const codec = CodecUtils.getNormalizedCodec(switchingSet.codec);
  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    const info = await probeDecodingInfo(switchingSet.codec, track);
    if (!info.supported) {
      return null;
    }
    return {
      type: MediaType.VIDEO,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
  }
  if (track.type === MediaType.AUDIO && switchingSet.type === MediaType.AUDIO) {
    const info = await probeDecodingInfo(switchingSet.codec, track);
    if (!info.supported) {
      return null;
    }
    return {
      type: MediaType.AUDIO,
      codec,
      bandwidth: track.bandwidth,
      language: switchingSet.language,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
  }
  if (
    track.type === MediaType.SUBTITLE &&
    switchingSet.type === MediaType.SUBTITLE
  ) {
    return {
      type: MediaType.SUBTITLE,
      codec,
      bandwidth: track.bandwidth,
      [PROP_HIERARCHY]: { switchingSet, track },
    };
  }
  throw new Error(`Failed to map track for type ${track.type}`);
}

async function probeDecodingInfo(
  codec: string,
  track: Track,
): Promise<MediaCapabilitiesDecodingInfo> {
  if (track.type === MediaType.VIDEO) {
    return navigator.mediaCapabilities.decodingInfo({
      type: "media-source",
      video: {
        contentType: `video/mp4; codecs="${codec}"`,
        width: track.width,
        height: track.height,
        bitrate: track.bandwidth,
        framerate: 30,
      },
    });
  }
  if (track.type === MediaType.AUDIO) {
    return navigator.mediaCapabilities.decodingInfo({
      type: "media-source",
      audio: {
        contentType: `audio/mp4; codecs="${codec}"`,
        bitrate: track.bandwidth,
        channels: "2",
        samplerate: 48000,
      },
    });
  }
  throw new Error(`Cannot probe track of type ${track.type}`);
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
