import type {
  AdaptationEvent,
  BufferFlushedEvent,
  ManifestUpdatedEvent,
  MediaAttachedEvent,
} from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import type { InitSegment, Segment } from "../types/manifest";
import type { Stream } from "../types/media";
import { MediaType } from "../types/media";
import { ABORTED, NetworkRequestType } from "../types/net";
import * as ArrayUtils from "../utils/array_utils";
import * as asserts from "../utils/asserts";
import * as BufferUtils from "../utils/buffer_utils";
import { Log } from "../utils/log";
import * as ManifestUtils from "../utils/manifest_utils";
import * as StreamUtils from "../utils/stream_utils";
import { Timer } from "../utils/timer";

const log = Log.create("StreamController");

const TICK_INTERVAL = 0.1;

type MediaState = {
  type: MediaType;
  lastSegment: Segment | null;
  lastInitSegment: InitSegment | null;
  request: NetworkRequest | null;
  ended: boolean;
  timer: Timer;
};

export class StreamController {
  private isLive_ = false;
  private rangeStart_ = 0;
  private rangeEnd_ = 0;
  private streamsMap_ = new Map<MediaType, Stream[]>();
  private streams_ = new Map<MediaType, Stream>();
  private media_: HTMLMediaElement | null = null;
  private mediaStates_ = new Map<MediaType, MediaState>();

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHED, this.onMediaDetached_);
    this.player_.on(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.player_.on(Events.ADAPTATION, this.onAdaptation_);
  }

  getStreams<T extends MediaType>(type: T) {
    const list = this.streamsMap_.get(type);
    return list as Stream<T>[] | null;
  }

  getStream<T extends MediaType>(type: T) {
    const stream = this.streams_.get(type);
    return stream as Stream<T> | null;
  }

  setStream(stream: Stream) {
    this.switchStream_(stream);
  }

  destroy() {
    const networkService = this.player_.getNetworkService();
    for (const mediaState of this.mediaStates_.values()) {
      if (mediaState.request) {
        networkService.cancel(mediaState.request);
      }
      mediaState.timer.stop();
    }
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHED, this.onMediaDetached_);
    this.player_.off(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.player_.off(Events.ADAPTATION, this.onAdaptation_);
    this.mediaStates_.clear();
  }

  private onManifestUpdated_ = (event: ManifestUpdatedEvent) => {
    // Update manifest info.
    this.isLive_ = event.manifest.isLive;
    this.rangeStart_ = event.manifest.start;
    this.rangeEnd_ = event.manifest.end;

    if (!event.isUpdate) {
      // The initial manifest can be processed.
      this.streamsMap_ = StreamUtils.buildStreams(event.manifest);
      log.info("Streams", this.streamsMap_);
      this.player_.emit(Events.STREAMS_CREATED);
      this.tryStart_();
    }
  };

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.media_.addEventListener("seeking", this.onSeeking_);
    this.tryStart_();
  };

  private onBufferFlushed_ = (event: BufferFlushedEvent) => {
    const mediaState = this.mediaStates_.get(event.type);
    if (mediaState) {
      mediaState.lastSegment = null;
      mediaState.lastInitSegment = null;
    }
  };

  private onAdaptation_ = (event: AdaptationEvent) => {
    this.switchStream_(event.stream);
  };

  private switchStream_(stream: Stream) {
    const { type } = stream;
    const oldStream = this.streams_.get(type) ?? null;
    if (oldStream === stream) {
      return;
    }
    this.streams_.set(type, stream);

    const mediaState = this.mediaStates_.get(type);
    if (!mediaState) {
      return;
    }

    const networkService = this.player_.getNetworkService();
    if (mediaState.request) {
      networkService.cancel(mediaState.request);
    }

    if (
      !oldStream ||
      oldStream.hierarchy.switchingSet !== stream.hierarchy.switchingSet
    ) {
      if (isAV(type)) {
        this.player_.emit(Events.BUFFER_CODECS, {
          type,
          codec: stream.hierarchy.switchingSet.codec,
        });
      }
      // Non-AV types (e.g. text) do not use MSE SourceBuffers,
      // so no codec signalling is needed.
    }

    mediaState.lastSegment = null;
    mediaState.lastInitSegment = null;

    log.info("Switched stream", stream);

    this.player_.emit(Events.STREAM_CHANGED, {
      type,
      oldStream,
      stream,
    });
  }

  private onMediaDetached_ = () => {
    const networkService = this.player_.getNetworkService();
    for (const mediaState of this.mediaStates_.values()) {
      if (mediaState.request) {
        networkService.cancel(mediaState.request);
      }
      mediaState.timer.stop();
    }
    this.media_?.removeEventListener("seeking", this.onSeeking_);
    this.media_ = null;
  };

  private getInitialTime_(): number {
    if (!this.isLive_) {
      return this.rangeStart_;
    }
    const { liveDelay } = this.player_.getConfig();
    return Math.max(this.rangeEnd_ - liveDelay, this.rangeStart_);
  }

  private resolveStream_(type: MediaType, streams: Stream[]): Stream {
    asserts.assertExists(streams[0], "No Streams");
    const { preferences } = this.player_.getConfig();
    const matches = StreamUtils.findStreamsMatchingPreferences(
      type,
      streams,
      preferences,
    );
    const activeStream = this.streams_.get(type);
    if (matches[0]) {
      if (activeStream) {
        // If we have an active stream already (ABR might have set one), we can
        // find the closest stream of our matches to respect bandwidth estimation.
        const closestStream = StreamUtils.pickClosestByBandwidth(
          matches,
          activeStream,
        );
        if (closestStream) {
          return closestStream;
        }
      }
      // The first match has the highest priority.
      return matches[0];
    }
    if (activeStream) {
      return activeStream;
    }
    return streams[0];
  }

  private tryStart_() {
    if (!this.media_) {
      return;
    }

    for (const [type, streams] of this.streamsMap_) {
      const stream = this.resolveStream_(type, streams);
      this.streams_.set(type, stream);
      log.info("Initial", type, stream);

      const mediaState: MediaState = {
        type,
        ended: false,
        lastSegment: null,
        lastInitSegment: null,
        request: null,
        timer: new Timer(() => this.update_(mediaState)),
      };
      this.mediaStates_.set(type, mediaState);

      if (isAV(type)) {
        this.player_.emit(Events.BUFFER_CODECS, {
          type,
          codec: stream.hierarchy.switchingSet.codec,
        });
      }

      this.player_.emit(Events.STREAM_CHANGED, {
        type,
        oldStream: null,
        stream,
      });
    }

    if (this.media_) {
      this.media_.currentTime = this.getInitialTime_();
    }

    for (const mediaState of this.mediaStates_.values()) {
      mediaState.timer.tickEvery(TICK_INTERVAL);
    }
  }

  /**
   * Core streaming tick. Finds the next segment to fetch
   * via sequential index or time-based lookup.
   */
  private update_(mediaState: MediaState) {
    const stream = this.streams_.get(mediaState.type);
    asserts.assertExists(stream, `No stream for ${mediaState.type}`);

    if (mediaState.ended || mediaState.request?.inFlight) {
      return;
    }
    if (!this.media_) {
      return;
    }

    const currentTime = this.media_.currentTime;
    const frontBufferLength = this.player_.getConfig().frontBufferLength;
    const bufferEnd = this.getBufferEnd_(mediaState.type, currentTime);

    if (bufferEnd !== null && bufferEnd - currentTime >= frontBufferLength) {
      return;
    }

    let segment = this.getNextSegment_(mediaState, stream);
    if (!segment) {
      if (this.isEnded_(mediaState, stream)) {
        mediaState.ended = true;
        this.checkEndOfStream_();
        return;
      }

      const lookupTime =
        bufferEnd ?? Math.max(0, currentTime - /* maybeSegmentSize= */ 4);
      segment = this.getSegmentForTime_(stream, lookupTime);
      log.debug(`Segment by time at ${lookupTime}`, segment);
    } else {
      log.debug(`Segment by index`, segment);
    }

    if (!segment) {
      if (!this.isLive_) {
        mediaState.ended = true;
        this.checkEndOfStream_();
      }
      return;
    }

    if (segment.initSegment !== mediaState.lastInitSegment) {
      this.loadSegment_(mediaState, segment.initSegment);
    } else if (segment !== mediaState.lastSegment) {
      this.loadSegment_(mediaState, segment);
    }
  }

  private async loadSegment_(
    mediaState: MediaState,
    segment: Segment | InitSegment,
  ) {
    const networkService = this.player_.getNetworkService();
    const config = this.player_.getConfig();

    mediaState.request = networkService.request(
      NetworkRequestType.SEGMENT,
      segment.url,
      config.segmentRequestOptions,
    );

    const response = await mediaState.request.promise;
    if (response === ABORTED) {
      return;
    }

    // Update mediaState AFTER we fetched, it means that we
    // sent this segment to the buffer controller.
    if (ManifestUtils.isInitSegment(segment)) {
      mediaState.lastInitSegment = segment;
    }
    if (ManifestUtils.isMediaSegment(segment)) {
      mediaState.lastSegment = segment;
    }

    if (isAV(mediaState.type)) {
      // If audio or video, we can send it to the buffer controller.
      this.player_.emit(Events.BUFFER_APPENDING, {
        type: mediaState.type,
        segment,
        data: response.arrayBuffer,
      });
    }
  }

  private getBufferEnd_(type: MediaType, time: number): number | null {
    const { maxBufferHole } = this.player_.getConfig();
    const buffered = this.player_.getBuffered(type);
    return BufferUtils.getBufferedEnd(buffered, time, maxBufferHole);
  }

  private getNextSegment_(
    mediaState: MediaState,
    stream: Stream,
  ): Segment | null {
    if (!mediaState.lastSegment) {
      return null;
    }
    const { segments } = stream.hierarchy.track;
    const lastIndex = segments.indexOf(mediaState.lastSegment);
    return segments[lastIndex + 1] ?? null;
  }

  private getSegmentForTime_(stream: Stream, time: number): Segment | null {
    const { maxSegmentLookupTolerance } = this.player_.getConfig();
    return ArrayUtils.binarySearch(stream.hierarchy.track.segments, (seg) => {
      if (time >= seg.start && time < seg.end) {
        return 0;
      }
      if (time < seg.start) {
        const tolerance = Math.min(
          maxSegmentLookupTolerance,
          seg.end - seg.start,
        );
        if (seg.start - tolerance > time && seg.start > 0) {
          return -1;
        }
        return 0;
      }
      return 1;
    });
  }

  private isEnded_(mediaState: MediaState, stream: Stream): boolean {
    if (this.isLive_) {
      return false;
    }
    if (!mediaState.lastSegment) {
      return false;
    }
    const { segments } = stream.hierarchy.track;
    return segments.indexOf(mediaState.lastSegment) === segments.length - 1;
  }

  private checkEndOfStream_() {
    const allDone = [...this.mediaStates_.values()].every((ms) => ms.ended);
    if (allDone) {
      this.player_.emit(Events.BUFFER_EOS);
    }
  }

  private onSeeking_ = () => {
    for (const mediaState of this.mediaStates_.values()) {
      mediaState.ended = false;
      if (mediaState.request) {
        const networkService = this.player_.getNetworkService();
        networkService.cancel(mediaState.request);
      }
      mediaState.lastSegment = null;
      this.update_(mediaState);
    }
  };
}

function isAV(type: MediaType) {
  return type === MediaType.AUDIO || type === MediaType.VIDEO;
}
