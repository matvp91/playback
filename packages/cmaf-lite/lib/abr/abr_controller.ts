import type { NetworkResponseEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { Stream, VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { getBufferedEnd } from "../utils/buffer_utils";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";
import { EwmaBandwidthEstimator } from "./ewma_bandwidth_estimator";

const log = Log.create("AbrController");

export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private bandwidthEstimator_: EwmaBandwidthEstimator;
  private streams_: VideoStream[] = [];

  constructor(player: Player) {
    this.player_ = player;
    this.timer_ = new Timer(() => this.evaluate_());

    const abrConfig = player.getConfig().abr;
    this.bandwidthEstimator_ = new EwmaBandwidthEstimator(abrConfig);

    this.player_.on(Events.STREAMS_CREATED, this.onStreamsCreated_);
    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
  }

  getThroughputEstimate(): number {
    const { defaultBandwidthEstimate } = this.player_.getConfig().abr;
    return this.bandwidthEstimator_.getEstimate(defaultBandwidthEstimate);
  }

  getBufferLevel(): number {
    const media = this.player_.getMedia();
    if (!media) {
      return 0;
    }
    const buffered = this.player_.getBuffered(MediaType.VIDEO);
    const { maxBufferHole } = this.player_.getConfig();
    const end = getBufferedEnd(buffered, media.currentTime, maxBufferHole);
    return end ? end - media.currentTime : 0;
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.STREAMS_CREATED, this.onStreamsCreated_);
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
  }

  private onStreamsCreated_ = () => {
    // TODO(matvp): Pass streamsMap as event & introduce StreamsCreatedEvent.
    this.streams_ = this.player_.getStreams(MediaType.VIDEO);

    // Run a first evalulation to contribute to the initial stream selection.
    this.evaluate_();

    const { evaluationInterval } = this.player_.getConfig().abr;
    this.timer_.tickEvery(evaluationInterval);
  };

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type !== NetworkRequestType.SEGMENT) {
      return;
    }
    const { durationSec, arrayBuffer } = event.response;
    this.bandwidthEstimator_.sample(durationSec, arrayBuffer.byteLength);
  };

  private evaluate_() {
    const streams = this.streams_;
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);

    const candidates = [
      this.evaluateThroughput_(streams, activeStream),
      this.evaluateBola_(streams, activeStream),
      this.evaluateInsufficientBuffer_(streams, activeStream),
      this.evaluateDroppedFrames_(streams, activeStream),
    ];

    let best: VideoStream | null = null;
    for (const candidate of candidates) {
      if (candidate && (!best || candidate.bandwidth < best.bandwidth)) {
        best = candidate;
      }
    }

    if (best && best !== activeStream) {
      log.info("Decision", best);
      this.player_.emit(Events.ADAPTATION, {
        stream: best,
      });
    }
  }

  /**
   * Highest video stream fitting measured throughput, minus audio.
   */
  private evaluateThroughput_(
    streams: VideoStream[],
    activeStream: VideoStream | null,
  ): VideoStream | null {
    const { bandwidthUpgradeTarget, bandwidthDowngradeTarget } =
      this.player_.getConfig().abr;

    let bandwidth = this.getThroughputEstimate();
    const audioStream = this.player_.getActiveStream(MediaType.AUDIO);
    if (audioStream) {
      bandwidth -= audioStream.bandwidth;
    }

    let best: Stream | null = null;
    for (const stream of streams) {
      let scaledBandwidth = bandwidth;
      if (activeStream) {
        // If we have a current stream active, figure out if we're up or down
        // scaling and apply the scaling factor.
        const isUpgrade = stream.bandwidth > activeStream.bandwidth;
        const factor = isUpgrade
          ? bandwidthUpgradeTarget
          : bandwidthDowngradeTarget;
        scaledBandwidth *= factor;
      }
      if (stream.bandwidth <= scaledBandwidth) {
        best = stream;
      }
    }

    return best ?? streams[0] ?? null;
  }

  /**
   * BOLA — buffer-level utility scoring. Abstains during startup.
   * See BOLA paper (arxiv 1601.06748). Utility v_m = ln(S_m / S_1)
   * shifted by +1 so lowest stream has utility 1.
   */
  private evaluateBola_(
    streams: VideoStream[],
    activeStream: VideoStream | null,
  ): VideoStream | null {
    if (!activeStream) {
      return null;
    }

    const MINIMUM_BUFFER_S = 10;

    const lowestStream = streams[0];
    const highestStream = streams[streams.length - 1];
    if (!lowestStream || !highestStream) {
      return null;
    }

    const activeTrack = activeStream.hierarchy.track;
    const { frontBufferLength } = this.player_.getConfig();
    const bufferLevel = this.getBufferLevel();

    if (bufferLevel < activeTrack.maxSegmentDuration) {
      return null;
    }

    const lnS1 = Math.log(lowestStream.bandwidth);
    const vM = Math.log(highestStream.bandwidth) - lnS1 + 1;

    // Q_max: at least front buffer, scaled up by stream count.
    const Qmax = Math.max(
      frontBufferLength,
      MINIMUM_BUFFER_S + 2 * streams.length,
    );

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
      // Paper: (V * (v_m + gp) - Q) / S_m with lowest v_m = 0.
      // Our vm is +1 shifted, so subtract 1 to recover paper's v_m.
      const score = (V * (vm - 1 + gp) - bufferLevel) / stream.bandwidth;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    return streams[bestIndex] ?? null;
  }

  /**
   * Proportional downshift based on buffer thinness. Formula:
   * `throughput * safety * (bufferLevel / maxSegmentDuration)`.
   * Abstains during startup.
   */
  private evaluateInsufficientBuffer_(
    streams: VideoStream[],
    activeStream: VideoStream | null,
  ): VideoStream | null {
    if (!activeStream) {
      return null;
    }

    const THROUGHPUT_SAFETY_FACTOR = 0.7;

    const activeTrack = activeStream.hierarchy.track;
    const bufferLevel = this.getBufferLevel();

    if (bufferLevel < activeTrack.maxSegmentDuration) {
      return null;
    }

    const targetBitrate =
      this.getThroughputEstimate() *
      THROUGHPUT_SAFETY_FACTOR *
      (bufferLevel / activeTrack.maxSegmentDuration);

    let best: Stream | null = null;
    for (const stream of streams) {
      if (stream.bandwidth <= targetBitrate) {
        best = stream;
      }
    }

    return best ?? streams[0] ?? null;
  }

  /**
   * Step one quality level down when dropped frame ratio is high.
   */
  private evaluateDroppedFrames_(
    streams: VideoStream[],
    currentStream: VideoStream | null,
  ): VideoStream | null {
    if (!currentStream) {
      return null;
    }

    const media = this.player_.getMedia() as HTMLVideoElement | null;
    if (!media?.getVideoPlaybackQuality) {
      return null;
    }

    const quality = media.getVideoPlaybackQuality();
    const ratio = quality.totalVideoFrames
      ? quality.droppedVideoFrames / quality.totalVideoFrames
      : 0;
    const { droppedFramesThreshold } = this.player_.getConfig().abr;
    if (ratio <= droppedFramesThreshold) {
      return null;
    }

    const currentIndex = streams.indexOf(currentStream);
    const newIndex = Math.max(0, currentIndex - 1);
    return streams[newIndex] ?? null;
  }
}
