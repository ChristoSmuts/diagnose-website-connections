import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DnsEvidence, DnsRecord, ResolverAnswer } from '@dwc/contracts';
import { measured, unavailable } from '@dwc/contracts';
import { errorMessage, stopwatch, withTimeout } from './timing.ts';

const RESOLVER_NAMES: Record<string, string> = {
  '1.1.1.1': 'Cloudflare',
  '8.8.8.8': 'Google',
  '9.9.9.9': 'Quad9',
  '208.67.222.222': 'OpenDNS',
};

function makeResolver(server: string, timeoutMs: number): Resolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([server]);
  return resolver;
}

/**
 * DNS evidence.
 *
 * Two things here are not obvious but earn their cost:
 *
 *  - We query several independent public resolvers and compare answers.
 *    Disagreement means some visitors are being sent somewhere different from
 *    others — a real failure mode that a single lookup cannot possibly reveal.
 *
 *  - We time the domain's own authoritative nameservers directly, separately
 *    from the cached public-resolver path. A fast cached answer tells you
 *    nothing about what a first-time visitor experiences.
 */
export async function probeDns(
  host: string,
  resolvers: readonly string[],
  timeoutMs: number,
): Promise<DnsEvidence> {
  // A literal IP needs no lookup at all, and pretending otherwise would report
  // a misleading 0ms "resolution".
  if (isIP(host) !== 0) {
    return {
      records: [{ type: isIP(host) === 6 ? 'AAAA' : 'A', value: host, ttl: null }],
      resolvers: [],
      consistent: true,
      authoritative: [],
      cnameChainLength: 0,
      minTtlSeconds: null,
      dnssec: null,
      lookupMs: unavailable('ms', 'the address was given directly, so no lookup was needed'),
    };
  }

  const answers: ResolverAnswer[] = await Promise.all(
    resolvers.map(async (server): Promise<ResolverAnswer> => {
      const elapsed = stopwatch();
      try {
        const resolver = makeResolver(server, timeoutMs);
        const [v4, v6] = await Promise.all([
          resolver.resolve4(host).catch(() => [] as string[]),
          resolver.resolve6(host).catch(() => [] as string[]),
        ]);
        const addresses = [...v4, ...v6];
        if (addresses.length === 0) throw new Error('no addresses returned');

        return {
          resolver: server,
          resolverName: RESOLVER_NAMES[server] ?? server,
          addresses,
          durationMs: measured(elapsed(), 'ms'),
          error: null,
        };
      } catch (error) {
        return {
          resolver: server,
          resolverName: RESOLVER_NAMES[server] ?? server,
          addresses: [],
          durationMs: unavailable('ms', 'this resolver did not answer'),
          error: errorMessage(error),
        };
      }
    }),
  );

  const successful = answers.filter((a) => a.error === null);
  const primary = makeResolver(resolvers[0] ?? '1.1.1.1', timeoutMs);
  const records = await collectRecords(primary, host);

  // Compare the *sets* of addresses; ordering varies legitimately with
  // round-robin and anycast and is not a disagreement.
  const signatures = new Set(
    successful.map((a) => [...a.addresses].sort().join(',')).filter((s) => s.length > 0),
  );

  const nameservers = records.filter((r) => r.type === 'NS').map((r) => r.value);
  const authoritative = await timeAuthoritative(nameservers, host, timeoutMs);

  // TTL must come from an authoritative nameserver. A recursive resolver
  // returns the *remaining* lifetime of its cached copy, which counts down
  // continuously — reading it as the site's configured TTL made well-configured
  // domains look misconfigured purely depending on when we happened to ask.
  const authoritativeTtls = authoritative
    .map((a) => a.ttl)
    .filter((t): t is number => t !== null && t > 0);

  const medianLookup = median(
    successful.map((a) => a.durationMs.value).filter((v): v is number => v !== null),
  );

  return {
    records,
    resolvers: answers,
    consistent: signatures.size <= 1,
    authoritative,
    cnameChainLength: records.filter((r) => r.type === 'CNAME').length,
    // Null when no authoritative answer was obtained — the low-TTL finding is
    // then simply not raised, rather than raised on unreliable data.
    minTtlSeconds: authoritativeTtls.length > 0 ? Math.min(...authoritativeTtls) : null,
    // Presence of a DNSSEC-signed answer is not exposed by node:dns, so this is
    // left unknown rather than guessed at.
    dnssec: null,
    lookupMs:
      medianLookup === null
        ? unavailable('ms', 'no resolver answered')
        : measured(medianLookup, 'ms'),
  };
}

async function collectRecords(resolver: Resolver, host: string): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];

  // resolveAny is unreliable across resolvers, so each type is asked for
  // explicitly. Failures are expected and simply mean "no such record".
  const [v4, v6, cname, ns, mx, txt, soa, caa] = await Promise.all([
    resolver.resolve4(host, { ttl: true }).catch(() => []),
    resolver.resolve6(host, { ttl: true }).catch(() => []),
    resolver.resolveCname(host).catch(() => []),
    resolver.resolveNs(host).catch(() => []),
    resolver.resolveMx(host).catch(() => []),
    resolver.resolveTxt(host).catch(() => []),
    resolver.resolveSoa(host).catch(() => null),
    resolver.resolveCaa(host).catch(() => []),
  ]);

  for (const entry of v4) records.push({ type: 'A', value: entry.address, ttl: entry.ttl });
  for (const entry of v6) records.push({ type: 'AAAA', value: entry.address, ttl: entry.ttl });
  for (const value of cname) records.push({ type: 'CNAME', value, ttl: null });
  for (const value of ns) records.push({ type: 'NS', value, ttl: null });
  for (const entry of mx)
    records.push({ type: 'MX', value: `${entry.priority} ${entry.exchange}`, ttl: null });
  for (const entry of txt) records.push({ type: 'TXT', value: entry.join(''), ttl: null });
  if (soa !== null)
    records.push({ type: 'SOA', value: `${soa.nsname} ${soa.hostmaster}`, ttl: soa.minttl });
  for (const entry of caa) {
    const value = Object.entries(entry)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    records.push({ type: 'CAA', value, ttl: null });
  }

  return records;
}

/**
 * Time the domain's own nameservers, bypassing public caches.
 *
 * Capped at three: this is diagnostic colour, not worth hammering someone's
 * infrastructure for.
 */
async function timeAuthoritative(
  nameservers: readonly string[],
  host: string,
  timeoutMs: number,
): Promise<(DnsEvidence['authoritative'][number] & { ttl: number | null })[]> {
  return Promise.all(
    nameservers.slice(0, 3).map(async (nameserver) => {
      try {
        // The nameserver's own name has to be resolved before it can be queried.
        const bootstrap = makeResolver('1.1.1.1', timeoutMs);
        const [address] = await withTimeout(bootstrap.resolve4(nameserver), timeoutMs, 'NS lookup');
        if (address === undefined) throw new Error('nameserver has no address');

        const direct = makeResolver(address, timeoutMs);
        const query = stopwatch();
        // ttl:true so we get the domain's *configured* TTL, not a cached remainder.
        const answers = await withTimeout(
          direct.resolve4(host, { ttl: true }),
          timeoutMs,
          'authoritative query',
        );

        return {
          nameserver,
          durationMs: measured(query(), 'ms'),
          error: null,
          ttl: answers[0]?.ttl ?? null,
        };
      } catch (error) {
        return {
          nameserver,
          durationMs: unavailable('ms', 'this nameserver did not answer directly'),
          error: errorMessage(error),
          ttl: null,
        };
      }
    }),
  );
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  return low !== undefined && high !== undefined ? (low + high) / 2 : null;
}
