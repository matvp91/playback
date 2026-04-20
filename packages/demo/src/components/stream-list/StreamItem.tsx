import type { Stream } from "cmaf-lite";
import { MediaType } from "cmaf-lite";
import { formatBandwidth } from "../../utils/stream";

type StreamItemProps = {
  stream: Stream;
  active: boolean;
  onClick: () => void;
};

export function StreamItem({ stream, active, onClick }: StreamItemProps) {
  return (
    <button
      className="flex cursor-pointer items-center gap-2"
      onClick={onClick}
      type="button"
    >
      {active && <span>●</span>}
      {stream.type === MediaType.VIDEO ? (
        <span>
          {stream.width}x{stream.height} · {formatBandwidth(stream.bandwidth)} ·{" "}
          {stream.codec}
        </span>
      ) : null}
      {stream.type === MediaType.AUDIO ? (
        <span>
          {formatBandwidth(stream.bandwidth)} · {stream.codec} ·{" "}
          {stream.language}
        </span>
      ) : null}
    </button>
  );
}
