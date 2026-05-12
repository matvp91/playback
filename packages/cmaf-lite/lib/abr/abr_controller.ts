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

export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private media_: HTMLMediaElement | null = null;
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
    this.player_.on(Events.STREAMS_CREATED, this.onStreamsCreated_);
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.off(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.player_.off(Events.STREAMS_CREATED, this.onStreamsCreated_);
    if (this.media_) {
      this.media_.removeEventListener("seeking", this.onSeeking_);
      this.media_ = null;
    }
  }

  private onStreamsCreated_ = () => {
    this.timer_.tickNow().tickEvery(1);
  };

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
    const { abr } = this.player_.getConfig();
    const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

    // Throughput-driven pick — the floor. Asymmetric upgrade/downgrade
    // thresholds give a single-signal decision the stability it needs.
    let pick: VideoStream | null = null;
    for (const stream of streams) {
      let scaled = bw;
      if (activeStream) {
        scaled *=
          stream.bandwidth > activeStream.bandwidth
            ? abr.bandwidthUpgradeTarget
            : abr.bandwidthDowngradeTarget;
      }
      if (stream.bandwidth <= scaled) {
        pick = stream;
      }
    }
    pick = pick ?? streams[0] ?? null;
    if (!pick) {
      return;
    }

    // Buffer-aware uplift — when the buffer is comfortable, the buffer
    // itself corroborates the EWMA, so drop the upgrade margin and
    // allow the highest stream the estimate sustains.
    if (this.useBola_) {
      const ceiling = bw * abr.bandwidthDowngradeTarget;
      let raised: VideoStream | null = null;
      for (const stream of streams) {
        if (stream.bandwidth <= ceiling) {
          raised = stream;
        }
      }
      if (raised && raised.bandwidth > pick.bandwidth) {
        pick = raised;
      }
    }

    if (pick === activeStream) {
      return;
    }

    const now = performance.now();
    if (now - this.lastSwitchAt_ < abr.switchInterval * 1000) {
      return;
    }

    this.lastSwitchAt_ = now;
    log.info("Decision", pick);
    this.player_.emit(Events.ABR_ADAPT, { stream: pick });
  }
}
