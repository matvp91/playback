import type { ManifestUpdatedEvent, MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { Manifest } from "../types/manifest";
import type { Timeline } from "../types/media";

export class TimelineController {
  private manifest_: Manifest | null = null;
  private media_: HTMLMediaElement | null = null;
  private timeline_: Timeline;

  constructor(private player_: Player) {
    const controller = this;
    this.timeline_ = {
      get start() {
        return controller.manifest_?.start ?? 0;
      },
      get end() {
        const manifest = controller.manifest_;
        if (!manifest) {
          return 0;
        }
        if (!manifest.isLive) {
          return manifest.end;
        }
        const { liveDelay } = controller.player_.getConfig();
        return Math.max(manifest.end - liveDelay, manifest.start);
      },
      get currentTime() {
        return controller.media_?.currentTime ?? 0;
      },
    };

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
    return this.timeline_;
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
    this.media_?.removeEventListener("timeupdate", this.onTimeUpdate_);
    this.media_?.removeEventListener("seeking", this.onTimeUpdate_);
    this.media_ = null;
  }

  private onTimeUpdate_ = () => {
    this.player_.emit(Events.TIMELINE_UPDATED);
  };
}
