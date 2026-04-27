import type { NetworkResponseEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";
import { BolaScorer, MINIMUM_BUFFER_S } from "./bola_scorer";
import { ThroughputEstimator } from "./throughput_estimator";

const log = Log.create("AbrController");

export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private bola_: BolaScorer;
  private bolaActive_ = false;

  constructor(player: Player) {
    this.player_ = player;

    const { abr } = player.getConfig();
    this.throughput_ = new ThroughputEstimator(abr);
    this.bola_ = new BolaScorer(player);

    this.timer_ = new Timer(() => this.evaluate_());

    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);

    this.timer_.tickEvery(abr.evaluationInterval);
  }

  getThroughputEstimate(): number {
    const { abr } = this.player_.getConfig();
    return this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  }

  destroy() {
    this.timer_.stop();
    this.bola_.destroy();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
  }

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type === NetworkRequestType.SEGMENT) {
      const { response } = event;
      this.throughput_.sample(
        response.durationSec,
        response.arrayBuffer.byteLength,
      );
    }
  };

  private evaluate_() {
    const streams = this.player_.getStreams(MediaType.VIDEO);
    if (streams.length === 0) {
      return;
    }
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
    this.updateActiveDriver_();

    let pick: VideoStream | null = null;
    if (this.bolaActive_ && this.bola_) {
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
    const fbl = this.player_.getConfig().frontBufferLength;
    const frontBufferSec = this.player_.getBufferFullness() * fbl;
    if (frontBufferSec < MINIMUM_BUFFER_S) {
      this.bolaActive_ = false;
    } else if (frontBufferSec > MINIMUM_BUFFER_S * 2) {
      this.bolaActive_ = true;
    }
  }

  private pickFromThroughput_(
    streams: VideoStream[],
    active: VideoStream | null,
  ): VideoStream | null {
    const { abr } = this.player_.getConfig();
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
