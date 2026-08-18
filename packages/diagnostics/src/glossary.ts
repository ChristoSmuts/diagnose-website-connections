import type { Finding, GlossaryEntry } from '@dwc/contracts';

/**
 * Plain definitions for every term the report can surface.
 *
 * Layer 1 and 2 avoid jargon entirely, but Layer 3 cannot — so every technical
 * term gets a one-line explanation attached to it rather than being left for
 * the reader to look up.
 */
const DEFINITIONS: Record<string, string> = {
  DNS: 'The internet’s address book. It turns a name like example.com into the numeric address computers actually use.',
  TTFB: 'Time to first byte — how long the server takes to start sending a page after being asked for it. It measures the server thinking, not the network.',
  TLS: 'The encryption that puts the padlock in your browser’s address bar and the S in HTTPS.',
  TCP: 'The basic method computers use to open a connection to each other before any data is exchanged.',
  'Round trip':
    'How long it takes a small message to reach a server and come back. The single best measure of how responsive a connection feels.',
  Jitter:
    'How much the round-trip time varies from moment to moment. Steady is better than fast-but-erratic.',
  'Packet loss':
    'Data that never arrives and has to be sent again. Causes sudden stalls and hurts far more than plain slowness.',
  CDN: 'A content delivery network — copies of a site kept in many places worldwide so visitors connect to one nearby.',
  'HTTP/2':
    'A newer way of transferring pages that fetches many files at once over a single connection.',
  'HTTP/3':
    'The newest transfer protocol. It copes better with unreliable connections, such as mobile.',
  Compression:
    'Shrinking text before sending it. Typically cuts the amount transferred by around 70%.',
  Certificate: 'The digital document proving a website is genuinely who it claims to be.',
  'OCSP stapling':
    'The server proving up front that its certificate has not been revoked, saving the browser a separate check.',
  'Session resumption':
    'Letting a returning visitor skip most of the encryption setup they already completed earlier.',
  ALPN: 'The negotiation during connection setup where browser and server agree which version of HTTP to speak.',
  TTL: 'How long browsers may remember an address before looking it up again.',
  ASN: 'The identifier for the network operator a server sits on — useful for telling a hosting provider from a CDN.',
  IPv6: 'The modern style of internet address, gradually replacing the older IPv4 as those addresses run out.',
  Anycast:
    'One address served from many locations at once, so traffic reaches whichever is closest.',
  Median:
    'The middle value of all our samples. Used instead of an average because one unusually slow request would distort an average.',
  Percentile:
    'The 95th percentile is the level below which 95% of samples fell — it describes the bad-but-not-freak cases.',
};

/** Terms each finding relies on, so the glossary shows only what is relevant. */
const TERMS_BY_CODE: Partial<Record<Finding['code'], readonly string[]>> = {
  'dns-slow': ['DNS', 'TTL'],
  'dns-resolver-disagreement': ['DNS'],
  'dns-long-cname-chain': ['DNS'],
  'dns-low-ttl': ['DNS', 'TTL'],
  'tcp-slow': ['TCP', 'Round trip', 'CDN', 'ASN'],
  'ipv6-broken': ['IPv6'],
  'ipv6-absent': ['IPv6'],
  'tls-handshake-slow': ['TLS', 'Certificate'],
  'tls-cert-expiring-soon': ['Certificate', 'TLS'],
  'tls-cert-expired': ['Certificate', 'TLS'],
  'tls-cert-hostname-mismatch': ['Certificate', 'TLS'],
  'tls-outdated-protocol': ['TLS'],
  'tls-long-chain': ['Certificate', 'TLS'],
  'tls-no-resumption': ['Session resumption', 'TLS'],
  'tls-no-ocsp-stapling': ['OCSP stapling', 'Certificate'],
  'ttfb-slow': ['TTFB'],
  'redirect-chain-long': ['Round trip'],
  'no-compression': ['Compression'],
  'no-http2': ['HTTP/2', 'ALPN'],
  'no-http3': ['HTTP/3'],
  'no-cache-headers': ['CDN'],
  'unstable-response-times': ['TTFB', 'Median', 'Percentile'],
  'no-cdn-caching-benefit': ['CDN', 'TTFB'],
  'client-high-latency': ['Round trip'],
  'client-high-jitter': ['Jitter', 'Round trip'],
  'client-packet-loss': ['Packet loss'],
  'client-low-throughput': ['Round trip'],
  'path-degraded': ['Round trip', 'CDN'],
  'no-cdn': ['CDN', 'ASN', 'Anycast'],
};

/** Only the terms actually used, alphabetised — never the whole dictionary. */
export function buildGlossary(findings: readonly Finding[]): GlossaryEntry[] {
  const terms = new Set<string>();
  for (const f of findings) {
    for (const term of TERMS_BY_CODE[f.code] ?? []) terms.add(term);
  }

  return [...terms]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((term) => {
      const definition = DEFINITIONS[term];
      return definition === undefined ? [] : [{ term, definition }];
    });
}
