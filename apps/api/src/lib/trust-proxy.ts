export function trustProxyOption(addresses: readonly string[]): false | string[] {
  return addresses.length ? [...addresses] : false;
}
