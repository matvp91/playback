import type {
  MediaAttachedEvent,
  MediaDetachingEvent,
  NetworkResponseEvent,
} from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";
import { BolaScorer } from "./bola_scorer";
import { ThroughputEstimator } from "./throughput_estimator";

const log = Log.create("AbrController");

/**
 * The buffer threshold (in seconds) at which BOLA's math becomes
 * meaningful. From the BOLA paper. Used by the controller's
 * hysteresis to choose between Throughput and BOLA.
 */
const MINIMUM_BUFFER_S = 10;

type ActiveDriver = "throughput" | "bola";

/**
 * Adaptive bitrate controller. Picks one of two drivers per
 * evaluation tick:
 *
 * - **Throughput**: highest stream fitting the current EWMA estimate
 *   (with upgrade/downgrade asymmetry). Active when buffer is low.
 * - **BOLA**: buffer-level utility scoring (BOLA-O). Active when
 *   buffer is comfortable. Falls back to throughput if its
 *   trust gate is closed.
 *
 * Selection between drivers is a buffer-fullness hysteresis anchored
 * to absolute seconds (`MINIMUM_BUFFER_S`).
 */
export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private bola_: BolaScorer | null = null;
  private activeDriver_: ActiveDriver = "throughput";

  constructor(player: Player) {
    this.player_ = player;
    const abr = player.getConfig().abr;
    this.throughput_ = new ThroughputEstimator(abr);
    this.timer_ = new Timer(() => this.evaluate_());

    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);

    const media = player.getMedia();
    if (media) {
      this.bola_ = new BolaScorer(player, media);
    }

    this.timer_.tickEvery(abr.evaluationInterval);
  }

  /**
   * Returns the current throughput estimate in bits/second. Falls
   * back to `config.abr.defaultBandwidthEstimate` while the EWMA is
   * undersampled — consumers always get a number.
   */
  getThroughputEstimate(): number {
    const abr = this.player_.getConfig().abr;
    return this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.bola_?.destroy();
    this.bola_ = null;
  }

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type !== NetworkRequestType.SEGMENT) {
      return;
    }
    const { durationSec, arrayBuffer } = event.response;
    this.throughput_.sample(durationSec, arrayBuffer.byteLength);
  };

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.bola_?.destroy();
    this.bola_ = new BolaScorer(this.player_, event.media);
  };

  private onMediaDetaching_ = (_event: MediaDetachingEvent) => {
    this.bola_?.destroy();
    this.bola_ = null;
  };

  private evaluate_() {
    const streams = this.player_.getStreams(MediaType.VIDEO);
    if (streams.length === 0) {
      return;
    }
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
    this.updateActiveDriver_();

    let pick: VideoStream | null = null;
    if (this.activeDriver_ === "bola" && this.bola_) {
      pick = this.bola_.getRecommendedStream();
    }
    if (!pick) {
      pick = this.pickFromThroughput_(streams, activeStream);
    }

    if (pick && pick !== activeStream) {
      log.info("Decision", pick);
      this.player_.emit(Events.ADAPTATION, { stream: pick });
    }
  }

  private updateActiveDriver_() {
    const fullness = this.player_.getBufferFullness();
    const fbl = this.player_.getConfig().frontBufferLength;
    const lowMark = MINIMUM_BUFFER_S / fbl;
    const highMark = (MINIMUM_BUFFER_S * 2) / fbl;
    if (fullness < lowMark) {
      this.activeDriver_ = "throughput";
    } else if (fullness > highMark) {
      this.activeDriver_ = "bola";
    }
    // Otherwise: stay in current state (hysteresis dead zone).
  }

  private pickFromThroughput_(
    streams: VideoStream[],
    active: VideoStream | null,
  ): VideoStream | null {
    const abr = this.player_.getConfig().abr;
    const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

    let best: VideoStream | null = null;
    for (const stream of streams) {
      let scaled = bw;
      if (active) {
        scaled *=
          stream.bandwidth > active.bandwidth
            ? abr.bandwidthUpgradeTarget
            : abr.bandwidthDowngradeTarget;
      }
      if (stream.bandwidth <= scaled) {
        best = stream;
      }
    }
    return best ?? streams[0] ?? null;
  }
}
