import * as DashParser from "../dash/dash_parser";
import type { ManifestLoadingEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import type { Manifest } from "../types/manifest";
import { ABORTED, NetworkRequestType } from "../types/net";
import * as asserts from "../utils/asserts";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";

const log = Log.create("ManifestController");

export class ManifestController {
  private manifest_: Manifest | null = null;
  private sourceUrl_: string | null = null;
  private request_: NetworkRequest | null = null;
  private timer_ = new Timer(() => this.fetchAndApply_());
  private destroyed_ = false;

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  destroy() {
    this.destroyed_ = true;
    const networkService = this.player_.getNetworkService();
    if (this.request_) {
      networkService.cancel(this.request_);
    }
    this.timer_.stop();
    this.player_.off(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  private onManifestLoading_ = (event: ManifestLoadingEvent) => {
    this.sourceUrl_ = event.url;
    this.timer_.tickNow();
  };

  private fetchAndApply_ = async () => {
    asserts.assertExists(this.sourceUrl_, "No source URL");

    const networkService = this.player_.getNetworkService();
    const config = this.player_.getConfig();
    this.request_ = networkService.request(
      NetworkRequestType.MANIFEST,
      this.sourceUrl_,
      config.manifestRequestOptions,
    );

    try {
      const response = await this.request_.promise;
      if (this.destroyed_) {
        return;
      }
      if (response === ABORTED) {
        this.scheduleNext_();
        return;
      }

      if (!this.manifest_) {
        this.manifest_ = DashParser.create(response.text, response.request.url);
        log.info("Manifest created", this.manifest_);
        this.player_.emit(Events.MANIFEST_CREATED, {
          manifest: this.manifest_,
        });
      } else {
        DashParser.update(this.manifest_, response.text, response.request.url);
        log.info("Manifest updated", this.manifest_);
        this.player_.emit(Events.MANIFEST_UPDATED, {
          manifest: this.manifest_,
        });
      }
    } catch (error) {
      if (this.destroyed_) {
        return;
      }
      log.info("Manifest fetch failed", error);
    }

    this.scheduleNext_();
  };

  private scheduleNext_() {
    if (this.destroyed_) {
      return;
    }
    if (this.manifest_?.isLive) {
      this.timer_.tickAfter(this.player_.getConfig().liveUpdateTime);
    }
  }
}
