import type { BufferAppendedEvent, BufferFlushedEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";

/**
 * BOLA paper minimum-buffer constant (arxiv 1601.06748). The buffer
 * level at which BOLA prefers the lowest-bitrate stream. A real-world
 * time constant — does not scale with `frontBufferLength`.
 */
const MINIMUM_BUFFER_S = 10;

/**
 * BOLA scorer with a two-gate trust state machine.
 *
 * - **Event gate** (`isSteady_`): true once a video segment has been
 *   appended since the last reset. Cleared on video buffer flush or
 *   media `seeking`.
 * - **Threshold gate**: front buffer in seconds must reach at least
 *   one segment duration before BOLA's math runs.
 *
 * When either gate is closed, `getRecommendedStream()` returns
 * `null` and the controller falls back to throughput.
 *
 * Lifetime is tied to media attachment: `AbrController` constructs
 * a `BolaScorer` on `MEDIA_ATTACHED` and calls `destroy()` on
 * `MEDIA_DETACHING`.
 */
export class BolaScorer {
  private player_: Player;
  private media_: HTMLMediaElement;
  private isSteady_ = false;

  constructor(player: Player, media: HTMLMediaElement) {
    this.player_ = player;
    this.media_ = media;
    this.player_.on(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.on(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.media_.addEventListener("seeking", this.onSeeking_);
  }

  /**
   * Returns the BOLA-recommended video stream, or `null` while
   * either gate is closed.
   */
  getRecommendedStream(): VideoStream | null {
    if (!this.isSteady_) {
      return null;
    }
    const streams = this.player_.getStreams(MediaType.VIDEO);
    const lowest = streams[0];
    const highest = streams[streams.length - 1];
    if (!lowest || !highest) {
      return null;
    }
    const config = this.player_.getConfig();
    const fbl = config.frontBufferLength;
    const frontBuffer = this.player_.getBufferFullness() * fbl;
    const maxSegDur = lowest.hierarchy.track.maxSegmentDuration;
    if (frontBuffer < maxSegDur) {
      return null;
    }

    const lnS1 = Math.log(lowest.bandwidth);
    const vM = Math.log(highest.bandwidth) - lnS1 + 1;
    const Qmax = Math.max(fbl, MINIMUM_BUFFER_S + 2 * streams.length);
    const gp = (vM - 1) / (Qmax / MINIMUM_BUFFER_S - 1);
    const V = MINIMUM_BUFFER_S / gp;

    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      if (!stream) {
        continue;
      }
      const vm = Math.log(stream.bandwidth) - lnS1 + 1;
      // Paper score is (V * (v_m + gp) - Q) / S_m with lowest v_m = 0.
      // Our vm is +1 shifted, so subtract 1 to recover the paper's v_m.
      const score = (V * (vm - 1 + gp) - frontBuffer) / stream.bandwidth;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    return streams[bestIndex] ?? null;
  }

  destroy(): void {
    this.player_.off(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.off(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.media_.removeEventListener("seeking", this.onSeeking_);
  }

  private onBufferAppended_ = (event: BufferAppendedEvent) => {
    if (event.type !== MediaType.VIDEO) {
      return;
    }
    this.isSteady_ = true;
  };

  private onBufferFlushed_ = (event: BufferFlushedEvent) => {
    if (event.type !== MediaType.VIDEO) {
      return;
    }
    this.isSteady_ = false;
  };

  private onSeeking_ = () => {
    this.isSteady_ = false;
  };
}
