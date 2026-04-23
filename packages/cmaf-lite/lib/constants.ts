export const EMPTY_ARRAY = Object.freeze([]);

export const EMPTY_TIME_RANGES: TimeRanges = Object.freeze({
  length: 0,
  start: (_index: number) => {
    throw new DOMException("IndexSizeError");
  },
  end: (_index: number) => {
    throw new DOMException("IndexSizeError");
  },
});
