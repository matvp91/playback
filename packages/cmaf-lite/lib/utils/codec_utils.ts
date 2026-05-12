import type { MediaType } from "../types/media";

/**
 * Get MSE content type from MediaType and codec.
 * Assumes CMAF-compliant fMP4 container.
 */
export function getContentType(type: MediaType, codec: string) {
  return `${type}/mp4; codecs="${codec}"`;
}

/**
 * Extract the base component from a codec string.
 * Returns the full string when no profile is present.
 */
export function getCodecBase(codec: string): string {
  const idx = codec.indexOf(".");
  return idx === -1 ? codec : codec.substring(0, idx);
}

/**
 * Extract the profile component from a codec string.
 * Returns null when no profile is present.
 */
export function getCodecProfile(codec: string): string | null {
  const idx = codec.indexOf(".");
  return idx === -1 ? null : codec.substring(idx + 1);
}

/**
 * Normalize a full RFC 6381 codec string to a
 * canonical codec family name.
 */
export function getNormalizedCodec(codec: string): string {
  const base = getCodecBase(codec).toLowerCase();
  const profile = getCodecProfile(codec)?.toLowerCase();

  switch (true) {
    // AAC
    case base === "mp4a" && profile === "66":
    case base === "mp4a" && profile === "67":
    case base === "mp4a" && profile === "68":
    case base === "mp4a" && profile === "40.2":
    case base === "mp4a" && profile === "40.02":
    case base === "mp4a" && profile === "40.5":
    case base === "mp4a" && profile === "40.05":
    case base === "mp4a" && profile === "40.29":
    case base === "mp4a" && profile === "40.42":
      return "aac";
    // AC-3
    case base === "ac-3":
      return "ac-3";
    // EC-3
    case base === "ec-3":
      return "ec-3";
    // H.264
    case base === "avc1":
    case base === "avc3":
      return "avc";
    // H.265
    case base === "hev1":
    case base === "hvc1":
      return "hevc";
    // AV1
    case base === "av01":
      return "av1";
    case base === "wvtt":
      return "vtt";
    case base === "stpp":
      return "imsc1";
    default:
      throw new Error(`Unsupported codec: ${codec}`);
  }
}
