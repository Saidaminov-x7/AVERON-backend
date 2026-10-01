import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type OutboundAddressResolver = (hostname: string) => Promise<readonly string[]>;

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first, second, third] = octets as [number, number, number, number];
  return first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0 && third === 113);
}

function ipv6Value(address: string): bigint | undefined {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0 || isIP(value.slice(separator + 1)) !== 4) return undefined;
    const octets = value.slice(separator + 1).split('.').map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = `${value.slice(0, separator)}:${high}:${low}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return undefined;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;
  const value = ipv6Value(address);
  if (value === undefined || value === 0n || value === 1n) return false;
  const inRange = (base: bigint, bits: bigint) => value >> (128n - bits) === base >> (128n - bits);
  return !(
    value >> 32n === 0xffffn
    || value >> 32n === 0n
    || inRange(0xfc00n << 112n, 7n)
    || inRange(0xfe80n << 112n, 10n)
    || inRange(0xff00n << 120n, 8n)
    || inRange(0x20010db8n << 96n, 32n)
    || inRange(0x20010010n << 96n, 28n)
    || inRange(0x2002n << 112n, 16n)
  );
}

export async function isSafePublicHttpUrl(
  value: string,
  resolve: OutboundAddressResolver = resolveAddresses,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username.length > 0
    || url.password.length > 0
    || !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    return false;
  }
  try {
    const addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
    return addresses.length > 0 && addresses.every(isPublicAddress);
  } catch {
    return false;
  }
}
