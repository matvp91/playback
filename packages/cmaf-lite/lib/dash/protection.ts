import type * as txml from "txml";
import type { KeySystemInfo, Protection } from "../types/manifest";
import { KeySystem } from "../types/media";
import * as XmlUtils from "../utils/xml_utils";

const MP4_PROTECTION_SCHEME = "urn:mpeg:dash:mp4protection:2011";

const KEY_SYSTEM_BY_UUID: Record<string, KeySystem> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": KeySystem.WIDEVINE,
  "9a04f079-9840-4286-ab92-e65be0885f95": KeySystem.PLAYREADY,
  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2": KeySystem.FAIRPLAY,
};

/**
 * Reads all `<ContentProtection>` elements on an AdaptationSet
 * and returns a `Protection` model, or `null` when no protection
 * is signalled.
 */
export function readProtection(adaptationSet: txml.TNode): Protection | null {
  const elements = XmlUtils.children(adaptationSet, "ContentProtection");
  if (elements.length === 0) {
    return null;
  }

  let scheme: "cenc" | "cbcs" | null = null;
  let defaultKid: string | null = null;
  const keySystems: Partial<Record<KeySystem, KeySystemInfo>> = {};

  for (const el of elements) {
    const schemeIdUri = XmlUtils.attr(el, "schemeIdUri", XmlUtils.parseString);
    if (!schemeIdUri) {
      continue;
    }

    if (schemeIdUri === MP4_PROTECTION_SCHEME) {
      const value = XmlUtils.attr(el, "value", XmlUtils.parseString);
      if (value === "cenc" || value === "cbcs") {
        scheme = value;
      }
      const kid = XmlUtils.attr(el, "cenc:default_KID", XmlUtils.parseString);
      if (kid) {
        defaultKid = kid.toLowerCase();
      }
      continue;
    }

    const uuid = extractUuid(schemeIdUri);
    if (!uuid) {
      continue;
    }
    const keySystem = KEY_SYSTEM_BY_UUID[uuid];
    if (!keySystem) {
      continue;
    }

    keySystems[keySystem] = readKeySystemInfo(el, keySystem);
  }

  if (scheme === null) {
    return null;
  }
  if (defaultKid === null) {
    throw new Error(
      "ContentProtection: mp4protection present without cenc:default_KID",
    );
  }
  return { scheme, defaultKid, keySystems };
}

function extractUuid(schemeIdUri: string): string | null {
  const match = /^urn:uuid:([0-9a-f-]+)$/i.exec(schemeIdUri);
  return match ? (match[1]?.toLowerCase() ?? null) : null;
}

function readKeySystemInfo(
  el: txml.TNode,
  keySystem: KeySystem,
): KeySystemInfo {
  if (keySystem === KeySystem.FAIRPLAY) {
    const valueAttr = XmlUtils.attr(el, "value", XmlUtils.parseString);
    if (valueAttr?.startsWith("skd://")) {
      return { contentId: valueAttr };
    }
    const child = XmlUtils.children(el, "cenc:pssh")[0];
    const psshText = child ? XmlUtils.text(child) : undefined;
    if (psshText?.startsWith("skd://")) {
      return { contentId: psshText };
    }
    return {};
  }

  const psshNode = XmlUtils.children(el, "cenc:pssh")[0];
  if (!psshNode) {
    return {};
  }
  const base64 = XmlUtils.text(psshNode);
  if (!base64) {
    return {};
  }
  return { pssh: base64ToBytes(base64.trim()) };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
