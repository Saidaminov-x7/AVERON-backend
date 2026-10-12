export function trustProxyOption(
  addresses: readonly string[],
): false | string[] {
  if (addresses.length) return [...addresses];
  // Never infer trust from a hosting-platform environment variable. A public
  // client can supply X-Forwarded-* headers unless the immediate proxy is
  // explicitly trusted by address.
  return false;
}
