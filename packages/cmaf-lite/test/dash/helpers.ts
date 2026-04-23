import type { Manifest, SwitchingSet } from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";

export function findVideo(
  manifest: Manifest,
): SwitchingSet & { type: MediaType.VIDEO } {
  const ss = manifest.switchingSets.find(
    (s): s is SwitchingSet & { type: MediaType.VIDEO } =>
      s.type === MediaType.VIDEO,
  );
  if (!ss) throw new Error("No video switching set found");
  return ss;
}

export function findAudio(
  manifest: Manifest,
): SwitchingSet & { type: MediaType.AUDIO } {
  const ss = manifest.switchingSets.find(
    (s): s is SwitchingSet & { type: MediaType.AUDIO } =>
      s.type === MediaType.AUDIO,
  );
  if (!ss) throw new Error("No audio switching set found");
  return ss;
}

export function findSubtitle(
  manifest: Manifest,
): SwitchingSet & { type: MediaType.SUBTITLE } {
  const ss = manifest.switchingSets.find(
    (s): s is SwitchingSet & { type: MediaType.SUBTITLE } =>
      s.type === MediaType.SUBTITLE,
  );
  if (!ss) throw new Error("No subtitle switching set found");
  return ss;
}
