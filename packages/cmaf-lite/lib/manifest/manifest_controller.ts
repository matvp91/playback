import * as DashParser from "../dash/dash_parser";
import type { ManifestLoadingEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import type { Manifest } from "../types/manifest";
import { ABORTED, NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";
import { Timer } from "../utils/timer";

const log = Log.create("ManifestController");

export class ManifestController {
  private manifest_: Manifest | null = null;
  private request_: NetworkRequest | null = null;
  private timer_: Timer | null = null;

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  destroy() {
    const networkService = this.player_.getNetworkService();
    if (this.request_) {
      networkService.cancel(this.request_);
    }
    if (this.timer_) {
      this.timer_.stop();
      this.timer_ = null;
    }
    this.player_.off(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  private onManifestLoading_ = (event: ManifestLoadingEvent) => {
    this.timer_ = new Timer(() => this.fetch_(event.url)).tickNow();
  };

  private async fetch_(url: string) {
    const networkService = this.player_.getNetworkService();
    const config = this.player_.getConfig();
    this.request_ = networkService.request(
      NetworkRequestType.MANIFEST,
      url,
      config.manifestRequestOptions,
    );
    const response = await this.request_.promise;
    if (response === ABORTED) {
      return;
    }

    let isUpdate = false;
    if (!this.manifest_) {
      this.manifest_ = DashParser.create(response.text, response.request.url);
    } else {
      isUpdate = true;
      DashParser.update(this.manifest_, response.text, response.request.url);
    }

    log.info(`Manifest ${isUpdate ? "updated" : "created"}`, this.manifest_);
    this.player_.emit(Events.MANIFEST_UPDATED, {
      manifest: this.manifest_,
      isUpdate,
    });

    if (this.timer_ && this.manifest_.isLive) {
      const { liveUpdateTime } = this.player_.getConfig();
      this.timer_.tickAfter(liveUpdateTime);
    }
  }
}
