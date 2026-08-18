import type { Finding, ServerEvidence } from '@dwc/contracts';
import { instabilityRatio } from '../stats.js';
import { CERT_EXPIRY, OUTDATED_TLS_PROTOCOLS, THRESHOLDS, classify } from '../thresholds.js';
import { finding, formatBytes, ms } from './helpers.js';

/** DNS: the delay before anything else can even begin. */
export function detectDnsFindings(server: ServerEvidence): Finding[] {
  const out: Finding[] = [];
  const lookup = server.dns.lookupMs.value;

  const band = classify(lookup, THRESHOLDS.dnsMs);
  if (lookup !== null && (band === 'degraded' || band === 'bad')) {
    out.push(
      finding({
        code: 'dns-slow',
        severity: band === 'bad' ? 'major' : 'minor',
        owner: 'site-owner',
        title: 'Looking up the address is slow',
        plain: `Before a browser can load anything, it has to turn "${server.target.host}" into a numeric address. That step took ${ms(lookup)}.`,
        impact:
          'Every visitor pays this delay before the page even starts loading, and it happens again whenever the lookup expires.',
        technical: `DNS resolution took ${ms(lookup)}. Healthy authoritative nameservers typically answer in under ${THRESHOLDS.dnsMs.ok} ms.`,
        evidence: [
          { label: 'DNS lookup time', value: ms(lookup) },
          {
            label: 'Nameservers',
            value:
              server.dns.records
                .filter((r) => r.type === 'NS')
                .map((r) => r.value)
                .join(', ') || 'none found',
          },
        ],
        remediation: {
          summary: 'Move DNS to a provider with a global anycast network.',
          steps: [
            'Check who currently hosts the domain’s DNS — often the domain registrar by default, which is rarely the fastest option.',
            'Move DNS hosting to an anycast provider so lookups are answered from a server near each visitor.',
            'Keep the record TTLs reasonably long so answers get cached and the lookup is skipped entirely for repeat visitors.',
          ],
          expectedImprovement: 'Typically brings lookups under 30 ms worldwide.',
        },
      }),
    );
  }

  if (!server.dns.consistent && server.dns.resolvers.length > 1) {
    out.push(
      finding({
        code: 'dns-resolver-disagreement',
        severity: 'major',
        owner: 'site-owner',
        confidence: 'medium',
        title: 'Different DNS providers disagree about this site’s address',
        plain:
          'We asked several public DNS services where this site lives and they gave different answers. That means some visitors are being sent somewhere different from others.',
        impact:
          'Some people may reach an old server, or fail to reach the site at all, while it looks perfectly fine to everyone else — the classic "works for me" problem.',
        technical: server.dns.resolvers
          .map(
            (r) => `${r.resolverName} (${r.resolver}) → ${r.addresses.join(', ') || 'no answer'}`,
          )
          .join('; '),
        evidence: server.dns.resolvers.map((r) => ({
          label: r.resolverName,
          value: r.addresses.join(', ') || 'no answer',
        })),
        remediation: {
          summary: 'Usually a DNS change still propagating, or leftover records.',
          steps: [
            'If the address was changed recently, wait for the old TTL to expire before concluding anything is broken.',
            'Check for duplicate or stale A/AAAA records left behind at the DNS provider.',
            'Make sure every nameserver for the domain is serving the same zone data.',
          ],
        },
      }),
    );
  }

  if (server.dns.cnameChainLength > THRESHOLDS.cnameChainLength) {
    out.push(
      finding({
        code: 'dns-long-cname-chain',
        severity: 'minor',
        owner: 'site-owner',
        title: 'The address lookup takes several hops',
        plain: `Finding this site's address involves ${server.dns.cnameChainLength} redirections within DNS before arriving at a real address.`,
        impact: 'Each hop is another round trip before the page can start loading.',
        technical: `CNAME chain length is ${server.dns.cnameChainLength}. Each link requires a further resolution step.`,
        evidence: [{ label: 'CNAME chain length', value: String(server.dns.cnameChainLength) }],
        remediation: {
          summary: 'Flatten the chain so the domain points more directly at its destination.',
          steps: [
            'Point the record at the final destination rather than chaining through intermediates.',
            'Many DNS providers offer CNAME flattening or ALIAS records that resolve the chain server-side.',
          ],
        },
      }),
    );
  }

  const minTtl = server.dns.minTtlSeconds;
  if (minTtl !== null && minTtl < THRESHOLDS.minTtlSeconds) {
    out.push(
      finding({
        code: 'dns-low-ttl',
        severity: 'info',
        owner: 'site-owner',
        title: 'Address lookups expire very quickly',
        plain: `The site tells browsers to forget its address after ${minTtl} seconds, so they have to look it up again constantly.`,
        impact: 'Repeat visitors pay the lookup delay far more often than necessary.',
        technical: `Minimum record TTL is ${minTtl}s.`,
        evidence: [{ label: 'Lowest TTL', value: `${minTtl}s` }],
        remediation: {
          summary: 'Raise the TTL once the address is stable.',
          steps: [
            'Short TTLs are sensible during a migration — raise them again afterwards.',
            'Values between 300 and 3600 seconds suit most sites.',
          ],
        },
      }),
    );
  }

  return out;
}

