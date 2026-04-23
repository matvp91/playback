import { parseManifest } from "../dash/dash_parser";
import type { ManifestLoadingEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import { ABORTED, NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";

const log = Log.create("ManifestController");

export class ManifestController {
  private request_: NetworkRequest | null = null;

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  destroy() {
    const networkService = this.player_.getNetworkService();
    if (this.request_) {
      networkService.cancel(this.request_);
    }
    this.player_.off(Events.MANIFEST_LOADING, this.onManifestLoading_);
  }

  private onManifestLoading_ = async (event: ManifestLoadingEvent) => {
    const networkService = this.player_.getNetworkService();
    const config = this.player_.getConfig();
    this.request_ = networkService.request(
      NetworkRequestType.MANIFEST,
      event.url,
      config.manifestRequestOptions,
    );

    const response = await this.request_.promise;
    if (response === ABORTED) {
      return;
    }

    // TODO(matvp): We used to have a registry lookup but that complicated
    // things. We shall look at this again later. For now, always assume
    // that it's DASH.
    const manifest = parseManifest(response.text, response.request.url);
    log.info("Manifest", manifest);
    this.player_.emit(Events.MANIFEST_PARSED, { manifest });
  };
}
