export const EMPTY_ARRAY = [];

export const EMPTY_TIME_RANGES: TimeRanges = {
  length: 0,
  start: (_index: number) => {
    throw new DOMException("IndexSizeError");
  },
  end: (_index: number) => {
    throw new DOMException("IndexSizeError");
  },
};
