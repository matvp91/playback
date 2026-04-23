import type {
  BufferAppendedEvent,
  BufferAppendingEvent,
  BufferCodecsEvent,
  BufferFlushEvent,
  ManifestUpdatedEvent,
  MediaAttachingEvent,
} from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { InitSegment, Segment } from "../types/manifest";
import type { SourceBufferMediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as CodecUtils from "../utils/codec_utils";
import { Log } from "../utils/log";
import * as ManifestUtils from "../utils/manifest_utils";
import * as Mp4BoxParser from "../utils/mp4_box_parser";
import type { Operation } from "./operation_queue";
import { OperationKind, OperationQueue } from "./operation_queue";
import { SegmentTracker } from "./segment_tracker";

const log = Log.create("BufferController");

type InitSegmentInfo = {
  timescale: number;
};

export class BufferController {
  private sourceBuffers_ = new Map<SourceBufferMediaType, SourceBuffer>();
  private opQueue_: OperationQueue;
  private mediaSource_: MediaSource | null = null;
  private initSegmentInfo_ = new Map<InitSegment, InitSegmentInfo>();
  private segmentTracker_ = new SegmentTracker();
  private quotaEvictionPending_ = new Set<SourceBufferMediaType>();
  private duration_: number | null = null;
  private objectUrl_: string | null = null;

  constructor(private player_: Player) {
    this.player_.on(Events.MEDIA_ATTACHING, this.onMediaAttaching_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.on(Events.BUFFER_CODECS, this.onBufferCodecs_);
    this.player_.on(Events.BUFFER_APPENDING, this.onBufferAppending_);
    this.player_.on(Events.BUFFER_EOS, this.onBufferEos_);
    this.player_.on(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.on(Events.BUFFER_FLUSH, this.onBufferFlush_);
    this.opQueue_ = new OperationQueue({
      isUpdating: (type) => {
        const sb = this.sourceBuffers_.get(type);
        asserts.assertExists(sb, `No SourceBuffer for ${type}`);
        return sb.updating;
      },
    });
  }

  destroy() {
    this.player_.off(Events.MEDIA_ATTACHING, this.onMediaAttaching_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.off(Events.BUFFER_CODECS, this.onBufferCodecs_);
    this.player_.off(Events.BUFFER_APPENDING, this.onBufferAppending_);
    this.player_.off(Events.BUFFER_EOS, this.onBufferEos_);
    this.player_.off(Events.BUFFER_APPENDED, this.onBufferAppended_);
    this.player_.off(Events.BUFFER_FLUSH, this.onBufferFlush_);
    this.opQueue_.destroy();
    this.segmentTracker_.destroy();
    this.quotaEvictionPending_.clear();
    this.sourceBuffers_.clear();
    if (this.objectUrl_) {
      URL.revokeObjectURL(this.objectUrl_);
      this.objectUrl_ = null;
    }
    this.mediaSource_ = null;
    this.duration_ = null;
  }

  getBuffered(type: SourceBufferMediaType): TimeRanges | null {
    const sb = this.sourceBuffers_.get(type);
    return sb?.buffered ?? null;
  }

  private onBufferFlush_ = (event: BufferFlushEvent) => {
    const { type } = event;
    this.quotaEvictionPending_.delete(type);
    this.opQueue_.enqueue(type, this.getFlushOperation_(type, 0, Infinity));
  };

  private onManifestUpdated_ = (event: ManifestUpdatedEvent) => {
    this.duration_ = event.manifest.isLive ? 2 ** 32 : event.manifest.duration;
    this.updateDuration_();
  };

  private onMediaAttaching_ = (event: MediaAttachingEvent) => {
    this.mediaSource_ = new MediaSource();
    this.mediaSource_.addEventListener("sourceopen", this.onMediaSourceOpen_);
    this.objectUrl_ = URL.createObjectURL(this.mediaSource_);
    event.media.src = this.objectUrl_;
  };

  private onMediaSourceOpen_ = () => {
    const media = this.player_.getMedia();
    asserts.assertExists(media, "No media element");
    asserts.assertExists(this.mediaSource_, "No MediaSource");

    this.mediaSource_.removeEventListener(
      "sourceopen",
      this.onMediaSourceOpen_,
    );

    this.player_.emit(Events.MEDIA_ATTACHED, {
      media,
      mediaSource: this.mediaSource_,
    });
    this.updateDuration_();
  };

  private onMediaDetaching_ = () => {
    if (this.objectUrl_) {
      URL.revokeObjectURL(this.objectUrl_);
      this.objectUrl_ = null;
    }
  };

  private onBufferCodecs_ = (event: BufferCodecsEvent) => {
    if (!this.mediaSource_) {
      return;
    }

    const { type, codec } = event;
    const sb = this.sourceBuffers_.get(type);
    const mimeType = CodecUtils.getContentType(type, codec);

    if (sb) {
      this.opQueue_.enqueue(type, {
        kind: `${OperationKind.ChangeType}_${mimeType}`,
        execute: () => {
          sb.changeType(mimeType);
          log.info("changeType", mimeType);
        },
      });
      return;
    }

    const newSb = this.mediaSource_.addSourceBuffer(mimeType);
    log.info("Initial type", mimeType);
    this.sourceBuffers_.set(type, newSb);

    newSb.addEventListener("updateend", () => {
      this.opQueue_.shiftAndExecuteNext(type);
    });
  };

  private onBufferAppending_ = (event: BufferAppendingEvent) => {
    const { type, data, segment } = event;

    if (ManifestUtils.isInitSegment(segment)) {
      // Handle init segment.
      this.initSegmentInfo_.set(segment, {
        timescale: Mp4BoxParser.parseTimescale(data),
      });
    }

    let timestampOffset: number | undefined;
    if (ManifestUtils.isMediaSegment(segment)) {
      // Handle media segment.
      timestampOffset = this.computeTimestampOffset_(segment, data);
    }

    const operation: Operation = {
      kind: OperationKind.Append,
      execute: () => {
        const sb = this.sourceBuffers_.get(type);
        if (!sb) {
          return;
        }
        if (
          timestampOffset !== undefined &&
          sb.timestampOffset !== timestampOffset
        ) {
          sb.timestampOffset = timestampOffset;
        }
        sb.appendBuffer(data);
      },
      onComplete: () => {
        this.player_.emit(Events.BUFFER_APPENDED, event);
      },
      onError: (error: unknown) => {
        if (isQuotaExceededError(error)) {
          this.evictAndRetryAppend_(type, operation, data.byteLength, error);
        }
      },
    };

    this.opQueue_.enqueue(type, operation);
  };

  /**
   * Derive timestampOffset from init segment timescale
   * and media segment baseMediaDecodeTime.
   */
  private computeTimestampOffset_(segment: Segment, data: ArrayBuffer): number {
    const info = this.initSegmentInfo_.get(segment.initSegment);
    asserts.assertExists(info, "Init segment not parsed");
    const mediaTime =
      Mp4BoxParser.parseBaseMediaDecodeTime(data) / info.timescale;
    return segment.start - mediaTime;
  }

  private onBufferAppended_ = (event: BufferAppendedEvent) => {
    const { type, segment, data } = event;

    // Record byte size for quota-aware eviction decisions.
    if (ManifestUtils.isMediaSegment(segment)) {
      this.segmentTracker_.trackAppend(type, segment, data);
    }

    const sb = this.sourceBuffers_.get(type);
    asserts.assertExists(sb, `No SourceBuffer for ${type}`);
    this.segmentTracker_.reconcile(type, sb.buffered);

    const { backBufferLength } = this.player_.getConfig();
    if (Number.isFinite(backBufferLength)) {
      this.evictBackBuffer_(type, backBufferLength);
    }
  };

  /**
   * Evict back buffer that exceeds the configured
   * backBufferLength behind the playhead.
   */
  private evictBackBuffer_(
    type: SourceBufferMediaType,
    backBufferLength: number,
  ) {
    const media = this.player_.getMedia();
    if (!media) {
      return;
    }
    const sb = this.sourceBuffers_.get(type);
    asserts.assertExists(sb, `No SourceBuffer for ${type}`);
    const bufferedStart = sb.buffered.length > 0 ? sb.buffered.start(0) : null;
    if (bufferedStart === null) {
      return;
    }
    const evictEnd = media.currentTime - backBufferLength;
    if (bufferedStart >= evictEnd) {
      return;
    }
    this.opQueue_.enqueue(
      type,
      this.getFlushOperation_(type, bufferedStart, evictEnd),
    );
  }

  /**
   * Block all source buffer operation queues, then run
   * callback once they drain. If no source buffers exist,
   * the callback runs immediately.
   */
  private blockUntil(callback: () => void) {
    const types = [...this.sourceBuffers_.keys()];
    const blockers = types.map((type) => this.opQueue_.block(type));
    Promise.all(blockers).then(() => {
      callback();
      for (const type of types) {
        this.opQueue_.shiftAndExecuteNext(type);
      }
    });
  }

  /**
   * Apply the cached duration to mediaSource.duration. Uses
   * blockUntil to avoid InvalidStateError when a SourceBuffer
   * is updating.
   */
  private updateDuration_() {
    if (this.duration_ === null || this.mediaSource_?.readyState !== "open") {
      return;
    }
    const duration = this.duration_;
    if (this.mediaSource_.duration === duration) {
      return;
    }
    this.blockUntil(() => {
      if (this.mediaSource_?.readyState === "open") {
        this.mediaSource_.duration = duration;
        log.info("Duration updated", duration);
      }
    });
  }

  private onBufferEos_ = () => {
    this.blockUntil(() => {
      if (this.mediaSource_?.readyState === "open") {
        this.mediaSource_.endOfStream();
        log.info("End of stream");
      }
    });
  };

  private evictAndRetryAppend_(
    type: SourceBufferMediaType,
    operation: Operation,
    byteLength: number,
    error: DOMException,
  ) {
    const media = this.player_.getMedia();
    asserts.assertExists(media, "No media element");
    const sb = this.sourceBuffers_.get(type);
    asserts.assertExists(sb, `No SourceBuffer for ${type}`);

    // Nothing buffered, nothing to evict.
    if (sb.buffered.length === 0) {
      return;
    }

    const bufferedStart = sb.buffered.start(0);
    const currentTime = media.currentTime;

    // Tier 1: evict minimum back buffer to fit the failed
    // segment, plus padding for headroom.
    if (!this.quotaEvictionPending_.has(type)) {
      const { backBufferQuotaPadding } = this.player_.getConfig();
      const evictionEnd = this.segmentTracker_.getEvictionEnd(
        type,
        currentTime,
        byteLength,
      );
      const minEvictionEnd = Math.min(
        evictionEnd + backBufferQuotaPadding,
        currentTime,
      );

      // Targeted eviction is possible when there is enough
      // back buffer to free the required bytes.
      if (minEvictionEnd > bufferedStart) {
        this.quotaEvictionPending_.add(type);
        this.opQueue_.insertNext(type, [
          this.getFlushOperation_(type, bufferedStart, minEvictionEnd),
          operation,
          this.getQuotaEvictedOperation_(type),
        ]);
        return;
      }
    }

    // Tier 2: aggressively trim back buffer to ~1 segment
    // behind playhead.
    this.player_.emit(Events.BUFFER_APPEND_ERROR, {
      type,
      error,
    });

    const minBackBuffer = Math.max(
      this.segmentTracker_.getLastSegmentDuration(type),
      2,
    );
    const evictionEnd = currentTime - minBackBuffer;

    // Back buffer is already smaller than the minimum
    // we want to keep. Nothing left to evict.
    if (evictionEnd <= bufferedStart) {
      this.quotaEvictionPending_.delete(type);
      return;
    }

    this.quotaEvictionPending_.delete(type);
    this.opQueue_.insertNext(type, [
      this.getFlushOperation_(type, bufferedStart, evictionEnd),
      operation,
    ]);
  }

  /**
   * Create a remove operation for a SourceBuffer range.
   */
  private getFlushOperation_(
    type: SourceBufferMediaType,
    start: number,
    end: number,
  ): Operation {
    const sb = this.sourceBuffers_.get(type);
    asserts.assertExists(sb, `No SourceBuffer for ${type}`);
    return {
      kind: OperationKind.Flush,
      execute: () => {
        sb.remove(start, end);
      },
      onComplete: () => {
        this.player_.emit(Events.BUFFER_FLUSHED, { type });
      },
    };
  }

  /**
   * Create an operation that clears the quota eviction
   * pending flag for a given type.
   */
  private getQuotaEvictedOperation_(type: SourceBufferMediaType): Operation {
    return {
      kind: OperationKind.QuotaCleanup,
      execute: () => {
        this.quotaEvictionPending_.delete(type);
      },
    };
  }
}

function isQuotaExceededError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}