/** Reachability, including the IPv4/IPv6 split that hides "slow for some people". */
export function detectConnectivityFindings(server: ServerEvidence): Finding[] {
  const out: Finding[] = [];

  const v6 = server.addresses.filter((a) => a.family === 6);
  const v4 = server.addresses.filter((a) => a.family === 4);

  /**
   * ENETUNREACH / EAFNOSUPPORT mean *our own* host has no route to the IPv6
   * internet — the packets never left. That says nothing whatsoever about the
   * target, and reporting it as a broken site would be a false accusation
   * against the site owner, which is precisely the failure this tool exists to
   * prevent. A genuine site-side fault times out or is refused instead.
   */
  const vantageLacksIpv6 =
    v6.length > 0 &&
    v6.every((a) => !a.reachable && /ENETUNREACH|EAFNOSUPPORT/i.test(a.error ?? ''));

  if (vantageLacksIpv6) {
    out.push(
      finding({
        code: 'ipv6-absent',
        severity: 'info',
        owner: 'nobody',
        confidence: 'high',
        title: 'We could not test this site’s modern (IPv6) address',
        plain:
          'This site does publish an IPv6 address, but the machine running this check has no IPv6 connection, so there was nothing to test it from.',
        impact: 'None for you — this is a limit of our test, not a problem with the site.',
        technical: `All IPv6 connection attempts failed with ENETUNREACH/EAFNOSUPPORT, indicating no IPv6 route from this vantage point rather than an unresponsive target. Addresses: ${v6.map((a) => a.address).join(', ')}.`,
        remediation: {
          summary: 'Nothing to fix on the site’s side.',
          steps: [
            'To include IPv6 in future checks, run this tool on a host that has IPv6 connectivity.',
          ],
        },
      }),
    );
    return out;
  }

  if (
    v6.length > 0 &&
    v4.length > 0 &&
    v6.every((a) => !a.reachable) &&
    v4.some((a) => a.reachable)
  ) {
    out.push(
      finding({
        code: 'ipv6-broken',
        severity: 'critical',
        owner: 'site-owner',
        title: 'The site advertises a modern address that does not work',
        plain:
          'This site publishes an IPv6 address — the newer kind of internet address — but nothing answers on it. The older IPv4 address works fine.',
        impact:
          'Visitors on IPv6-first networks (most mobile networks) may hang for several seconds before falling back, or fail entirely. To everyone else the site looks perfectly healthy, which is why this often goes unnoticed for months.',
        technical: `AAAA records resolve to ${v6.map((a) => a.address).join(', ')} but every connection attempt failed. A records are reachable.`,
        evidence: v6.map((a) => ({
          label: `IPv6 ${a.address}`,
          value: a.error ?? 'unreachable',
        })),
        remediation: {
          summary: 'Either make IPv6 work, or stop advertising it.',
          steps: [
            'Confirm the server is actually listening on its IPv6 address, not just IPv4.',
            'Check firewall rules — IPv6 rules are frequently forgotten when IPv4 ones are set up.',
            'If IPv6 is not intended to be supported, remove the AAAA records so browsers stop trying.',
          ],
          expectedImprovement: 'Removes multi-second stalls for visitors on IPv6 networks.',
        },
      }),
    );
  }

  if (v6.length === 0 && v4.length > 0) {
    out.push(
      finding({
        code: 'ipv6-absent',
        severity: 'info',
        owner: 'site-owner',
        title: 'The site has no modern (IPv6) address',
        plain: 'This site is only reachable over the older style of internet address.',
        impact:
          'Visitors on IPv6-only networks reach the site through a translation layer, which adds a little delay. Most people are unaffected.',
        technical: 'No AAAA records published for this hostname.',
        remediation: {
          summary: 'Add IPv6 support when convenient.',
          steps: [
            'Most CDNs and hosts provide IPv6 by simply enabling it.',
            'Add AAAA records once the server is confirmed to answer on IPv6.',
          ],
        },
      }),
    );
  }

  const reachable = server.addresses.find((a) => a.reachable);
  const tcpBand = classify(reachable?.tcpConnectMs.value ?? null, THRESHOLDS.tcpMs);
  if (reachable && (tcpBand === 'degraded' || tcpBand === 'bad')) {
    const value = reachable.tcpConnectMs.value ?? 0;
    out.push(
      finding({
        code: 'tcp-slow',
        severity: tcpBand === 'bad' ? 'major' : 'minor',
        owner: 'nobody',
        title: 'The server is a long way away',
        plain: `Opening a connection to the server took ${ms(value)} before a single byte of the page was requested, which mostly reflects physical distance.`,
        impact:
          'Every visitor near us pays this delay on each new connection, and visitors further away pay more.',
        technical: `TCP connect to ${reachable.address} took ${ms(value)}. This is dominated by round-trip time and therefore by geography.`,
        evidence: [
          { label: 'Connect time', value: ms(value) },
          { label: 'Address', value: reachable.address },
          {
            label: 'Hosted by',
            value: server.network.asnName ?? 'unknown',
            provenance: server.network.asnName ? 'measured' : 'unavailable',
          },
        ],
        remediation: {
          summary: 'Put a CDN in front so visitors connect to something nearby.',
          steps: [
            'A CDN terminates connections close to each visitor instead of at the origin server.',
            'If most visitors are in one region, hosting the origin in that region helps on its own.',
          ],
          expectedImprovement: 'Usually cuts connection time to under 30 ms for most visitors.',
        },
      }),
    );
  }

  return out;
}

