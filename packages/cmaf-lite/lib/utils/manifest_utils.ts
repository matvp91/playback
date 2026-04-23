import type { InitSegment, Segment } from "../types/manifest";

export function isMediaSegment(
  segment: Segment | InitSegment,
): segment is Segment {
  return "initSegment" in segment;
}

export function isInitSegment(
  segment: Segment | InitSegment,
): segment is InitSegment {
  return !isMediaSegment(segment);
}

/**
 * Remove segments from `target` whose `start` falls within
 * `[periodStart, firstKeptStart)`. Scoped to a single period's range
 * so multi-period updates only prune their own contributions.
 * Preserves object identity for all kept segments.
 */
export function pruneSegments(
  target: Segment[],
  periodStart: number,
  firstKeptStart: number,
): void {
  let from = 0;
  let count = 0;
  for (const segment of target) {
    if (segment.start < periodStart) {
      from++;
      continue;
    }
    if (segment.start >= firstKeptStart) {
      break;
    }
    count++;
  }
  if (count > 0) {
    target.splice(from, count);
  }
}
