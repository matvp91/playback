import type { Stream } from "cmaf-lite";
import { MediaType } from "cmaf-lite";
import prettyBytes from "pretty-bytes";

/**
 * Formats bandwidth as a human-readable string.
 */
export function formatBandwidth(bps: number): string {
  return `${prettyBytes(bps, { bits: true })}/s`;
}

/**
 * Formats a stream as a human-readable label.
 * Used as display text and as select value/React key.
 */
export function formatStream(stream: Stream): string {
  let format = `${formatBandwidth(stream.bandwidth)} · ${stream.codec}`;
  if (stream.type === MediaType.VIDEO) {
    format = `${stream.width}x${stream.height} · ${format}`;
  }
  if (stream.type === MediaType.AUDIO) {
    return `${stream.language} · ${format}`;
  }
  return format;
}