/** TLS: correctness problems first, then performance. */
export function detectTlsFindings(server: ServerEvidence): Finding[] {
  const out: Finding[] = [];
  const tls = server.tls;
  if (tls === null) return out;

  const cert = tls.certificate;

  if (cert !== null) {
    if (cert.daysUntilExpiry < 0) {
      out.push(
        finding({
          code: 'tls-cert-expired',
          severity: 'critical',
          owner: 'site-owner',
          title: 'The site’s security certificate has expired',
          plain: `The certificate that proves this site is genuine expired ${Math.abs(Math.round(cert.daysUntilExpiry))} days ago.`,
          impact:
            'Browsers show a full-page security warning and most visitors will turn back. For practical purposes the site is down.',
          technical: `Certificate expired ${cert.validTo}. Issuer: ${cert.issuer}.`,
          evidence: [
            { label: 'Expired on', value: cert.validTo },
            { label: 'Issuer', value: cert.issuer },
          ],
          remediation: {
            summary: 'Renew the certificate immediately, then automate it.',
            steps: [
              'Renew now — with Let’s Encrypt this is free and takes minutes.',
              'Set up automatic renewal (certbot, acme.sh, or whatever the host provides) so it cannot lapse again.',
              'Add an expiry monitor as a backstop.',
            ],
          },
        }),
      );
    } else if (cert.daysUntilExpiry <= CERT_EXPIRY.warning) {
      out.push(
        finding({
          code: 'tls-cert-expiring-soon',
          severity: cert.daysUntilExpiry <= CERT_EXPIRY.critical ? 'major' : 'minor',
          owner: 'site-owner',
          title: 'The security certificate expires soon',
          plain: `The certificate proving this site is genuine expires in ${Math.round(cert.daysUntilExpiry)} days.`,
          impact:
            'If it lapses, every visitor gets a full-page security warning and the site is effectively offline.',
          technical: `Certificate valid until ${cert.validTo}. Issuer: ${cert.issuer}.`,
          evidence: [
            { label: 'Expires', value: cert.validTo },
            { label: 'Days remaining', value: String(Math.round(cert.daysUntilExpiry)) },
          ],
          remediation: {
            summary: 'Renew now and make sure renewal is automatic.',
            steps: [
              'Renew ahead of time rather than waiting for the deadline.',
              'Confirm automatic renewal is actually running — silently broken renewal jobs are a common cause of outages.',
            ],
          },
        }),
      );
    }

    if (!cert.hostnameMatches) {
      out.push(
        finding({
          code: 'tls-cert-hostname-mismatch',
          severity: 'critical',
          owner: 'site-owner',
          title: 'The security certificate is for a different website',
          plain: `The certificate this site presents does not list "${server.target.host}" as one of its names.`,
          impact:
            'Browsers block the site with a security warning, because this is indistinguishable from an impersonation attempt.',
          technical: `Requested ${server.target.host}; certificate covers: ${cert.subjectAltNames.join(', ') || 'nothing listed'}.`,
          evidence: [
            { label: 'Requested host', value: server.target.host },
            { label: 'Certificate covers', value: cert.subjectAltNames.join(', ') || 'none' },
          ],
          remediation: {
            summary: 'Reissue the certificate covering this hostname.',
            steps: [
              'Include every hostname the site is served on, including the www and bare-domain forms.',
              'If a CDN or load balancer terminates TLS, the certificate needs fixing there rather than on the origin.',
            ],
          },
        }),
      );
    }

    if (cert.chainLength > THRESHOLDS.tlsChainLength) {
      out.push(
        finding({
          code: 'tls-long-chain',
          severity: 'minor',
          owner: 'site-owner',
          title: 'The security handshake sends more data than necessary',
          plain: `Proving the site's identity involves ${cert.chainLength} certificates, which all have to be sent before anything else can happen.`,
          impact:
            'Adds bytes and sometimes an extra round trip to every new connection, worst on slow mobile links.',
          technical: `Certificate chain depth is ${cert.chainLength}.`,
          evidence: [{ label: 'Chain length', value: String(cert.chainLength) }],
          remediation: {
            summary: 'Serve a shorter chain.',
            steps: [
              'Remove the root certificate from what the server sends — clients already have it.',
              'Prefer a certificate authority with a shorter path, and consider ECDSA certificates, which are substantially smaller than RSA.',
            ],
          },
        }),
      );
    }
  }

  if (tls.protocol !== null && OUTDATED_TLS_PROTOCOLS.includes(tls.protocol)) {
    out.push(
      finding({
        code: 'tls-outdated-protocol',
        severity: 'major',
        owner: 'site-owner',
        title: 'The site uses an outdated security standard',
        plain: `Connections are secured with ${tls.protocol}, which is obsolete and no longer considered safe.`,
        impact:
          'Modern browsers warn about or refuse these connections, and the handshake is slower than the current standard.',
        technical: `Negotiated ${tls.protocol}. TLS 1.2 is the minimum acceptable today; TLS 1.3 is faster and preferred.`,
        evidence: [{ label: 'Protocol', value: tls.protocol }],
        remediation: {
          summary: 'Enable TLS 1.3 and disable everything below TLS 1.2.',
          steps: [
            'Enable TLS 1.2 and 1.3 in the web server configuration.',
            'Disable SSLv3, TLS 1.0 and TLS 1.1 entirely.',
          ],
          snippet: {
            language: 'nginx',
            code: 'ssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers off;',
            caption: 'nginx',
          },
          expectedImprovement: 'TLS 1.3 also removes a full round trip from every new connection.',
        },
      }),
    );
  }

  const handshakeBand = classify(tls.handshakeMs.value, THRESHOLDS.tlsMs);
  if (tls.handshakeMs.value !== null && (handshakeBand === 'degraded' || handshakeBand === 'bad')) {
    out.push(
      finding({
        code: 'tls-handshake-slow',
        severity: handshakeBand === 'bad' ? 'major' : 'minor',
        owner: 'site-owner',
        title: 'Setting up the secure connection is slow',
        plain: `Establishing the encrypted connection took ${ms(tls.handshakeMs.value)}, before a single byte of the page was requested.`,
        impact: 'Every visitor pays this on their first connection.',
        technical: `TLS handshake took ${ms(tls.handshakeMs.value)} using ${tls.protocol ?? 'an unknown protocol'}${tls.cipher ? ` and ${tls.cipher}` : ''}.`,
        evidence: [
          { label: 'Handshake time', value: ms(tls.handshakeMs.value) },
          { label: 'Protocol', value: tls.protocol ?? 'unknown' },
          { label: 'Cipher', value: tls.cipher ?? 'unknown' },
        ],
        remediation: {
          summary: 'Use TLS 1.3, a shorter chain, and OCSP stapling.',
          steps: [
            'TLS 1.3 completes in one round trip instead of two.',
            'Enable OCSP stapling so clients need not make a separate request to check revocation.',
            'A CDN terminates TLS near the visitor, which helps more than any tuning.',
          ],
        },
      }),
    );
  }

  if (tls.resumptionSupported === false) {
    out.push(
      finding({
        code: 'tls-no-resumption',
        severity: 'minor',
        owner: 'site-owner',
        title: 'Returning visitors redo the full security handshake',
        plain:
          'The site does not let browsers resume a previous secure session, so every connection is negotiated from scratch.',
        impact:
          'Repeat visitors and additional connections pay the full handshake cost every time.',
        technical:
          'Session resumption via TLS session tickets was not offered on a second handshake.',
        remediation: {
          summary: 'Enable TLS session tickets or a session cache.',
          steps: [
            'Enable session resumption in the web server configuration.',
            'Where multiple servers sit behind a load balancer, share the ticket key so resumption works across all of them.',
          ],
          snippet: {
            language: 'nginx',
            code: 'ssl_session_cache shared:SSL:10m;\nssl_session_timeout 1d;\nssl_session_tickets on;',
            caption: 'nginx',
          },
        },
      }),
    );
  }

  if (tls.ocspStapled === false) {
    out.push(
      finding({
        code: 'tls-no-ocsp-stapling',
        severity: 'info',
        owner: 'site-owner',
        title: 'Browsers must check the certificate separately',
        plain:
          'The site does not include proof that its certificate is still valid, so some browsers make an extra request elsewhere to check.',
        impact: 'Adds an occasional extra delay on first connection.',
        technical: 'No stapled OCSP response was present in the TLS handshake.',
        remediation: {
          summary: 'Enable OCSP stapling.',
          steps: ['Turn on OCSP stapling in the web server configuration.'],
          snippet: {
            language: 'nginx',
            code: 'ssl_stapling on;\nssl_stapling_verify on;',
            caption: 'nginx',
          },
        },
      }),
    );
  }

  return out;
}

