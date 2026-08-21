import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Server-Side Request Forgery protection.
 *
 * This service accepts a URL from an untrusted user and then connects to it.
 * That is the textbook SSRF shape, and on a cloud host it is a direct route to
 * credential theft via the metadata endpoint. Everything here is a first-class
 * requirement rather than hardening applied later.
 *
 * The defence has three parts, and all three are necessary:
 *
 *  1. Reject non-http(s) schemes outright — file:, gopher: and friends.
 *  2. Resolve the hostname ourselves, then check every returned address
 *     against a denylist of private, loopback, link-local and metadata ranges.
 *  3. Connect to the *validated address* rather than re-resolving the name.
 *     Without this, an attacker controlling DNS can answer once with a public
 *     address to pass the check and again with 127.0.0.1 for the connection —
 *     DNS rebinding. Pinning the checked IP closes that window.
 */

export class BlockedTargetError extends Error {
  readonly code = 'blocked-target' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

export class InvalidUrlError extends Error {
  readonly code = 'invalid-url' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

/** Cloud instance metadata. Reaching this is the highest-value SSRF outcome. */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS, GCP, Azure, DigitalOcean, OpenStack
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IPv6
]);

/** Parse dotted-quad IPv4 into a 32-bit integer for range comparison. */
function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const cidr = (base: string, bits: number): { start: number; end: number } => {
  const start = ipv4ToInt(base) ?? 0;
  const size = 2 ** (32 - bits);
  return { start, end: start + size - 1 };
};

/** IPv4 ranges that must never be reachable through this service. */
const BLOCKED_V4 = [
  { range: cidr('0.0.0.0', 8), reason: 'this network' },
  { range: cidr('10.0.0.0', 8), reason: 'a private network' },
  { range: cidr('100.64.0.0', 10), reason: 'a carrier-grade NAT range' },
  { range: cidr('127.0.0.0', 8), reason: 'the loopback address' },
  { range: cidr('169.254.0.0', 16), reason: 'a link-local address' },
  { range: cidr('172.16.0.0', 12), reason: 'a private network' },
  { range: cidr('192.0.0.0', 24), reason: 'a reserved range' },
  { range: cidr('192.0.2.0', 24), reason: 'a documentation range' },
  { range: cidr('192.168.0.0', 16), reason: 'a private network' },
  { range: cidr('198.18.0.0', 15), reason: 'a benchmarking range' },
  { range: cidr('198.51.100.0', 24), reason: 'a documentation range' },
  { range: cidr('203.0.113.0', 24), reason: 'a documentation range' },
  { range: cidr('224.0.0.0', 4), reason: 'a multicast address' },
  { range: cidr('240.0.0.0', 4), reason: 'a reserved range' },
] as const;

function describeBlockedV4(address: string): string | null {
  if (METADATA_ADDRESSES.has(address)) return 'a cloud metadata endpoint';

  const value = ipv4ToInt(address);
  if (value === null) return 'an unparseable address';

  for (const { range, reason } of BLOCKED_V4) {
    if (value >= range.start && value <= range.end) return reason;
  }
  return null;
}

function describeBlockedV6(address: string): string | null {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_ADDRESSES.has(normalized)) return 'a cloud metadata endpoint';

  if (normalized === '::1' || normalized === '::') return 'the loopback address';
  // fc00::/7 — unique local addresses.
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'a private network';
  // fe80::/10 — link-local.
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return 'a link-local address';

  // IPv4-mapped (::ffff:127.0.0.1) would otherwise bypass the v4 checks.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1] !== undefined) return describeBlockedV4(mapped[1]);

  return null;
}

/** Returns a human-readable reason when an address is not allowed, else null. */
export function describeBlockedAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return describeBlockedV4(address);
  if (family === 6) return describeBlockedV6(address);
  return 'an unrecognised address';
}

export function assertAddressAllowed(address: string): void {
  const reason = describeBlockedAddress(address);
  if (reason !== null) {
    throw new BlockedTargetError(
      `This address cannot be checked because it points at ${reason}. Only public websites can be tested.`,
    );
  }
}

