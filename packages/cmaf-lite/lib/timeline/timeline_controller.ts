import type { ManifestUpdatedEvent, MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { Manifest } from "../types/manifest";
import type { Timeline } from "../types/media";
import * as MathUtils from "../utils/math_utils";

export class TimelineController {
  private manifest_: Manifest | null = null;
  private media_: HTMLMediaElement | null = null;
  private timeline_: Timeline | null = null;

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHED, this.onMediaDetached_);
  }

  destroy() {
    this.detachMedia_();
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHED, this.onMediaDetached_);
  }

  getTimeline() {
    this.timeline_ ??= this.createTimeline_();
    return this.timeline_;
  }

  private createTimeline_(): Timeline {
    const self = this;
    const timeline = {
      get start() {
        return self.manifest_?.start ?? 0;
      },
      get end() {
        const manifest = self.manifest_;
        if (!manifest) {
          return 0;
        }
        if (manifest.isLive) {
          const { liveDelay } = self.player_.getConfig();
          return Math.max(manifest.end - liveDelay, manifest.start);
        }
        return manifest.end;
      },
      get currentTime() {
        return self.media_?.currentTime ?? NaN;
      },
      seekTo(time: number) {
        if (!self.media_) {
          return;
        }
        const clampedTime = MathUtils.clamp(time, timeline.start, timeline.end);
        self.media_.currentTime = clampedTime;
      },
    };
    return timeline;
  }

  private onManifestUpdated_ = (event: ManifestUpdatedEvent) => {
    this.manifest_ = event.manifest;
    this.player_.emit(Events.TIMELINE_UPDATED);
  };

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.media_.addEventListener("timeupdate", this.onTimeUpdate_);
    this.media_.addEventListener("seeking", this.onTimeUpdate_);
    this.player_.emit(Events.TIMELINE_UPDATED);
  };

  private onMediaDetached_ = () => {
    this.detachMedia_();
    this.player_.emit(Events.TIMELINE_UPDATED);
  };

  private detachMedia_() {
    if (this.media_) {
      this.media_.removeEventListener("timeupdate", this.onTimeUpdate_);
      this.media_.removeEventListener("seeking", this.onTimeUpdate_);
      this.media_ = null;
    }
  }

  private onTimeUpdate_ = () => {
    this.player_.emit(Events.TIMELINE_UPDATED);
  };
}
