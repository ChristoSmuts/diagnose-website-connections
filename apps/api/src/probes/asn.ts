import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NetworkIdentity } from '@dwc/contracts';

/**
 * Network ownership lookup via Team Cymru's DNS-based service.
 *
 * Chosen because it is genuinely free, needs no account or API key, and answers
 * over plain DNS — which keeps the "open source and free, self-hostable" promise
 * intact with no third-party signup. Verified working during planning:
 *   229.132.16.104.origin.asn.cymru.com TXT →
 *   "13335 | 104.16.0.0/12 | US | arin | ..."
 */

/** ASNs whose traffic is served from a CDN edge rather than a single origin. */
const CDN_ASNS: Record<string, string> = {
  '13335': 'Cloudflare',
  '16509': 'Amazon CloudFront',
  '14618': 'Amazon',
  '16625': 'Akamai',
  '20940': 'Akamai',
  '32787': 'Akamai',
  '54113': 'Fastly',
  '15169': 'Google',
  '396982': 'Google Cloud',
  '8075': 'Microsoft Azure',
  '13414': 'Twitter',
  '54994': 'Bunny CDN',
  '60068': 'Datacamp / Bunny',
  '19551': 'Incapsula',
  '55002': 'StackPath',
  '30081': 'CacheFly',
  '394536': 'Vercel',
  '13649': 'Netlify',
};

/** Reverse an address into the label order Cymru's zone expects. */
function toQueryName(address: string): string | null {
  if (isIP(address) === 4) {
    return `${address.split('.').reverse().join('.')}.origin.asn.cymru.com`;
  }
  if (isIP(address) === 6) {
    const expanded = expandIpv6(address);
    if (expanded === null) return null;
    return `${expanded.split('').reverse().join('.')}.origin6.asn.cymru.com`;
  }
  return null;
}

/** Expand an abbreviated IPv6 address into 32 bare hex digits. */
export function expandIpv6(address: string): string | null {
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail.length > 0 ? tail.split(':') : [];

  if (headParts.length + tailParts.length > 8) return null;

  const missing = 8 - headParts.length - tailParts.length;
  const groups = address.includes('::')
    ? [...headParts, ...Array<string>(missing).fill('0'), ...tailParts]
    : headParts;

  if (groups.length !== 8) return null;

  return groups
    .map((group) => {
      if (!/^[0-9a-f]{0,4}$/.test(group)) return null;
      return group.padStart(4, '0');
    })
    .join('');
}

export async function probeAsn(
  address: string,
  resolvers: readonly string[],
  timeoutMs = 4000,
): Promise<NetworkIdentity> {
  const empty: NetworkIdentity = {
    asn: null,
    asnName: null,
    prefix: null,
    country: null,
    registry: null,
    cdnDetected: null,
  };

  const queryName = toQueryName(address);
  if (queryName === null) return empty;

  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([...resolvers]);

  try {
    const answer = await resolver.resolveTxt(queryName);
    const record = answer.flat().join('');
    // "13335 | 104.16.0.0/12 | US | arin | 2010-07-21"
    const [asn, prefix, country, registry] = record.split('|').map((part) => part.trim());
    if (asn === undefined || asn.length === 0) return empty;

    // The ASN's human name lives in a second, separate zone.
    const asnName = await lookupAsnName(resolver, asn);

    return {
      asn: `AS${asn}`,
      asnName,
      prefix: prefix ?? null,
      country: country ?? null,
      registry: registry ?? null,
      cdnDetected: CDN_ASNS[asn] ?? null,
    };
  } catch {
    // Enrichment is a nice-to-have; a resolver that blocks this zone must not
    // fail the whole diagnostic.
    return empty;
  }
}

async function lookupAsnName(resolver: Resolver, asn: string): Promise<string | null> {
  try {
    const answer = await resolver.resolveTxt(`AS${asn}.asn.cymru.com`);
    const record = answer.flat().join('');
    // "13335 | US | arin | 2010-07-14 | CLOUDFLARENET, US"
    const parts = record.split('|').map((part) => part.trim());
    const name = parts[4];
    return name !== undefined && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