/** HTTP: the layer most site owners can actually change. */
export function detectHttpFindings(server: ServerEvidence): Finding[] {
  const out: Finding[] = [];
  const http = server.http;
  if (http === null) return out;

  if (http.status >= 400) {
    out.push(
      finding({
        code: 'http-error-status',
        severity: http.status >= 500 ? 'critical' : 'major',
        owner: 'site-owner',
        title: `The site returned an error (${http.status})`,
        plain:
          http.status >= 500
            ? 'The server tried to serve the page but something broke on its side.'
            : 'The server refused the request or could not find the page.',
        impact: 'Visitors see an error page instead of the site.',
        technical: `HTTP ${http.status} received for ${server.target.normalizedUrl}.`,
        evidence: [{ label: 'Status', value: String(http.status) }],
        remediation: {
          summary:
            http.status >= 500
              ? 'Check the server’s error logs.'
              : 'Check the address and access rules.',
          steps:
            http.status >= 500
              ? [
                  'Look at the application and web server error logs for the failing request.',
                  'Check that backing services such as the database are reachable.',
                ]
              : [
                  'Confirm the URL is correct.',
                  'Check access rules, firewalls, or bot protection that might be blocking automated requests.',
                ],
        },
      }),
    );
  }

  const ttfbBand = classify(http.ttfbMs.value, THRESHOLDS.ttfbMs);
  if (http.ttfbMs.value !== null && (ttfbBand === 'degraded' || ttfbBand === 'bad')) {
    out.push(
      finding({
        code: 'ttfb-slow',
        severity: ttfbBand === 'bad' ? 'critical' : 'major',
        owner: 'site-owner',
        title: 'The server takes a long time to start sending the page',
        plain: `After connecting, we waited ${ms(http.ttfbMs.value)} before the server sent anything at all. That is the server thinking, not the network.`,
        impact:
          'This delay happens before the browser can render or download anything, so it makes the whole site feel slow no matter how fast the visitor’s connection is.',
        technical: `Time to first byte was ${ms(http.ttfbMs.value)}, measured from a well-connected server after the connection was already established. This isolates server-side processing from network time.`,
        evidence: [
          { label: 'Time to first byte', value: ms(http.ttfbMs.value) },
          {
            label: 'Server’s own reported time',
            value: http.serverTiming ?? 'not reported',
            provenance: http.serverTiming ? 'measured' : 'unavailable',
          },
        ],
        remediation: {
          summary: 'Cache the response, or find what the backend is waiting on.',
          steps: [
            'Add full-page caching so repeat requests skip the application entirely — usually the single biggest win.',
            'Profile the slowest requests: unindexed database queries are the most common culprit.',
            'Check for slow calls to third-party APIs made while rendering the page.',
            'On serverless hosting, check whether cold starts are responsible.',
          ],
          expectedImprovement: 'Caching commonly brings this under 100 ms.',
        },
      }),
    );
  }

  if (http.redirects.length > THRESHOLDS.redirects.ok) {
    const severity = http.redirects.length > THRESHOLDS.redirects.degraded ? 'major' : 'minor';
    const totalMs = http.redirects.reduce((sum, r) => sum + (r.durationMs.value ?? 0), 0);
    out.push(
      finding({
        code: 'redirect-chain-long',
        severity,
        owner: 'site-owner',
        title: 'Visitors are bounced through several addresses first',
        plain: `Loading this page involves ${http.redirects.length} redirects before arriving at the real content, costing about ${ms(totalMs)}.`,
        impact: 'Every visitor pays this delay on arrival, and it is entirely avoidable.',
        technical: http.redirects
          .map((r) => `${r.status} ${r.url} → ${r.location ?? '?'}`)
          .join('\n'),
        evidence: http.redirects.map((r, i) => ({
          label: `Hop ${i + 1}`,
          value: `${r.status} → ${r.location ?? 'unknown'} (${ms(r.durationMs.value ?? 0)})`,
        })),
        remediation: {
          summary: 'Collapse the chain into a single redirect.',
          steps: [
            'Redirect straight to the final address in one step rather than chaining http → https → www → path.',
            'Link internally to the canonical address so visitors skip the redirect entirely.',
          ],
          expectedImprovement: `Would save roughly ${ms(Math.max(0, totalMs - (http.redirects[0]?.durationMs.value ?? 0)))}.`,
        },
      }),
    );
  }

  if (http.contentEncoding === null) {
    const bytes = http.transferredBytes.value;
    out.push(
      finding({
        code: 'no-compression',
        severity: bytes !== null && bytes > 100_000 ? 'major' : 'minor',
        owner: 'site-owner',
        title: 'The page is sent uncompressed',
        plain:
          'Text-based content compresses extremely well, but this site sends it as-is — so visitors download several times more data than they need to.',
        impact:
          'Pages take noticeably longer on mobile and slower connections, and visitors on metered plans pay for the extra data.',
        technical:
          'No Content-Encoding header was returned; the response was not gzip, brotli or zstd encoded.',
        evidence: [
          {
            label: 'Transferred',
            value: bytes !== null ? formatBytes(bytes) : 'unknown',
            provenance: bytes !== null ? 'measured' : 'unavailable',
          },
          { label: 'Compression', value: 'none' },
        ],
        remediation: {
          summary: 'Enable Brotli, with gzip as a fallback.',
          steps: [
            'Enable compression in the web server or CDN for text content — HTML, CSS, JavaScript, JSON and SVG.',
            'Leave already-compressed formats such as images and video alone; recompressing them wastes CPU for no gain.',
          ],
          snippet: {
            language: 'nginx',
            code: 'gzip on;\ngzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;\ngzip_min_length 1024;',
            caption: 'nginx',
          },
          expectedImprovement: 'Typically reduces text payloads by 60–80%.',
        },
      }),
    );
  }

  if (!http.httpVersion.startsWith('2') && !http.httpVersion.startsWith('3')) {
    out.push(
      finding({
        code: 'no-http2',
        severity: 'minor',
        owner: 'site-owner',
        title: 'The site uses an older, slower way of transferring pages',
        plain: `This site still serves content over HTTP/${http.httpVersion}, which handles only a few files at a time.`,
        impact:
          'Pages with many images, stylesheets or scripts load noticeably more slowly, because requests queue up instead of running together.',
        technical: `Negotiated HTTP/${http.httpVersion}. HTTP/2 multiplexes many requests over one connection and compresses headers.`,
        evidence: [{ label: 'Protocol', value: `HTTP/${http.httpVersion}` }],
        remediation: {
          summary: 'Enable HTTP/2.',
          steps: [
            'Nearly all modern web servers support HTTP/2 with a single configuration change, provided HTTPS is already in use.',
            'Putting a CDN in front enables it automatically.',
          ],
        },
      }),
    );
  }

  if (!http.http3Advertised && http.httpVersion.startsWith('2')) {
    out.push(
      finding({
        code: 'no-http3',
        severity: 'info',
        owner: 'site-owner',
        title: 'The newest transfer protocol is not offered',
        plain:
          'The site does not advertise HTTP/3, the newest protocol, which copes better with unreliable connections.',
        impact:
          'Visitors on mobile networks would see modestly faster, more resilient loading with it enabled.',
        technical: 'No Alt-Svc header advertising h3 was present.',
        remediation: {
          summary: 'Enable HTTP/3 if the server or CDN supports it.',
          steps: ['Most CDNs offer HTTP/3 as a toggle.'],
        },
      }),
    );
  }

  if (http.cacheControl === null) {
    out.push(
      finding({
        code: 'no-cache-headers',
        severity: 'minor',
        owner: 'site-owner',
        title: 'The site does not tell browsers what they may reuse',
        plain:
          'Without caching instructions, browsers re-download content they already have instead of reusing it.',
        impact: 'Repeat visits are slower and use more data than they need to.',
        technical: 'No Cache-Control header was present on the response.',
        remediation: {
          summary: 'Add Cache-Control headers.',
          steps: [
            'Serve static assets with a long max-age and immutable, using filenames that change when the content does.',
            'Serve HTML with a short max-age, or no-cache if it must always be fresh.',
          ],
          snippet: {
            language: 'http',
            code: 'Cache-Control: public, max-age=31536000, immutable',
            caption: 'For versioned static assets',
          },
        },
      }),
    );
  }

  const bytes = http.transferredBytes.value;
  if (bytes !== null && bytes > THRESHOLDS.payloadBytes.ok) {
    const bad = bytes > THRESHOLDS.payloadBytes.degraded;
    out.push(
      finding({
        code: 'payload-large',
        severity: bad ? 'major' : 'minor',
        owner: 'site-owner',
        title: 'The page is heavy',
        plain: `This page transfers ${formatBytes(bytes)}, which is a lot for a single document.`,
        impact:
          'On a typical mobile connection this alone adds seconds to the load, and costs visitors data.',
        technical: `Transferred ${formatBytes(bytes)}${http.uncompressedBytes.value !== null ? ` (${formatBytes(http.uncompressedBytes.value)} uncompressed)` : ''}.`,
        evidence: [{ label: 'Transferred', value: formatBytes(bytes) }],
        remediation: {
          summary: 'Reduce what is sent up front.',
          steps: [
            'Serve images in modern formats and size them for their display dimensions.',
            'Split JavaScript so only what the page needs is loaded immediately.',
            'Defer anything below the fold.',
          ],
        },
      }),
    );
  }

  return out;
}

