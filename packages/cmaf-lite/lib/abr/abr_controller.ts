import type {
  BufferAppendedEvent,
  MediaAttachedEvent,
  NetworkResponseEvent,
} from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { getBufferedEnd } from "../utils/buffer_utils";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";
import { ThroughputEstimator } from "./throughput_estimator";

const log = Log.create("AbrController");

const MINIMUM_BUFFER_S = 10;

export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private media_: HTMLMediaElement | null = null;
  private isBufferSteady_ = false;
  private useBola_ = false;
  private lastSwitchAt_ = -Infinity;

  constructor(player: Player) {
    this.player_ = player;

    const { abr } = player.getConfig();
    this.throughput_ = new ThroughputEstimator(abr);

    this.timer_ = new Timer(() => this.evaluate_());

    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.on(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);

    this.timer_.tickEvery(1);
  }

  getThroughputEstimate(): number {
    const { abr } = this.player_.getConfig();
    return this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.off(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    if (this.media_) {
      this.media_.removeEventListener("seeking", this.onSeeking_);
      this.media_ = null;
    }
  }

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.media_.addEventListener("seeking", this.onSeeking_);
  };

  private onMediaDetaching_ = () => {
    if (this.media_) {
      this.media_.removeEventListener("seeking", this.onSeeking_);
      this.media_ = null;
    }
  };

  private onSeeking_ = () => {
    this.isBufferSteady_ = false;
    this.useBola_ = false;
  };

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type === NetworkRequestType.SEGMENT) {
      const { response } = event;
      this.throughput_.sample(
        response.durationSec,
        response.arrayBuffer.byteLength,
      );
    }
  };

  private onBufferAppended_ = (event: BufferAppendedEvent) => {
    if (event.type !== MediaType.VIDEO) {
      return;
    }
    const frontBuffer = this.getFrontBuffer_();
    const streams = this.player_.getStreams(MediaType.VIDEO);
    const lowest = streams[0];
    if (lowest && frontBuffer >= lowest.hierarchy.track.maxSegmentDuration) {
      this.isBufferSteady_ = true;
    }
    const fbl = this.player_.getConfig().frontBufferLength;
    if (frontBuffer >= (2 / 3) * fbl) {
      this.useBola_ = true;
    } else if (frontBuffer < (1 / 3) * fbl) {
      this.useBola_ = false;
    }
  };

  private getFrontBuffer_(): number {
    const media = this.media_;
    if (!media) {
      return 0;
    }
    const buffered = this.player_.getBuffered(MediaType.VIDEO);
    const { maxBufferHole } = this.player_.getConfig();
    const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
    if (end === null) {
      return 0;
    }
    return end - media.currentTime;
  }

  private evaluate_() {
    const streams = this.player_.getStreams(MediaType.VIDEO);
    if (streams.length === 0) {
      return;
    }
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
    const throughputPick = this.pickFromThroughput_(streams, activeStream);

    let pick: VideoStream | null = null;
    if (this.isBufferSteady_ && this.useBola_) {
      pick = this.pickFromBola_(streams);
      // BOLA-O anti-oscillation: when the buffer-derived pick wants to
      // upgrade above what throughput sustains, cap at the throughput-safe
      // pick (or stay at current if even that is a downgrade). Mirrors
      // dash.js BolaRule.js. Without this, a sustained low-bandwidth
      // regime keeps flipping between throughput's safe pick and BOLA's
      // full-buffer pick.
      if (
        pick &&
        activeStream &&
        throughputPick &&
        pick.bandwidth > activeStream.bandwidth &&
        pick.bandwidth > throughputPick.bandwidth
      ) {
        pick =
          throughputPick.bandwidth > activeStream.bandwidth
            ? throughputPick
            : activeStream;
      }
    }
    if (!pick) {
      pick = throughputPick;
    }
    if (!pick || pick === activeStream) {
      return;
    }

    const now = performance.now();
    const { switchInterval } = this.player_.getConfig().abr;
    if (now - this.lastSwitchAt_ < switchInterval * 1000) {
      return;
    }

    this.lastSwitchAt_ = now;
    log.info("Decision", pick);
    this.player_.emit(Events.ADAPTATION, { stream: pick });
  }

  private pickFromBola_(streams: VideoStream[]): VideoStream | null {
    const lowest = streams[0];
    const highest = streams[streams.length - 1];
    if (!lowest || !highest) {
      return null;
    }
    const frontBuffer = this.getFrontBuffer_();
    const fbl = this.player_.getConfig().frontBufferLength;

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

  private pickFromThroughput_(
    streams: VideoStream[],
    activeStream: VideoStream | null,
  ): VideoStream | null {
    const { abr } = this.player_.getConfig();
    const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

    let best: VideoStream | null = null;
    for (const stream of streams) {
      let scaled = bw;
      if (activeStream) {
        scaled *=
          stream.bandwidth > activeStream.bandwidth
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
