import type { KeySystemInfo } from "../types/manifest";
import { KeySystem } from "../types/media";

const KEY_SYSTEM_BY_UUID: Record<string, KeySystem> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": KeySystem.WIDEVINE,
  "9a04f079-9840-4286-ab92-e65be0885f95": KeySystem.PLAYREADY,
  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2": KeySystem.FAIRPLAY,
};

/**
 * Maps a `urn:uuid:<uuid>` schemeIdUri to a canonical {@link KeySystem},
 * or `null` if the UUID is not a key system we support.
 */
export function keySystemFromSchemeIdUri(uri: string): KeySystem | null {
  const match = /^urn:uuid:([0-9a-f-]+)$/i.exec(uri);
  if (!match) {
    return null;
  }
  const uuid = match[1]?.toLowerCase();
  if (!uuid) {
    return null;
  }
  return KEY_SYSTEM_BY_UUID[uuid] ?? null;
}

/**
 * Builds a {@link KeySystemInfo} from the raw strings extracted from
 * a key-system `<ContentProtection>` element. FairPlay carries a
 * `skd://` content identifier (in `value=` or in a child); other key
 * systems carry a base64 PSSH blob inside `<cenc:pssh>`. Returns an
 * empty object when nothing usable is present.
 */
export function keySystemInfoFromRaw(
  keySystem: KeySystem,
  value: string | undefined,
  psshText: string | undefined,
): KeySystemInfo {
  if (keySystem === KeySystem.FAIRPLAY) {
    if (value?.startsWith("skd://")) {
      return { contentId: value };
    }
    if (psshText?.startsWith("skd://")) {
      return { contentId: psshText };
    }
    return {};
  }
  if (!psshText) {
    return {};
  }
  return { pssh: decodeBase64(psshText.trim()) };
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