/** Consistency over time — the signal a single request cannot show. */
export function detectStabilityFindings(server: ServerEvidence): Finding[] {
  const out: Finding[] = [];
  const stability = server.stability;
  if (stability === null) return out;

  const ratio = instabilityRatio(stability.ttfb);
  const band = classify(ratio, THRESHOLDS.instabilityRatio);

  if (ratio !== null && (band === 'degraded' || band === 'bad')) {
    out.push(
      finding({
        code: 'unstable-response-times',
        severity: band === 'bad' ? 'major' : 'minor',
        owner: 'site-owner',
        confidence: stability.ttfb.count >= 5 ? 'high' : 'medium',
        title: 'Response times are erratic',
        plain: `We asked for the same page ${stability.ttfb.count} times. The replies ranged from ${ms(stability.ttfb.min ?? 0)} to ${ms(stability.ttfb.max ?? 0)} — the site is inconsistent rather than uniformly slow.`,
        impact:
          'Some visitors get a fast page and others wait far longer, seemingly at random. This is also the pattern you would expect from a server under strain.',
        technical: `TTFB median ${ms(stability.ttfb.median ?? 0)}, p95 ${ms(stability.ttfb.p95 ?? 0)}, IQR ${ms(stability.ttfb.iqr ?? 0)} (${(ratio * 100).toFixed(0)}% of median).`,
        evidence: [
          { label: 'Fastest', value: ms(stability.ttfb.min ?? 0) },
          { label: 'Typical (median)', value: ms(stability.ttfb.median ?? 0) },
          { label: 'Slow requests (95th percentile)', value: ms(stability.ttfb.p95 ?? 0) },
          { label: 'Slowest', value: ms(stability.ttfb.max ?? 0) },
        ],
        remediation: {
          summary: 'Look for resource contention or an unhealthy server in the pool.',
          steps: [
            'Check whether CPU, memory or database connections are saturating at peak.',
            'If several servers sit behind a load balancer, check whether one of them is slower than the rest.',
            'Look for background jobs competing with request handling.',
          ],
        },
      }),
    );
  }

  const cold = stability.coldTtfbMs.value;
  const warm = stability.warmTtfbMs.value;
  if (
    cold !== null &&
    warm !== null &&
    cold > 0 &&
    warm / cold > 0.9 &&
    cold > THRESHOLDS.ttfbMs.ok
  ) {
    out.push(
      finding({
        code: 'no-cdn-caching-benefit',
        severity: 'minor',
        owner: 'site-owner',
        confidence: 'medium',
        title: 'Repeat requests are no faster than the first',
        plain: `The first request took ${ms(cold)} and later identical requests took about the same. Nothing is being cached.`,
        impact:
          'Every single request does the full amount of work, so the site cannot absorb traffic spikes.',
        technical: `Cold TTFB ${ms(cold)} vs warm TTFB ${ms(warm)} — effectively no caching benefit.`,
        evidence: [
          { label: 'First request', value: ms(cold) },
          { label: 'Later requests', value: ms(warm) },
        ],
        remediation: {
          summary: 'Add caching in front of the application.',
          steps: [
            'Enable full-page caching at the CDN or reverse proxy for pages that are the same for everyone.',
            'Verify cache headers actually permit caching — a no-store header silently defeats the entire layer.',
          ],
        },
      }),
    );
  }

  return out;
}
