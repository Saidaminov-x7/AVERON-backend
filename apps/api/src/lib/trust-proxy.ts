export function trustProxyOption(addresses: readonly string[]): false | string[] {
  if (addresses.length) return [...addresses];
  return false;
}