/**
 * Whether a hostname is unusable as a control endpoint for the browser.
 *
 * Distinct from `describeBlockedAddress`, and deliberately so: that answers "may
 * the probe engine connect to this?" about a resolved address, whereas this
 * answers "can a browser learn anything about its own internet from this?" about
 * a configured name, before any DNS exists. It leans on the same denylist for
 * literals and adds the names DNS would otherwise have to resolve.
 *
 * Covers more than loopback, because the denylist does: private ranges, link-local,
 * and the documentation ranges too. None of them describe a round trip across the
 * internet, which is the only thing a control endpoint is for.
 *
 * Used to refuse an unusable `CONTROL_URL` at boot. The browser makes the same
 * judgement again at measurement time — see `isLocalHost` in the web app — and
 * that duplication is intentional: this one catches a misconfiguration, that one
 * catches a control endpoint reached through a local proxy, which no amount of
 * reading the configured string can see.
 */
export function isUnreachableControlHost(hostname: string): boolean {
  // URL.hostname brackets IPv6 literals; isIP() does not recognise them.
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare.length === 0) return true;

  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  // mDNS: resolvable on the local network only.
  if (bare.endsWith('.local')) return true;

  if (isIP(bare) !== 0) return describeBlockedAddress(bare) !== null;

  return false;
}

export interface NormalizedTarget {
  normalizedUrl: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
}

/**
 * Accept what a user would actually type and turn it into something safe.
 *
 * Deliberately forgiving about input (bare hostnames, missing scheme, stray
 * whitespace) and completely unforgiving about the result.
 */
export function normalizeUrl(input: string): NormalizedTarget {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidUrlError('Enter a website address to check.');

  // People type "example.com", not "https://example.com".
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidUrlError(`"${input}" does not look like a website address.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError('Only http and https addresses can be checked.');
  }

  if (url.hostname.length === 0) {
    throw new InvalidUrlError(`"${input}" does not include a website name.`);
  }

  // URL.hostname wraps IPv6 literals in brackets ("[::1]"), which isIP() does
  // not recognise. Stripping them first is essential: without it, an IPv6
  // loopback or link-local literal skips the denylist entirely and reaches
  // localhost services.
  const bareHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // A bare IP is allowed only if it is public; the denylist still applies.
  if (isIP(bareHost) !== 0) assertAddressAllowed(bareHost);

  // Credentials in a probe URL are never intended and would be logged.
  url.username = '';
  url.password = '';
  url.hash = '';

  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port !== '' ? Number(url.port) : scheme === 'https' ? 443 : 80;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidUrlError('That port number is not valid.');
  }

  return {
    normalizedUrl: url.toString(),
    // Bracket-free, so it can be passed straight to DNS or a socket.
    host: bareHost,
    port,
    scheme,
  };
}

export interface SafeResolution {
  /** Addresses that passed validation and may be connected to. */
  addresses: { address: string; family: 4 | 6 }[];
  /** Addresses that were resolved but rejected, with reasons — surfaced to the user. */
  blocked: { address: string; reason: string }[];
}

/**
 * Resolve a hostname and validate every answer.
 *
 * Uses explicit resolvers rather than the system one. This was not a
 * theoretical concern: during development the host's resolver was a local proxy
 * on 127.0.0.1 that refused queries outright, while an explicit public resolver
 * worked. Relying on system DNS would make measurements depend on wherever the
 * container happens to run.
 */
export async function resolveSafely(
  host: string,
  resolvers: readonly string[],
): Promise<SafeResolution> {
  // A literal IP has already been validated by normalizeUrl.
  const family = isIP(host);
  if (family !== 0) {
    return { addresses: [{ address: host, family: family === 6 ? 6 : 4 }], blocked: [] };
  }

  const resolver = new Resolver();
  resolver.setServers([...resolvers]);

  const [v4, v6] = await Promise.all([
    resolver.resolve4(host).catch(() => [] as string[]),
    resolver.resolve6(host).catch(() => [] as string[]),
  ]);

  const addresses: { address: string; family: 4 | 6 }[] = [];
  const blocked: { address: string; reason: string }[] = [];

  for (const address of v4) {
    const reason = describeBlockedAddress(address);
    if (reason === null) addresses.push({ address, family: 4 });
    else blocked.push({ address, reason });
  }
  for (const address of v6) {
    const reason = describeBlockedAddress(address);
    if (reason === null) addresses.push({ address, family: 6 });
    else blocked.push({ address, reason });
  }

  if (addresses.length === 0 && blocked.length > 0) {
    throw new BlockedTargetError(
      `This name resolves to ${blocked[0]?.reason ?? 'a blocked address'}, so it cannot be checked.`,
    );
  }

  return { addresses, blocked };
}
