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
 * Remove segments from the head of `target` whose `start` is below
 * `firstKeptStart`. O(k) where k is the number removed — bounded by
 * the DVR window shift per refresh. Preserves object identity for
 * all kept segments.
 */
export function pruneSegments(target: Segment[], firstKeptStart: number): void {
  let count = 0;
  for (const segment of target) {
    if (segment.start >= firstKeptStart) {
      break;
    }
    count++;
  }
  if (count > 0) {
    target.splice(0, count);
  }
}
