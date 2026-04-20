import { LANGUAGE_UNKNOWN } from "../types/manifest";

export function toBCP47(value?: string) {
  if (!value || value === "und") {
    return LANGUAGE_UNKNOWN;
  }
  const locale = new Intl.Locale(value);
  // IETF BCP 47
  return `${locale.language}${locale.region ? ` ${locale.region}` : ""}`;
}
