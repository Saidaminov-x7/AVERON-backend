export function trustProxyOption(
  addresses: readonly string[],
  managedPlatformProxy = false,
): false | true | string[] {
  if (addresses.length) return [...addresses];
  return managedPlatformProxy ? true : false;
}
