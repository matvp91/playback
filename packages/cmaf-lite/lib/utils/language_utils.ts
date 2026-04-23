export function toBCP47(value: string) {
  const locale = new Intl.Locale(value);
  // IETF BCP 47
  return `${locale.language}${locale.region ? ` ${locale.region}` : ""}`;
}
