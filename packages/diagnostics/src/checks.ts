import type {
  Check,
  CheckPhase,
  CheckStatus,
  ClientEvidence,
  DnsEvidence,
  Evidence,
  Finding,
  FindingCode,
  HttpEvidence,
  Provenance,
  ServerEvidence,
  StabilityEvidence,
  TlsEvidence,
} from '@dwc/contracts';
import { countryLabel } from './countries.js';
import { formatBytes, ms, plural } from './findings/helpers.js';
import { describeLocation, distanceCeilingKm, KM_PER_MS, MAX_TERRESTRIAL_KM } from './location.js';
import type { HostingLocation } from './location.js';
import { instabilityRatio, lossRatio } from './stats.js';
import {
  CERT_EXPIRY,
  LOCAL_CONTROL_RTT_MS,
  MIN_SAMPLES_FOR_VARIANCE,
  controlIsLoopback,
  OUTDATED_TLS_PROTOCOLS,
  THRESHOLDS,
  classify,
} from './thresholds.js';
import { assessNetworkPath } from './vantages.js';

/**
 * The complete record of what was examined — passes included.
 *
 * Findings only describe problems, which meant a healthy site offered almost
 * nothing to inspect: exactly backwards for a diagnostics tool. Checks close
 * that gap. They are observations rather than accusations, so they carry no
 * severity or owner; when a check warrants action it points at the finding that
 * makes the case.
 *
 * Everything here is derived from evidence the engine already holds. No new
 * probes, no I/O, and — like the rest of this package — no clock and no
 * randomness, so the same evidence always yields the same checks.
 */

interface CheckInput {
  id: string;
  phase: CheckPhase;
  title: string;
  status: CheckStatus;
  summary: string;
  headline?: string | null;
  technical: string;
  evidence?: { label: string; value: string; provenance?: Provenance }[];
  relatedFindings?: readonly FindingCode[];
}

function check(input: CheckInput): Check {
  return {
    id: input.id,
    phase: input.phase,
    title: input.title,
    status: input.status,
    summary: input.summary,
    headline: input.headline ?? null,
    technical: input.technical,
    evidence: (input.evidence ?? []).map((e) => ({
      label: e.label,
      value: e.value,
      provenance: e.provenance ?? 'measured',
    })),
    relatedFindings: [...(input.relatedFindings ?? [])],
  };
}

/** Maps a threshold band result onto a check status. */
function bandStatus(band: 'ok' | 'degraded' | 'bad' | 'unknown'): CheckStatus {
  switch (band) {
    case 'ok':
      return 'pass';
    case 'degraded':
      return 'warn';
    case 'bad':
      return 'fail';
    case 'unknown':
      return 'unavailable';
  }
}

export function buildChecks(evidence: Evidence, findings: readonly Finding[]): Check[] {
  const present = new Set(findings.map((f) => f.code));
  /** Only links findings that actually fired, so the UI never dangles. */
  const link = (...codes: FindingCode[]): FindingCode[] => codes.filter((c) => present.has(c));

  const { server, client } = evidence;

  return [
    ...dnsChecks(server.dns, link),
    ...connectivityChecks(server, link),
    ...tlsChecks(server.tls, server.target.scheme, link),
    ...httpChecks(server.http, link),
    ...stabilityChecks(server.stability, link),
    ...networkChecks(server, client, link),
    ...clientChecks(client, link),
    ...pathChecks(evidence, link),
  ];
}

type Link = (...codes: FindingCode[]) => FindingCode[];

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

function dnsChecks(dns: DnsEvidence, link: Link): Check[] {
  const checks: Check[] = [];
  const addresses = dns.records.filter((r) => r.type === 'A' || r.type === 'AAAA');

  checks.push(
    check({
      id: 'dns.resolution',
      phase: 'dns',
      title: 'Name resolution',
      status: addresses.length > 0 ? 'pass' : 'fail',
      headline:
        addresses.length > 0 ? plural(addresses.length, 'address', 'addresses') : 'No addresses',
      summary:
        addresses.length > 0
          ? 'The domain resolves to at least one usable address.'
          : 'The domain did not resolve to any address.',
      technical:
        addresses.length > 0
          ? `Resolved to ${addresses.map((r) => `${r.value} (${r.type})`).join(', ')}. A records carry IPv4 addresses, AAAA records IPv6. Both families are probed separately below, because a host with a broken AAAA record is unreachable for IPv6-first clients while working perfectly for everyone else.`
          : 'No A or AAAA records were returned. Either the domain does not exist, its zone is misconfigured, or every queried resolver returned NXDOMAIN or SERVFAIL. Nothing further can be measured without an address.',
      evidence: addresses.map((r) => ({
        label: `${r.type} record`,
        value: r.ttl === null ? r.value : `${r.value} (TTL ${String(r.ttl)}s)`,
      })),
      relatedFindings: link('dns-resolution-failed'),
    }),
  );

  const lookup = dns.lookupMs.value;
  checks.push(
    check({
      id: 'dns.lookup-time',
      phase: 'dns',
      title: 'Lookup time',
      status: bandStatus(classify(lookup, THRESHOLDS.dnsMs)),
      headline: lookup === null ? null : ms(lookup),
      summary:
        lookup === null
          ? 'Lookup duration could not be measured.'
          : `The name resolved in ${ms(lookup)}.`,
      technical: `DNS resolution happens before any connection can be opened, so it is pure added latency on a first visit. Measured against explicitly configured public resolvers rather than this host's own resolver — a local caching resolver would return in under a millisecond and tell you nothing about what a real visitor experiences. Healthy is under ${String(THRESHOLDS.dnsMs.ok)} ms; past ${String(THRESHOLDS.dnsMs.degraded)} ms it is a noticeable delay before anything at all begins.`,
      evidence: [
        {
          label: 'Lookup time',
          value: lookup === null ? 'not measured' : ms(lookup),
          provenance: dns.lookupMs.provenance,
        },
      ],
      relatedFindings: link('dns-slow'),
    }),
  );

  const failed = dns.resolvers.filter((r) => r.error !== null);
  checks.push(
    check({
      id: 'dns.resolver-agreement',
      phase: 'dns',
      title: 'Resolver agreement',
      status: dns.resolvers.length === 0 ? 'skipped' : dns.consistent ? 'pass' : 'warn',
      headline:
        dns.resolvers.length === 0
          ? null
          : dns.consistent
            ? `${String(dns.resolvers.length)} agree`
            : 'Disagreement',
      summary:
        dns.resolvers.length === 0
          ? 'Not run: no resolvers were configured.'
          : dns.consistent
            ? 'Every resolver returned the same addresses.'
            : 'Resolvers returned different addresses for this domain.',
      technical: dns.consistent
        ? `All ${String(dns.resolvers.length)} resolvers returned an identical address set, so the zone has propagated consistently and there is no split-horizon or stale-cache behaviour visible from the public internet.`
        : 'Different resolvers returned different addresses. This is normally one of three things: a recent DNS change still propagating, a stale negative cache, or deliberate geographic/split-horizon answers. While it persists, different visitors reach different servers — which makes "it works for me" reports genuinely unreliable, and is a failure mode almost nothing else surfaces.',
      evidence: dns.resolvers.map((r) => ({
        label: `${r.resolverName} (${r.resolver})`,
        value: r.error !== null ? `error: ${r.error}` : r.addresses.join(', ') || 'no answer',
        provenance: r.error !== null ? ('unavailable' as const) : ('measured' as const),
      })),
      relatedFindings: link('dns-resolver-disagreement'),
    }),
  );

  const auth = dns.authoritative;
  const authTimes = auth.map((a) => a.durationMs.value).filter((v): v is number => v !== null);
  const slowestAuth = authTimes.length > 0 ? Math.max(...authTimes) : null;
  checks.push(
    check({
      id: 'dns.authoritative',
      phase: 'dns',
      title: 'Authoritative nameservers',
      status:
        auth.length === 0 ? 'unavailable' : bandStatus(classify(slowestAuth, THRESHOLDS.dnsMs)),
      headline: slowestAuth === null ? null : `${ms(slowestAuth)} slowest`,
      summary:
        auth.length === 0
          ? 'The domain’s own nameservers could not be timed.'
          : `${plural(auth.length, 'nameserver')} answered, slowest in ${slowestAuth === null ? 'an unmeasured time' : ms(slowestAuth)}.`,
      technical:
        auth.length === 0
          ? 'No NS records were resolvable, or every authoritative server refused a direct query. Public resolvers may still answer from cache, which masks the problem until a cache expires.'
          : `Queried the domain’s own nameservers directly, bypassing recursive caches. This is the timing a resolver pays on a cache miss, and it is what governs first-visit latency for visitors whose resolver has not seen the domain recently. Slow authoritative servers are invisible in a normal lookup because a warm cache hides them.`,
      evidence: auth.map((a) => ({
        label: a.nameserver,
        value:
          a.error !== null
            ? `error: ${a.error}`
            : a.durationMs.value === null
              ? 'not measured'
              : ms(a.durationMs.value),
        provenance: a.error !== null ? ('unavailable' as const) : a.durationMs.provenance,
      })),
      relatedFindings: link('dns-authoritative-slow'),
    }),
  );

  checks.push(
    check({
      id: 'dns.cname-chain',
      phase: 'dns',
      title: 'CNAME chain',
      status: dns.cnameChainLength <= THRESHOLDS.cnameChainLength ? 'pass' : 'warn',
      headline: plural(dns.cnameChainLength, 'hop'),
      summary:
        dns.cnameChainLength === 0
          ? 'The name points straight at an address, with no aliases.'
          : `${plural(dns.cnameChainLength, 'alias hop')} before an address is reached.`,
      technical: `Each CNAME is an alias that must itself be resolved before an address is known. Chains commonly build up when a CDN fronts another CDN, or a vanity domain points at a platform hostname that points somewhere else again. A resolver may need a separate round trip per hop on a cold cache, so ${String(THRESHOLDS.cnameChainLength)} hops is the point at which the aliasing itself becomes a measurable cost rather than an implementation detail.`,
      evidence: [{ label: 'Chain length', value: plural(dns.cnameChainLength, 'hop') }],
      relatedFindings: link('dns-long-cname-chain'),
    }),
  );

  checks.push(
    check({
      id: 'dns.ttl',
      phase: 'dns',
      title: 'Record lifetime (TTL)',
      status:
        dns.minTtlSeconds === null
          ? 'unavailable'
          : dns.minTtlSeconds >= THRESHOLDS.minTtlSeconds
            ? 'pass'
            : 'warn',
      headline: dns.minTtlSeconds === null ? null : `${String(dns.minTtlSeconds)}s`,
      summary:
        dns.minTtlSeconds === null
          ? 'No TTL was reported for the records.'
          : `Records may be cached for ${String(dns.minTtlSeconds)} seconds.`,
      technical: `TTL is how long a resolver may cache an answer. This is read from the domain’s configured value rather than the remainder left on a recursive resolver's cached copy — reading the remainder produced spurious "very low TTL" warnings on perfectly normal domains, because a record 55 seconds into a 300-second TTL reports 245. Below ${String(THRESHOLDS.minTtlSeconds)}s, visitors re-resolve constantly and pay lookup latency repeatedly; very low values are sometimes deliberate ahead of a planned migration, which is why this is a warning rather than a fault.`,
      evidence: [
        {
          label: 'Lowest TTL',
          value: dns.minTtlSeconds === null ? 'not reported' : `${String(dns.minTtlSeconds)}s`,
          provenance: dns.minTtlSeconds === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('dns-low-ttl'),
    }),
  );

  checks.push(
    check({
      id: 'dns.dnssec',
      phase: 'dns',
      title: 'DNSSEC',
      status: dns.dnssec === null ? 'unavailable' : dns.dnssec ? 'pass' : 'warn',
      headline: dns.dnssec === null ? null : dns.dnssec ? 'Signed' : 'Not signed',
      summary:
        dns.dnssec === null
          ? 'Could not determine whether the zone is signed.'
          : dns.dnssec
            ? 'The zone is DNSSEC-signed.'
            : 'The zone is not DNSSEC-signed.',
      technical:
        dns.dnssec === true
          ? 'The zone publishes DNSSEC records, so a validating resolver can cryptographically verify that answers have not been tampered with in transit. Validation adds a little resolution work but closes off cache-poisoning and on-path answer forgery.'
          : 'No DNSSEC signing was detected. Answers for this domain cannot be cryptographically verified, so a resolver has no way to detect a forged response. This has no effect on speed and is a security posture note rather than a performance problem — it is never the headline verdict.',
      evidence: [
        {
          label: 'DNSSEC',
          value: dns.dnssec === null ? 'undetermined' : dns.dnssec ? 'signed' : 'unsigned',
          provenance: dns.dnssec === null ? 'unavailable' : 'measured',
        },
      ],
    }),
  );

  if (failed.length > 0) {
    checks.push(
      check({
        id: 'dns.resolver-errors',
        phase: 'dns',
        title: 'Resolver errors',
        status: 'warn',
        headline: `${String(failed.length)} of ${String(dns.resolvers.length)} failed`,
        summary: `${plural(failed.length, 'resolver')} returned an error.`,
        technical:
          'At least one public resolver failed to answer. A single failure is usually that resolver being rate-limited or briefly unreachable from our vantage rather than anything about the domain. Several failures together, especially with the same error, point at the zone itself.',
        evidence: failed.map((r) => ({
          label: r.resolverName,
          value: r.error ?? 'unknown error',
          provenance: 'unavailable' as const,
        })),
      }),
    );
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Connectivity — IPv4 and IPv6 assessed separately, on purpose
// ---------------------------------------------------------------------------

function connectivityChecks(server: ServerEvidence, link: Link): Check[] {
  const checks: Check[] = [];

  for (const family of [4, 6] as const) {
    const addrs = server.addresses.filter((a) => a.family === family);
    const label = family === 4 ? 'IPv4' : 'IPv6';
    const reachable = addrs.filter((a) => a.reachable);
    const times = reachable.map((a) => a.tcpConnectMs.value).filter((v): v is number => v !== null);
    const best = times.length > 0 ? Math.min(...times) : null;

    // No address of this family is "nothing to test", not a failure. An IPv4-only
    // site is entirely normal and must not be reported as broken IPv6.
    if (addrs.length === 0) {
      checks.push(
        check({
          id: `connectivity.ipv${String(family)}`,
          phase: 'connectivity',
          title: `${label} connection`,
          status: 'skipped',
          summary: `Not run: the domain publishes no ${label} address.`,
          technical:
            family === 6
              ? 'No AAAA record exists, so there is nothing to connect to over IPv6. This is common and not itself a fault: IPv6-only clients reach the site through their provider’s translation layer. It does mean IPv6 visitors get no direct path.'
              : 'No A record exists. An IPv6-only origin is unusual and unreachable for the significant share of clients that still have no IPv6 path at all.',
          relatedFindings: link('ipv6-absent'),
        }),
      );
      continue;
    }

    checks.push(
      check({
        id: `connectivity.ipv${String(family)}`,
        phase: 'connectivity',
        title: `${label} connection`,
        status: reachable.length === 0 ? 'fail' : bandStatus(classify(best, THRESHOLDS.tcpMs)),
        headline: best === null ? 'Unreachable' : ms(best),
        summary:
          reachable.length === 0
            ? `No ${label} address accepted a connection.`
            : `Connected over ${label} in ${best === null ? 'an unmeasured time' : ms(best)}.`,
        technical:
          reachable.length === 0
            ? `Every ${label} address refused the connection or timed out. Note carefully what this does and does not prove: measured from one vantage, an ENETUNREACH here can equally mean this host has no ${label} route of its own. That distinction matters enough that it is reported as an observation rather than an accusation against the site.`
            : `TCP connect time is dominated by physical distance and routing rather than anything the application does — roughly ${String(THRESHOLDS.tcpMs.ok)} ms is intercontinental. Each address is probed independently rather than letting the OS choose, because a host whose ${label} is slow or dead while the other family is healthy is the single most common cause of "it's slow, but only for some people".`,
        evidence: addrs.map((a) => ({
          label: a.address,
          value: a.reachable
            ? a.tcpConnectMs.value === null
              ? 'connected'
              : ms(a.tcpConnectMs.value)
            : `unreachable${a.error === null ? '' : `: ${a.error}`}`,
          provenance: a.reachable ? a.tcpConnectMs.provenance : ('unavailable' as const),
        })),
        relatedFindings:
          family === 6 ? link('ipv6-broken', 'tcp-slow') : link('tcp-slow', 'connection-refused'),
      }),
    );
  }

  return checks;
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

function tlsChecks(tls: TlsEvidence | null, scheme: string, link: Link): Check[] {
  if (tls === null) {
    return [
      check({
        id: 'tls.handshake',
        phase: 'tls',
        title: 'Secure connection',
        status: scheme === 'http' ? 'skipped' : 'unavailable',
        summary:
          scheme === 'http'
            ? 'Not run: the address was requested over plain HTTP.'
            : 'The secure connection could not be established.',
        technical:
          scheme === 'http'
            ? 'No TLS handshake was attempted because the target was addressed over http://. Everything on this connection travels in clear text and can be read or modified by anything on the path.'
            : 'TLS was expected but no handshake completed, so no certificate, protocol or cipher information is available.',
        relatedFindings: link('redirect-to-https-missing'),
      }),
    ];
  }

  const checks: Check[] = [];
  const hs = tls.handshakeMs.value;

  checks.push(
    check({
      id: 'tls.handshake',
      phase: 'tls',
      title: 'Handshake time',
      status: tls.error !== null ? 'fail' : bandStatus(classify(hs, THRESHOLDS.tlsMs)),
      headline: hs === null ? null : ms(hs),
      summary:
        tls.error !== null
          ? `The handshake failed: ${tls.error}`
          : `The secure connection was negotiated in ${hs === null ? 'an unmeasured time' : ms(hs)}.`,
      technical: `The TLS handshake sits on top of TCP and costs at least one further round trip (TLS 1.3) or two (TLS 1.2) before any request can be sent. It is inflated by an oversized certificate chain, a distant origin, or an expensive key exchange. Healthy is under ${String(THRESHOLDS.tlsMs.ok)} ms on top of the TCP connect.`,
      evidence: [
        {
          label: 'Handshake',
          value: hs === null ? 'not measured' : ms(hs),
          provenance: tls.handshakeMs.provenance,
        },
      ],
      relatedFindings: link('tls-handshake-slow'),
    }),
  );

  const outdated = tls.protocol !== null && OUTDATED_TLS_PROTOCOLS.includes(tls.protocol);
  checks.push(
    check({
      id: 'tls.protocol',
      phase: 'tls',
      title: 'Protocol version',
      status: tls.protocol === null ? 'unavailable' : outdated ? 'fail' : 'pass',
      headline: tls.protocol,
      summary:
        tls.protocol === null
          ? 'The negotiated protocol version could not be read.'
          : outdated
            ? `${tls.protocol} is outdated and should be disabled.`
            : `Negotiated ${tls.protocol}.`,
      technical:
        tls.protocol === 'TLSv1.3'
          ? 'TLS 1.3 completes the handshake in a single round trip, removes the legacy cipher suites entirely, and encrypts more of the handshake itself. This is the current best case and there is nothing to improve here.'
          : outdated
            ? `${tls.protocol ?? 'This version'} is deprecated. Browsers already warn or refuse outright, and it lacks forward-secrecy guarantees that modern versions make mandatory. Note this value is read before the socket is torn down — reading it afterwards returns null, which previously made every site appear to have an unknown TLS version.`
            : `${tls.protocol ?? 'The negotiated version'} is acceptable but not current. TLS 1.3 would save a full round trip on every new connection.`,
      evidence: [
        {
          label: 'Protocol',
          value: tls.protocol ?? 'not readable',
          provenance: tls.protocol === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Cipher suite',
          value: tls.cipher ?? 'not readable',
          provenance: tls.cipher === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Key exchange',
          value: tls.keyExchange ?? 'not reported',
          provenance: tls.keyExchange === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('tls-outdated-protocol'),
    }),
  );

  const cert = tls.certificate;
  if (cert === null) {
    checks.push(
      check({
        id: 'tls.certificate',
        phase: 'tls',
        title: 'Certificate',
        status: 'unavailable',
        summary: 'No certificate could be read from the connection.',
        technical:
          'The handshake did not reach the point where a certificate is presented, so validity, hostname coverage and expiry are all unknown.',
      }),
    );
  } else {
    const expiryStatus: CheckStatus =
      cert.daysUntilExpiry <= 0
        ? 'fail'
        : cert.daysUntilExpiry <= CERT_EXPIRY.critical
          ? 'fail'
          : cert.daysUntilExpiry <= CERT_EXPIRY.warning
            ? 'warn'
            : 'pass';
    const valid = cert.hostnameMatches && !cert.selfSigned && cert.daysUntilExpiry > 0;

    checks.push(
      check({
        id: 'tls.certificate',
        phase: 'tls',
        title: 'Certificate validity',
        status: valid ? expiryStatus : 'fail',
        headline:
          cert.daysUntilExpiry <= 0
            ? 'Expired'
            : `${String(Math.floor(cert.daysUntilExpiry))} days left`,
        summary: !cert.hostnameMatches
          ? 'The certificate does not cover this hostname.'
          : cert.selfSigned
            ? 'The certificate is self-signed.'
            : cert.daysUntilExpiry <= 0
              ? 'The certificate has expired.'
              : `Valid, expiring in ${String(Math.floor(cert.daysUntilExpiry))} days.`,
        technical: `Issued by ${cert.issuer} to ${cert.subject}, valid ${cert.validFrom} to ${cert.validTo}. Hostname coverage is checked against the subject alternative names, with single-level wildcard matching — a certificate for *.example.com covers a.example.com but deliberately not a.b.example.com, matching how browsers behave. ${cert.selfSigned ? 'This certificate is self-signed, so no public trust store will accept it and every visitor sees a full-page interstitial warning.' : 'The chain terminates in a publicly trusted root.'} Certificates are inspected with verification disabled on purpose: a bad certificate is a finding to report, not a reason to refuse to look.`,
        evidence: [
          { label: 'Subject', value: cert.subject },
          { label: 'Issuer', value: cert.issuer },
          { label: 'Valid from', value: cert.validFrom },
          { label: 'Valid to', value: cert.validTo },
          { label: 'Days remaining', value: String(Math.floor(cert.daysUntilExpiry)) },
          { label: 'Covers this hostname', value: cert.hostnameMatches ? 'yes' : 'no' },
          { label: 'Self-signed', value: cert.selfSigned ? 'yes' : 'no' },
          {
            label: 'Subject alternative names',
            value: cert.subjectAltNames.join(', ') || 'none listed',
          },
        ],
        relatedFindings: link(
          'tls-cert-expired',
          'tls-cert-expiring-soon',
          'tls-cert-hostname-mismatch',
          'tls-cert-self-signed',
        ),
      }),
    );

    checks.push(
      check({
        id: 'tls.chain',
        phase: 'tls',
        title: 'Certificate chain',
        status: cert.chainLength <= THRESHOLDS.tlsChainLength ? 'pass' : 'warn',
        headline: plural(cert.chainLength, 'certificate'),
        summary: `The server presented a chain ${plural(cert.chainLength, 'certificate')} deep.`,
        technical: `Every certificate in the chain is sent on every new connection, before any application data. Each one is roughly 1–2 KB, which lands in the slow-start window where bytes are most expensive. Beyond ${String(THRESHOLDS.tlsChainLength)} certificates the chain is usually carrying a cross-signed root that could simply be omitted, since clients already trust the root from their own store.`,
        evidence: [{ label: 'Chain depth', value: String(cert.chainLength) }],
        relatedFindings: link('tls-long-chain'),
      }),
    );
  }

  checks.push(
    check({
      id: 'tls.ocsp',
      phase: 'tls',
      title: 'OCSP stapling',
      status: tls.ocspStapled === null ? 'unavailable' : tls.ocspStapled ? 'pass' : 'warn',
      headline: tls.ocspStapled === null ? null : tls.ocspStapled ? 'Stapled' : 'Not stapled',
      summary:
        tls.ocspStapled === null
          ? 'Stapling could not be determined.'
          : tls.ocspStapled
            ? 'The server stapled a revocation response.'
            : 'The server did not staple a revocation response.',
      technical: tls.ocspStapled
        ? 'The server included a signed, time-stamped proof that its certificate is not revoked. The client can check revocation without contacting the certificate authority, saving a separate DNS lookup and HTTP request during page load.'
        : 'No stapled response was seen. Clients that check revocation must reach the certificate authority themselves — an extra lookup and request on the critical path, and one that fails awkwardly when the CA is slow. Requesting a status response must be asked for in the ClientHello, which we do; a server may also legitimately staple only intermittently.',
      evidence: [
        {
          label: 'OCSP stapling',
          value: tls.ocspStapled === null ? 'undetermined' : tls.ocspStapled ? 'present' : 'absent',
          provenance: tls.ocspStapled === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('tls-no-ocsp-stapling'),
    }),
  );

  const resumed = tls.resumedHandshakeMs.value;
  checks.push(
    check({
      id: 'tls.resumption',
      phase: 'tls',
      title: 'Session resumption',
      status:
        tls.resumptionSupported === null
          ? 'unavailable'
          : tls.resumptionSupported
            ? 'pass'
            : 'warn',
      headline:
        tls.resumptionSupported === null
          ? null
          : tls.resumptionSupported && resumed !== null && hs !== null
            ? `${ms(hs - resumed)} saved`
            : tls.resumptionSupported
              ? 'Supported'
              : 'Not observed',
      summary:
        tls.resumptionSupported === null
          ? 'Could not determine whether sessions can be resumed.'
          : tls.resumptionSupported
            ? 'A second connection successfully reused the session.'
            : 'A second connection did not reuse the session.',
      technical: `Resumption lets a returning visitor skip most of the handshake. Measured by performing a second full handshake with the ticket from the first and asking the socket whether the session was actually reused — inferring it from configuration would be guesswork.

There is a subtlety worth knowing: under TLS 1.3 the session ticket arrives *after* the handshake completes, so reading the session immediately on secureConnect yields a short pre-ticket blob that cannot resume. Doing that made every TLS 1.3 site appear to have resumption disabled, which is a false accusation against the site owner. We wait for the ticket instead. Where resumption cannot be demonstrated the result is reported as unknown rather than unsupported, because some servers only issue a ticket after application data.`,
      evidence: [
        {
          label: 'First handshake',
          value: hs === null ? 'not measured' : ms(hs),
          provenance: tls.handshakeMs.provenance,
        },
        {
          label: 'Resumed handshake',
          value: resumed === null ? 'not measured' : ms(resumed),
          provenance: tls.resumedHandshakeMs.provenance,
        },
        {
          label: 'Session reused',
          value:
            tls.resumptionSupported === null
              ? 'undetermined'
              : tls.resumptionSupported
                ? 'yes'
                : 'no',
          provenance: tls.resumptionSupported === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('tls-no-resumption'),
    }),
  );

  checks.push(
    check({
      id: 'tls.alpn',
      phase: 'tls',
      title: 'Protocol negotiation (ALPN)',
      status: tls.alpn === null ? 'unavailable' : 'pass',
      headline: tls.alpn,
      summary:
        tls.alpn === null
          ? 'No application protocol was negotiated during the handshake.'
          : `Negotiated ${tls.alpn} during the handshake.`,
      technical:
        tls.alpn === null
          ? 'The server did not select an application protocol via ALPN, so the connection falls back to HTTP/1.1 after the handshake. This is how HTTP/2 support is actually determined — an Upgrade header is not used over TLS.'
          : `ALPN carries the protocol choice inside the TLS handshake, so no extra round trip is spent negotiating it afterwards. "${tls.alpn}" means ${tls.alpn === 'h2' ? 'HTTP/2 is in use, with multiplexing and header compression' : 'HTTP/1.1 is in use, so requests queue per connection'}.`,
      evidence: [
        {
          label: 'ALPN',
          value: tls.alpn ?? 'none negotiated',
          provenance: tls.alpn === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('no-http2'),
    }),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function httpChecks(http: HttpEvidence | null, link: Link): Check[] {
  if (http === null) {
    return [
      check({
        id: 'http.response',
        phase: 'http',
        title: 'HTTP response',
        status: 'unavailable',
        summary: 'No HTTP response was received.',
        technical:
          'The connection never reached the point of returning a response, so status, timing, headers and payload are all unknown.',
        relatedFindings: link('unreachable', 'connection-timeout'),
      }),
    ];
  }

  const checks: Check[] = [];
  const ok = http.status >= 200 && http.status < 400;

  checks.push(
    check({
      id: 'http.status',
      phase: 'http',
      title: 'Response status',
      status: ok ? 'pass' : 'fail',
      headline: String(http.status),
      summary: ok
        ? `The server returned ${String(http.status)}.`
        : `The server returned ${String(http.status)}, an error.`,
      technical: ok
        ? `HTTP ${String(http.status)} indicates the request was handled. Everything measured below describes a genuine, successful response rather than an error page — worth stating, because error pages are often much faster than real ones and can flatter a broken site.`
        : `HTTP ${String(http.status)} is an error. ${http.status >= 500 ? 'A 5xx means the server failed to handle a request it accepted — an application fault, an overloaded backend, or a failing dependency.' : 'A 4xx means the request was rejected as invalid, unauthorised or missing.'} Timings for an error response say little about the site's real performance.`,
      evidence: [
        { label: 'Status', value: String(http.status) },
        { label: 'HTTP version', value: http.httpVersion },
      ],
      relatedFindings: link('http-error-status'),
    }),
  );

  const ttfb = http.ttfbMs.value;
  checks.push(
    check({
      id: 'http.ttfb',
      phase: 'http',
      title: 'Time to first byte',
      status: bandStatus(classify(ttfb, THRESHOLDS.ttfbMs)),
      headline: ttfb === null ? null : ms(ttfb),
      summary:
        ttfb === null
          ? 'First-byte time could not be measured.'
          : `The first byte arrived ${ms(ttfb)} after the request was sent.`,
      technical: `Time to first byte is the strongest single signal that a problem is the site's own backend rather than the network, because DNS, TCP and TLS have all completed before the clock starts. What remains is the server thinking: template rendering, database queries, upstream API calls, or a cold serverless start. Measured from a well-connected vantage, so a high value here is slow for everyone rather than slow for one visitor. Healthy is under ${String(THRESHOLDS.ttfbMs.ok)} ms; past ${String(THRESHOLDS.ttfbMs.degraded)} ms the delay is plainly perceptible.`,
      evidence: [
        {
          label: 'Time to first byte',
          value: ttfb === null ? 'not measured' : ms(ttfb),
          provenance: http.ttfbMs.provenance,
        },
        {
          label: 'Download time',
          value: http.downloadMs.value === null ? 'not measured' : ms(http.downloadMs.value),
          provenance: http.downloadMs.provenance,
        },
        {
          label: 'Total time',
          value: http.totalMs.value === null ? 'not measured' : ms(http.totalMs.value),
          provenance: http.totalMs.provenance,
        },
        {
          label: 'Server-Timing header',
          value: http.serverTiming ?? 'not sent',
          provenance: http.serverTiming === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('ttfb-slow'),
    }),
  );

  checks.push(
    check({
      id: 'http.version',
      phase: 'http',
      title: 'HTTP version',
      status:
        http.httpVersion.startsWith('2') || http.httpVersion.startsWith('3') ? 'pass' : 'warn',
      headline: `HTTP/${http.httpVersion.replace(/^HTTP\//i, '')}`,
      summary: `The response was served over HTTP/${http.httpVersion.replace(/^HTTP\//i, '')}.`,
      technical: http.httpVersion.startsWith('1')
        ? 'HTTP/1.1 handles one request at a time per connection, so browsers open several connections and each pays its own TCP and TLS setup. HTTP/2 multiplexes every request over one connection and compresses headers, which matters most on pages with many small assets.'
        : 'HTTP/2 or later multiplexes all requests over a single connection with header compression, so additional assets cost no extra connection setup.',
      evidence: [
        { label: 'Negotiated version', value: http.httpVersion },
        { label: 'HTTP/3 advertised', value: http.http3Advertised ? 'yes (Alt-Svc)' : 'no' },
      ],
      relatedFindings: link('no-http2'),
    }),
  );

  checks.push(
    check({
      id: 'http.http3',
      phase: 'http',
      title: 'HTTP/3 availability',
      status: http.http3Advertised ? 'pass' : 'warn',
      headline: http.http3Advertised ? 'Advertised' : 'Not advertised',
      summary: http.http3Advertised
        ? 'The server advertises HTTP/3 for subsequent connections.'
        : 'The server does not advertise HTTP/3.',
      technical:
        'Detected from the Alt-Svc response header rather than by speaking QUIC ourselves, which is why this reports advertisement rather than confirmed support. HTTP/3 runs over QUIC on UDP, combining transport and cryptographic setup into a single round trip and removing head-of-line blocking at the transport layer. The benefit is largest on lossy mobile networks.',
      evidence: [
        {
          label: 'Alt-Svc',
          value: http.headers['alt-svc'] ?? 'not sent',
          provenance: http.headers['alt-svc'] === undefined ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('no-http3'),
    }),
  );

  const hops = http.redirects.length;
  checks.push(
    check({
      id: 'http.redirects',
      phase: 'http',
      title: 'Redirects',
      status:
        hops <= THRESHOLDS.redirects.ok ? 'pass' : bandStatus(classify(hops, THRESHOLDS.redirects)),
      headline: hops === 0 ? 'None' : plural(hops, 'hop'),
      summary:
        hops === 0
          ? 'The address served the page directly.'
          : `${plural(hops, 'redirect')} before the real page.`,
      technical:
        hops === 0
          ? 'No redirects. The requested URL is the final one, so nothing is spent arriving at it.'
          : `Each redirect is a complete round trip — and for a cross-origin hop, a fresh DNS lookup, TCP connect and TLS handshake as well. Chains accumulate almost invisibly: http→https, then apex→www, then a locale prefix, each added by a different person at a different time. Every visitor pays the whole chain on a first visit. Redirects are followed manually here, one hop at a time, with each hop's address re-validated before connecting.`,
      evidence: http.redirects.map((r) => ({
        label: `${String(r.status)} → ${r.location ?? 'no location'}`,
        value: r.durationMs.value === null ? r.url : `${r.url} (${ms(r.durationMs.value)})`,
        provenance: r.durationMs.provenance,
      })),
      relatedFindings: link('redirect-chain-long', 'redirect-to-https-missing'),
    }),
  );

  const encoded = http.contentEncoding !== null;
  checks.push(
    check({
      id: 'http.compression',
      phase: 'http',
      title: 'Compression',
      status: encoded ? 'pass' : 'warn',
      headline: http.contentEncoding ?? 'None',
      summary: encoded
        ? `The response was compressed with ${http.contentEncoding}.`
        : 'The response was sent uncompressed.',
      technical: encoded
        ? `Content-Encoding was ${http.contentEncoding}. Text compresses extremely well — typically 70–80% for HTML, CSS and JavaScript — so this is usually the single largest easy saving on a page. Brotli generally beats gzip by a further 15–20% on text at equivalent CPU cost.`
        : 'No Content-Encoding was applied even though compression was offered in the request. Every visitor downloads the full uncompressed payload, which on a text-heavy page is often three to four times more data than necessary. This is normally a one-line change in the server or CDN configuration and affects every response.',
      evidence: [
        {
          label: 'Content-Encoding',
          value: http.contentEncoding ?? 'none',
          provenance: encoded ? 'measured' : 'unavailable',
        },
        {
          label: 'Transferred',
          value:
            http.transferredBytes.value === null
              ? 'not measured'
              : formatBytes(http.transferredBytes.value),
          provenance: http.transferredBytes.provenance,
        },
        {
          label: 'Uncompressed',
          value:
            http.uncompressedBytes.value === null
              ? 'not measured'
              : formatBytes(http.uncompressedBytes.value),
          provenance: http.uncompressedBytes.provenance,
        },
        {
          label: 'Compression ratio',
          value:
            http.compressionRatio.value === null
              ? 'not measured'
              : `${(http.compressionRatio.value * 100).toFixed(0)}% of original`,
          provenance: http.compressionRatio.provenance,
        },
      ],
      relatedFindings: link('no-compression'),
    }),
  );

  checks.push(
    check({
      id: 'http.caching',
      phase: 'http',
      title: 'Cache headers',
      status: http.cacheControl === null ? 'warn' : 'pass',
      headline: http.cacheControl === null ? 'None' : 'Present',
      summary:
        http.cacheControl === null
          ? 'No Cache-Control header was sent.'
          : `Cache-Control: ${http.cacheControl}`,
      technical:
        http.cacheControl === null
          ? 'Without Cache-Control, caching behaviour is left to heuristics that differ between browsers and proxies. Repeat visitors may re-download unchanged resources, and intermediate caches and CDNs cannot safely store the response at all — so the origin serves traffic it should never see.'
          : `Cache-Control governs both browser and intermediate caches. The response also ${http.headers['etag'] === undefined ? 'carries no ETag' : `carries an ETag (${http.headers['etag']})`}, which is what allows a conditional request to be answered with an empty 304 instead of the whole body.`,
      evidence: [
        {
          label: 'Cache-Control',
          value: http.cacheControl ?? 'not sent',
          provenance: http.cacheControl === null ? 'unavailable' : 'measured',
        },
        {
          label: 'ETag',
          value: http.headers['etag'] ?? 'not sent',
          provenance: http.headers['etag'] === undefined ? 'unavailable' : 'measured',
        },
        {
          label: 'Last-Modified',
          value: http.headers['last-modified'] ?? 'not sent',
          provenance: http.headers['last-modified'] === undefined ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('no-cache-headers'),
    }),
  );

  const bytes = http.transferredBytes.value;
  checks.push(
    check({
      id: 'http.payload',
      phase: 'http',
      title: 'Page weight',
      status: bandStatus(classify(bytes, THRESHOLDS.payloadBytes)),
      headline: bytes === null ? null : formatBytes(bytes),
      summary:
        bytes === null
          ? 'Payload size could not be measured.'
          : `The document transferred ${formatBytes(bytes)}.`,
      technical: `This is the HTML document alone, not the whole page — sub-resources are not fetched, so a real page load is heavier than this figure. Response bodies are read up to a hard cap, so an enormous document is truncated rather than allowed to exhaust memory. Past ${formatBytes(THRESHOLDS.payloadBytes.ok)} for a single document, there is usually server-rendered content that could be paginated, deferred, or streamed.`,
      evidence: [
        {
          label: 'Transferred',
          value: bytes === null ? 'not measured' : formatBytes(bytes),
          provenance: http.transferredBytes.provenance,
        },
      ],
      relatedFindings: link('payload-large'),
    }),
  );

  checks.push(
    check({
      id: 'http.security-headers',
      phase: 'http',
      title: 'Security headers',
      status: http.hsts && http.contentSecurityPolicy ? 'pass' : 'warn',
      headline: `${String([http.hsts, http.contentSecurityPolicy].filter(Boolean).length)} of 2`,
      summary: `HSTS ${http.hsts ? 'present' : 'absent'}, Content-Security-Policy ${http.contentSecurityPolicy ? 'present' : 'absent'}.`,
      technical:
        'Reported for completeness and never used as the headline verdict, because neither header affects speed. HSTS (Strict-Transport-Security) tells browsers to use HTTPS for this host in future, closing the window where a first plain-HTTP request can be intercepted. Content-Security-Policy restricts which sources may execute or load, which is the main structural defence against cross-site scripting.',
      evidence: [
        {
          label: 'Strict-Transport-Security',
          value: http.headers['strict-transport-security'] ?? 'not sent',
          provenance: http.hsts ? 'measured' : 'unavailable',
        },
        {
          label: 'Content-Security-Policy',
          value: http.contentSecurityPolicy ? 'present' : 'not sent',
          provenance: http.contentSecurityPolicy ? 'measured' : 'unavailable',
        },
        {
          label: 'Timing-Allow-Origin',
          value: http.timingAllowOrigin
            ? 'present — browsers may read detailed timing'
            : 'not sent — cross-origin timing is redacted',
          provenance: http.timingAllowOrigin ? 'measured' : 'unavailable',
        },
      ],
      relatedFindings: link('no-hsts', 'no-csp'),
    }),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

function stabilityChecks(stability: StabilityEvidence | null, link: Link): Check[] {
  if (stability === null) {
    return [
      check({
        id: 'stability.variance',
        phase: 'stability',
        title: 'Response consistency',
        status: 'skipped',
        summary: 'Not run: repeated sampling did not complete.',
        technical:
          'Consistency needs several samples. Without them a single timing stands alone, and one unlucky response is indistinguishable from a genuine pattern.',
      }),
    ];
  }

  const checks: Check[] = [];
  const s = stability.ttfb;
  const ratio = instabilityRatio(s);
  const enoughSamples = s.count >= MIN_SAMPLES_FOR_VARIANCE;

  checks.push(
    check({
      id: 'stability.variance',
      phase: 'stability',
      title: 'Response consistency',
      status: !enoughSamples
        ? 'unavailable'
        : bandStatus(classify(ratio, THRESHOLDS.instabilityRatio)),
      headline: s.median === null ? null : `${ms(s.median)} median`,
      summary: !enoughSamples
        ? `Only ${plural(s.count, 'sample')} — too few to judge consistency.`
        : ratio !== null && ratio <= THRESHOLDS.instabilityRatio.ok
          ? 'Response times were consistent across samples.'
          : 'Response times varied noticeably between samples.',
      technical: `Median and interquartile range are used rather than mean and standard deviation, because network latency is heavily right-skewed — one garbage-collection pause or TCP retransmit drags a mean somewhere misleading while the median stays honest.

Instability is scored as IQR ÷ median so it is scale-free: 50 ms of spread means something very different on a 40 ms response than on a 4000 ms one. At least ${String(MIN_SAMPLES_FOR_VARIANCE)} samples are required before variance may influence the verdict. Below that it is noise, and treating it as signal once produced the self-contradicting verdict "slow to respond (63 ms)" beside a health score of 96.`,
      evidence: [
        { label: 'Samples', value: String(s.count) },
        { label: 'Failed', value: String(s.failed) },
        { label: 'Minimum', value: s.min === null ? 'n/a' : ms(s.min) },
        { label: 'Median', value: s.median === null ? 'n/a' : ms(s.median) },
        { label: '95th percentile', value: s.p95 === null ? 'n/a' : ms(s.p95) },
        { label: 'Maximum', value: s.max === null ? 'n/a' : ms(s.max) },
        { label: 'Interquartile range', value: s.iqr === null ? 'n/a' : ms(s.iqr) },
        {
          label: 'Instability (IQR ÷ median)',
          value: ratio === null ? 'n/a' : ratio.toFixed(2),
          provenance: 'inferred',
        },
      ],
      relatedFindings: link('unstable-response-times'),
    }),
  );

  const cold = stability.coldTtfbMs.value;
  const warm = stability.warmTtfbMs.value;
  const benefit = cold !== null && warm !== null ? cold - warm : null;
  checks.push(
    check({
      id: 'stability.caching-benefit',
      phase: 'stability',
      title: 'Caching benefit',
      status: benefit === null ? 'unavailable' : benefit > 0 ? 'pass' : 'warn',
      headline: benefit === null ? null : benefit > 0 ? `${ms(benefit)} faster warm` : 'No gain',
      summary:
        benefit === null
          ? 'Cold and warm responses could not be compared.'
          : benefit > 0
            ? `Later requests were ${ms(benefit)} faster than the first.`
            : 'Later requests were no faster than the first.',
      technical:
        benefit !== null && benefit > 0
          ? `The first request cost ${cold === null ? 'an unmeasured time' : ms(cold)} and subsequent ones ${warm === null ? 'an unmeasured time' : ms(warm)}. That gap is a cache or CDN doing real work — the response is being served from somewhere closer or cheaper the second time.`
          : 'The first request was no slower than later ones. Usually this means no caching layer is in front of the origin, so every visitor pays full generation cost. It can also mean the page is genuinely uncacheable, or that the cache was already warm before we started, so this is reported as an observation rather than a fault.',
      evidence: [
        {
          label: 'Cold (first request)',
          value: cold === null ? 'not measured' : ms(cold),
          provenance: stability.coldTtfbMs.provenance,
        },
        {
          label: 'Warm (later requests)',
          value: warm === null ? 'not measured' : ms(warm),
          provenance: stability.warmTtfbMs.provenance,
        },
      ],
      relatedFindings: link('no-cdn-caching-benefit'),
    }),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Network identity
// ---------------------------------------------------------------------------

function networkChecks(server: ServerEvidence, client: ClientEvidence | null, link: Link): Check[] {
  const n = server.network;
  const certCountry = server.tls?.certificate?.subjectCountry ?? null;
  const location = describeLocation({
    network: n,
    addresses: server.addresses,
    http: server.http,
    certCountry,
  });

  return [
    check({
      id: 'network.ownership',
      phase: 'network',
      title: 'Network ownership',
      status: n.asn === null ? 'unavailable' : 'pass',
      // n.asn already carries its "AS" prefix. Adding another produced
      // "ASAS13335" in the report for as long as this check has existed.
      headline: n.asn,
      summary:
        n.asn === null
          ? 'The hosting network could not be identified.'
          : `Hosted on ${n.asnName ?? n.asn}${n.country === null ? '' : ` (${n.country})`}.`,
      technical:
        n.asn === null
          ? 'No autonomous system could be resolved for this address. The lookup uses Team Cymru’s free DNS-based service, which needs no key or account; a failure here is usually that service being unreachable rather than anything about the target.'
          : `Every address on the internet belongs to an autonomous system — a network under one administrative authority. Knowing the operator distinguishes "the origin is far away" from "the origin is behind a CDN with a nearby edge", which changes who owns a latency problem entirely. Resolved via Team Cymru’s DNS-based service: free, keyless, and requiring no account.`,
      evidence: [
        {
          label: 'ASN',
          value: n.asn ?? 'not identified',
          provenance: n.asn === null ? 'unavailable' : 'measured',
        },
        // Provenance is stated on every row rather than left to the default.
        // These once defaulted to 'measured', so an unresolved lookup rendered
        // the literal word "unknown" wearing a measured badge.
        {
          label: 'Operator',
          value: n.asnName ?? 'unknown',
          provenance: n.asnName === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Prefix',
          value: n.prefix ?? 'unknown',
          provenance: n.prefix === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Prefix registered in',
          value: countryLabel(n.country) ?? 'unknown',
          provenance: n.country === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Operator registered in',
          value: countryLabel(n.asnCountry) ?? 'unknown',
          provenance: n.asnCountry === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Registry',
          value: n.registry ?? 'unknown',
          provenance: n.registry === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('origin-geographically-distant'),
    }),

    locationCheck(location, link),
    reverseDnsCheck(server, location),
    certificateIdentityCheck(server),
    distanceCheck(server, client, location),

    check({
      id: 'network.cdn',
      phase: 'network',
      title: 'CDN',
      status: n.cdnDetected === null ? 'warn' : 'pass',
      headline: n.cdnDetected ?? 'None detected',
      summary:
        n.cdnDetected === null
          ? 'No content delivery network was detected.'
          : `Served via ${n.cdnDetected}.`,
      technical:
        n.cdnDetected === null
          ? 'The hosting network does not match any known CDN. Visitors are likely reaching the origin directly, so everyone far from it pays the full round-trip distance on every connection. A CDN in front would terminate TLS close to the visitor and often serve cached responses without touching the origin at all. Detection is by ASN against a bundled mapping, so a self-hosted or less common CDN may simply not be recognised.'
          : `The address belongs to ${n.cdnDetected}, so connections terminate at an edge location near the visitor rather than at the origin. This is why TCP and TLS timings can look excellent even when the origin itself is far away — and why a slow first byte from behind a CDN points at the origin or an uncacheable response rather than at distance.`,
      evidence: [
        {
          label: 'CDN',
          value: n.cdnDetected ?? 'not detected',
          provenance: n.cdnDetected === null ? 'unavailable' : 'inferred',
        },
      ],
      relatedFindings: link('no-cdn'),
    }),
  ];
}

/**
 * The consolidated answer to "where is this served from", and the refusal of the
 * question people actually tend to mean.
 *
 * The refusal is load-bearing. Somebody checking a supplier's site wants to know
 * where their customers' data sits, and a country name printed beside a hostname
 * will be read as answering that whether or not it was meant to. It does not. A
 * probe sees the machine that answered a request; where a business stores,
 * processes or backs up data is a contractual arrangement, and nothing on the
 * wire reveals it.
 */
function locationCheck(location: HostingLocation, link: Link): Check {
  const { pops, regions, countries, claims, behindEdge } = location;
  const best = pops.find((p) => p.short !== null) ?? null;
  const region = regions[0] ?? null;
  const nothing = claims.length === 0;

  const headline =
    best?.place ??
    region?.place ??
    (countries.length === 1 ? countryLabel(countries[0] ?? null) : null);

  const summary = nothing
    ? 'Nothing we can see says where this is served from.'
    : behindEdge
      ? `Served from an edge${best === null ? '' : ` in ${best.place ?? best.code}`}, not from the origin.`
      : countries.length > 1
        ? `The available records disagree: ${countries.join(', ')}.`
        : `Records point to ${headline ?? 'a network we could not place'}.`;

  const limits =
    'None of this establishes data residency. It describes the infrastructure that answered, not where a business keeps its records — an edge in one country routinely fronts an origin in a second holding a database in a third, and all three are ordinary. Treat it as a starting point for a question you then ask the operator, never as an answer to it.';

  const technical = nothing
    ? `No routing registry entry, edge header, reverse-DNS name or certificate field said anything about location. ${limits}`
    : behindEdge
      ? `Connections terminate at a content delivery network, so what is described here is the edge that answered — usually the one nearest our probe — and not the origin. The origin's location is not visible from outside, by design: that is what the network is for. Registry records still describe where the address block is registered, which for an anycast prefix is an administrative fact rather than a geographic one. ${limits}`
      : `Assembled from independent records: which country the routing registry says the address block and its operator are registered in, any edge location the response headers named, any cloud region embedded in reverse DNS, and the certificate subject when it carries one. They are listed rather than reconciled, because where they differ that is itself the answer. ${limits}`;

  return check({
    id: 'network.location',
    phase: 'network',
    title: 'Where it is served from',
    // Never a fault. Being hosted somewhere is not a problem, and a warn badge
    // beside a country reads as an accusation about that country.
    status: nothing ? 'unavailable' : 'pass',
    /*
     * Compact deliberately: this sits on a collapsed row beside a title and a
     * chevron, and the full form is in the evidence directly below it.
     *
     * Behind a CDN with no edge header to read, this is deliberately empty. It
     * used to fall through to the registry country, which put "United States"
     * on the same line as a summary saying the origin was not visible from here
     * — two statements that cannot both be what the reader takes away.
     */
    headline: behindEdge ? (best === null ? null : `edge in ${best.short ?? best.code}`) : headline,
    summary,
    technical,
    evidence: [
      ...pops.map((pop) => ({
        label: `Edge location (${pop.source})`,
        value: pop.place === null ? `${pop.code} — code not in our table` : pop.place,
        provenance: 'inferred' as const,
      })),
      ...regions.map((r) => ({
        label: 'Cloud region (reverse DNS)',
        value: `${r.token} — ${r.place}`,
        provenance: 'inferred' as const,
      })),
      ...claims.map((claim) => ({
        // Short enough for a narrow evidence table, and still traceable: the
        // source is what lets a reader check an inference rather than take it.
        label: `Country — ${claim.source}`,
        value: claim.label,
        provenance: 'inferred' as const,
      })),
      {
        label: 'Countries claimed in total',
        value: countries.length === 0 ? 'none' : countries.join(', '),
        provenance: countries.length === 0 ? ('unavailable' as const) : ('inferred' as const),
      },
    ],
    relatedFindings: link('origin-geographically-distant'),
  });
}

/**
 * Reverse DNS, shown whole.
 *
 * Providers name these after the facility — `jnb51`, `af-south-1`, `drmrs` — and
 * it is often the only public statement about where a machine physically sits.
 * The whole name is printed rather than the fragment we managed to parse,
 * because a reader who recognises their own provider's convention gets more out
 * of it than any table of ours would.
 */
function reverseDnsCheck(server: ServerEvidence, location: HostingLocation): Check {
  const { reverseNames } = location;
  const answered = server.addresses.filter((a) => a.reachable);

  const status: CheckStatus =
    answered.length === 0 ? 'skipped' : reverseNames.length === 0 ? 'unavailable' : 'pass';

  return check({
    id: 'network.reverse-dns',
    phase: 'network',
    title: 'Reverse DNS',
    status,
    headline: reverseNames[0]?.ptr ?? null,
    summary:
      answered.length === 0
        ? 'Not run: no address answered, so there was nothing to look up.'
        : reverseNames.length === 0
          ? 'No address published a reverse-DNS name.'
          : `Named as ${reverseNames[0]?.ptr ?? ''}.`,
    technical:
      answered.length === 0
        ? 'Not run: reverse DNS is looked up per reachable address, and none of them accepted a connection.'
        : reverseNames.length === 0
          ? 'The addresses have no PTR record, which is common and means nothing on its own. Large CDNs frequently publish none at all, and plenty of hosts simply never set one up.'
          : 'A PTR record maps an address back to a name. Hosting providers conventionally encode the facility in it — an airport code, a cloud region, an internal site abbreviation — which makes it one of the few public clues about where a machine physically is. It is a naming convention and not a record of location: a provider is free to put anything there, and nothing verifies it.',
    evidence:
      reverseNames.length === 0
        ? [{ label: 'PTR records', value: 'none published', provenance: 'unavailable' as const }]
        : reverseNames.map((entry) => ({
            label: entry.address,
            value: entry.ptr,
            provenance: 'measured' as const,
          })),
  });
}

/**
 * What the certificate claims about who runs the site.
 *
 * Almost always skipped, and that is the honest outcome rather than a gap. A
 * domain-validated certificate proves control of a hostname and deliberately
 * asserts nothing about the organisation behind it, so there is no identity to
 * read — which is different from having looked and found nothing.
 */
function certificateIdentityCheck(server: ServerEvidence): Check {
  const cert = server.tls?.certificate ?? null;
  const org = cert?.subjectOrg ?? null;
  const country = cert?.subjectCountry ?? null;
  const claims = org !== null || country !== null;

  return check({
    id: 'network.certificate-identity',
    phase: 'network',
    title: 'Certificate identity',
    status: cert === null ? 'skipped' : claims ? 'pass' : 'skipped',
    headline: org ?? countryLabel(country),
    summary:
      cert === null
        ? 'Not run: this site was not reached over HTTPS.'
        : claims
          ? `The certificate names ${org ?? countryLabel(country) ?? 'an organisation'}.`
          : 'Not run: the certificate is domain-validated and carries no organisation details.',
    technical:
      cert === null
        ? 'Not run: there is no certificate to read on a plain HTTP connection.'
        : claims
          ? 'Organisation- and extended-validation certificates carry the subject organisation and country, which a certificate authority checked against company records before issuing. That makes it a verified claim about the operator — though about the legal entity, not about where any particular server or database sits.'
          : 'Not run: this is a domain-validated certificate. It proves control of the hostname and asserts nothing about who or where the operator is, so there are no identity fields to read. Most certificates on the web are of this kind, so their absence says nothing about the site.',
    evidence: [
      {
        label: 'Organisation',
        value: org ?? 'not claimed',
        provenance: org === null ? ('unavailable' as const) : ('measured' as const),
      },
      {
        label: 'Country',
        value: countryLabel(country) ?? 'not claimed',
        provenance: country === null ? ('unavailable' as const) : ('measured' as const),
      },
      {
        label: 'Issuer country',
        value: countryLabel(cert?.issuerCountry ?? null) ?? 'unknown',
        provenance:
          (cert?.issuerCountry ?? null) === null ? ('unavailable' as const) : ('measured' as const),
      },
    ],
  });
}

/**
 * How far away the answering machine can possibly be.
 *
 * The only measured location signal in this whole phase, and the only one that
 * can contradict a record rather than repeat one. Everything else here is
 * somebody's assertion — a registry entry, a header, a naming convention. This is
 * arithmetic on a number we timed ourselves.
 *
 * It gives a ceiling and never a position. Both vantages are reported separately
 * because they are bounds from two different places, and the browser's is the one
 * the reader can actually reason about: they know where they were sitting.
 */
function distanceCheck(
  server: ServerEvidence,
  client: ClientEvidence | null,
  location: HostingLocation,
): Check {
  const completed = server.addresses
    .map((a) => a.tcpConnectMs.value)
    .filter((v): v is number => v !== null);
  const fastest = completed.length === 0 ? null : Math.min(...completed);
  const serverKm = fastest === null ? null : distanceCeilingKm(fastest);

  const browserRtt = client?.target.median ?? null;
  const browserKm = browserRtt === null ? null : distanceCeilingKm(browserRtt);

  const km = (value: number): string => `${value.toLocaleString('en-GB')} km`;
  const bounded = serverKm !== null || browserKm !== null;
  const measuredAnything = fastest !== null || browserRtt !== null;

  /*
   * Three outcomes, and they are genuinely different facts:
   *   nothing measured   — no round trip completed, so there is nothing to work from
   *   measured, no bound — the reply was slower than a signal needs to cross the
   *                        planet, so the ceiling excludes nowhere
   *   measured, bounded  — a real constraint
   * Collapsing the middle one into either neighbour would be a small lie.
   */
  const status: CheckStatus = !measuredAnything ? 'unavailable' : bounded ? 'pass' : 'unavailable';

  const nearest = browserKm ?? serverKm;
  const vantage = browserKm !== null ? 'you' : 'this instance';

  return check({
    id: 'network.distance',
    phase: 'network',
    title: 'Distance ceiling',
    status,
    headline: nearest === null ? null : `within ${km(nearest)}`,
    summary: !measuredAnything
      ? 'No round trip completed, so distance could not be bounded.'
      : bounded
        ? `Whatever answered is within ${km(nearest ?? 0)} of ${vantage}.`
        : 'The reply was too slow to rule anywhere out.',
    technical: `Light travels about 200 km through fibre every millisecond, and a round trip covers the distance twice — so a reply in ${ms(1)} puts the far end no further than ${km(KM_PER_MS)} away. Every real path bends, queues and waits at the far end, and all of that only adds time, so the true distance is always less than the figure here.\n\nThat one-sidedness is what makes it worth having: it can rule a location out, and it can never rule one in. A prefix registered in one country answering sooner than the speed of light allows from there is being served from somewhere else — ordinarily a content delivery network doing its job${location.behindEdge ? ', as it is here' : ''}. Beyond about ${km(MAX_TERRESTRIAL_KM)} the bound excludes nowhere on Earth and is reported as no constraint rather than as a number. The bound from our own server means something only to somebody who knows where this instance runs; the one from the browser is measured from wherever the reader was sitting.`,
    evidence: [
      {
        label: 'From your browser',
        value:
          browserRtt === null
            ? 'not measured'
            : browserKm === null
              ? 'no constraint — too slow to exclude anywhere'
              : km(browserKm),
        provenance: browserKm === null ? ('unavailable' as const) : ('inferred' as const),
      },
      {
        label: 'From this instance',
        value:
          fastest === null
            ? 'not measured'
            : serverKm === null
              ? 'no constraint — too slow to exclude anywhere'
              : km(serverKm),
        provenance: serverKm === null ? ('unavailable' as const) : ('inferred' as const),
      },
      {
        label: 'Fastest round trip from this instance',
        value: fastest === null ? 'none completed' : ms(fastest),
        provenance: fastest === null ? ('unavailable' as const) : ('measured' as const),
      },
      {
        label: 'Round trip from your browser',
        value: browserRtt === null ? 'not measured' : ms(browserRtt),
        provenance: browserRtt === null ? ('unavailable' as const) : ('measured' as const),
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Client — only meaningful when the browser actually contributed evidence
// ---------------------------------------------------------------------------

/**
 * The route between the reader and the site.
 *
 * This phase existed in the verdict but nowhere in the checks, so a report could
 * say "not enough data to judge the route" with nothing anywhere explaining what
 * was missing or why. A vantage that can be reported as unknown has to be able to
 * account for itself.
 *
 * Nothing here is directly instrumented. The browser can time the target only
 * coarsely — the request is cross-origin and opaque, so there are no sub-phase
 * timings to read — and the excess is arithmetic on top of that. Both are marked
 * accordingly rather than presented as observations.
 */
function pathChecks(evidence: Evidence, link: Link): Check[] {
  const { server, client } = evidence;

  if (client === null) {
    return [
      check({
        id: 'path.target-latency',
        phase: 'path',
        title: 'The route to the site',
        status: 'skipped',
        summary: 'Not run: the route can only be timed from a browser.',
        technical:
          'Judging the route needs three numbers: how long the site takes to answer us, how long your connection takes to reach a known endpoint, and how long your browser takes to reach the site. Only the first was available here, so the route was not assessed at all rather than guessed at.',
      }),
    ];
  }

  const checks: Check[] = [];
  const target = client.target.median;
  const attempts = client.target.count + client.target.failed;

  checks.push(
    check({
      id: 'path.target-latency',
      phase: 'path',
      title: 'Time for your browser to reach the site',
      status: target === null ? 'unavailable' : 'pass',
      headline: target === null ? null : ms(target),
      summary:
        target === null
          ? `Ran, but every one of the ${plural(attempts, 'attempt')} failed, so the route could not be timed.`
          : `Your browser reached the site in ${ms(target)}.`,
      technical:
        target === null
          ? 'The browser could not complete a request to the site. Mixed content (an https page requesting http, or the reverse), a certificate the browser rejects, or an origin refusing the request will all produce this, and none of them are distinguishable from here: the response is opaque by design.'
          : `Measured in the browser with a cross-origin request in no-cors mode. The response is opaque — no status, no headers, no sub-phase timings — so this is one wall-clock figure covering DNS, connection, TLS and the first byte together. It is deliberately coarse, and it is compared against, never reported as, a precise measurement.`,
      evidence: [
        { label: 'Attempts', value: String(attempts) },
        {
          label: 'Median',
          value: target === null ? 'not measured' : ms(target),
          provenance: target === null ? 'unavailable' : 'measured',
        },
        { label: 'Failed', value: String(client.target.failed) },
        { label: 'Measured by', value: 'your browser' },
      ],
    }),
  );

  const path = assessNetworkPath(evidence);

  /*
   * A loopback round trip is not a statement about anyone's internet.
   *
   * `clientChecks` has guarded this figure since the WebKit incident, with a
   * comment saying exactly that — and this check, one section away, printed the
   * same number raw. On a laptop it read "Your round trip: 2 ms" wearing a
   * measured badge, directly beneath a summary explaining that nothing could be
   * judged because the tool was running on the reader's own machine.
   *
   * That is the Phase 1 bug verbatim: a loopback figure presented as the
   * reader's connection. The number is only theirs if something across the
   * internet produced it.
   */
  const controlIsMeaningful = !controlIsLoopback(client);
  const controlRtt = controlIsMeaningful ? client.control.median : null;

  checks.push(
    check({
      id: 'path.excess',
      phase: 'path',
      title: 'Time the route cannot account for',
      status:
        path.status === 'unknown'
          ? 'unavailable'
          : bandStatus(path.status === 'ok' ? 'ok' : path.status),
      headline: path.excessMs === null ? null : ms(path.excessMs),
      summary: path.summary,
      technical:
        path.excessMs === null
          ? "Not derivable. This needs your round trip to the control endpoint, the site's own response time, and your browser's time to reach the site. With any one missing there is nothing to subtract, and an estimate assembled from the rest would be invention rather than inference."
          : `Derived, not observed. Your browser's time to reach the site, minus what the site's own response time and your connection's round trip already explain. What is left over is the route: peering, a long way round, or the absence of an edge near you.

This is inferred and is reported as such throughout, which is also why confidence for a route verdict is capped below the level a directly measured one can reach.`,
      evidence: [
        {
          label: 'Unexplained excess',
          value: path.excessMs === null ? 'not derivable' : ms(path.excessMs),
          provenance: path.excessMs === null ? 'unavailable' : 'inferred',
        },
        {
          label: 'Your round trip',
          value:
            controlRtt === null
              ? controlIsMeaningful
                ? 'not measured'
                : 'not measured — the control endpoint is on this machine'
              : ms(controlRtt),
          provenance: controlRtt === null ? 'unavailable' : 'measured',
        },
        {
          label: 'Site response time',
          value: server.http?.ttfbMs.value == null ? 'not measured' : ms(server.http.ttfbMs.value),
          provenance: server.http?.ttfbMs.value == null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('path-degraded'),
    }),
  );

  return checks;
}

function clientChecks(client: ClientEvidence | null, link: Link): Check[] {
  if (client === null) {
    return [
      check({
        id: 'client.latency',
        phase: 'client',
        title: 'Your connection',
        status: 'skipped',
        summary: 'Not run: no measurements were taken from your browser.',
        technical:
          'Without browser-side measurements there is no baseline for your own connection, so this report can describe the site only. It deliberately cannot conclude anything about your connection or the path — blaming something that was never measured is the one thing this tool must never do.',
      }),
    ];
  }

  const checks: Check[] = [];
  const rtt = client.control.median;

  /**
   * A loopback round trip is not a statement about anyone's internet.
   *
   * The default deployment is self-hosted and often local, so the control
   * endpoint answers in 1–5ms over loopback and looks flawless no matter how bad
   * the real link is. Reporting that as a healthy connection is a lie by omission.
   */
  const loopback = controlIsLoopback(client);

  /*
   * The throughput test fetches from the page's own origin, never from the
   * control endpoint — so it is loopback whenever the app itself is local,
   * regardless of where CONTROL_URL points.
   */
  const loopbackTransfer = client.appIsLocal === true;

  checks.push(
    check({
      id: 'client.latency',
      phase: 'client',
      title: 'Your connection latency',
      status: loopback ? 'unavailable' : bandStatus(classify(rtt, THRESHOLDS.clientRttMs)),
      headline: loopback || rtt === null ? null : ms(rtt),
      summary: loopback
        ? 'Not measurable: this tool is running on your own machine.'
        : rtt === null
          ? 'Round-trip time could not be measured.'
          : `Round trip to our test endpoint took ${ms(rtt)}.`,
      technical: loopback
        ? `The round trip completed in under ${ms(LOCAL_CONTROL_RTT_MS)}, which is faster than any real internet path. The control endpoint is therefore on this machine or LAN, and the measurement describes a loopback interface rather than your internet connection.

This is reported as not measurable rather than healthy on purpose. Treating it as healthy meant every genuine round trip looked like unexplained excess, and the engine confidently blamed the reader's provider for latency it had never measured.`
        : `Latency to our own endpoint, independent of the site being tested. This is the load-bearing measurement in the whole report: without a baseline for your connection there is no way to separate "that site is slow" from "your connection is slow", and any tool claiming to do so without one is guessing. Healthy is under ${String(THRESHOLDS.clientRttMs.ok)} ms.`,
      /*
       * Every figure here describes the control round trip, so every one of them
       * is meaningless over loopback — not just the median.
       *
       * The median was guarded and the 95th percentile beside it was not, so a
       * local install printed a loopback percentile wearing a measured badge. The
       * guard has to cover the whole set or it covers nothing.
       */
      evidence: [
        { label: 'Samples', value: String(client.control.count) },
        {
          label: 'Median',
          value: loopback || rtt === null ? 'not measured' : ms(rtt),
          provenance: loopback || rtt === null ? 'unavailable' : 'measured',
        },
        {
          label: '95th percentile',
          value: loopback || client.control.p95 === null ? 'not measured' : ms(client.control.p95),
          provenance: loopback || client.control.p95 === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('client-high-latency'),
    }),
  );

  const jitter = client.control.jitter;
  checks.push(
    check({
      id: 'client.jitter',
      phase: 'client',
      title: 'Connection steadiness',
      status: loopback ? 'unavailable' : bandStatus(classify(jitter, THRESHOLDS.clientJitterMs)),
      headline: loopback || jitter === null ? null : ms(jitter),
      summary: loopback
        ? 'Not measurable over a local connection.'
        : jitter === null
          ? 'Jitter could not be measured.'
          : `Consecutive round trips varied by ${ms(jitter)} on average.`,
      technical:
        'Jitter is the mean absolute difference between consecutive round trips — variation as a person actually experiences it, rather than a standard deviation about a mean. It is what makes calls break up and video rebuffer even when average speed looks fine, and on Wi-Fi it is usually interference or contention rather than the line itself.',
      evidence: [
        {
          label: 'Jitter',
          value: loopback || jitter === null ? 'not measured' : ms(jitter),
          provenance: loopback || jitter === null ? 'unavailable' : 'measured',
        },
      ],
      relatedFindings: link('client-high-jitter'),
    }),
  );

  const loss = lossRatio(client.control);
  checks.push(
    check({
      id: 'client.loss',
      phase: 'client',
      title: 'Dropped requests',
      status: loopback ? 'unavailable' : bandStatus(classify(loss, THRESHOLDS.clientLossRatio)),
      headline: loss === null ? null : `${(loss * 100).toFixed(1)}%`,
      summary:
        loss === null
          ? 'Loss could not be assessed.'
          : `${String(client.control.failed)} of ${String(client.control.count)} probes failed.`,
      technical:
        'A proxy for packet loss, not a direct measurement: a browser cannot observe packets, so this counts probes that timed out or errored. Even a small percentage is disproportionately damaging, because TCP treats loss as congestion and backs off — a 2% loss rate can halve throughput.',
      evidence: [
        { label: 'Probes sent', value: String(client.control.count) },
        { label: 'Failed', value: String(client.control.failed) },
        {
          label: 'Failure rate',
          value: loss === null ? 'n/a' : `${(loss * 100).toFixed(1)}%`,
          provenance: 'inferred',
        },
      ],
      relatedFindings: link('client-packet-loss'),
    }),
  );

  const tp = client.throughput;
  checks.push(
    check({
      id: 'client.throughput',
      phase: 'client',
      title: 'Connection speed',
      /*
       * Loopback again, by a different route.
       *
       * The transfer always comes from the page's own origin, so on a local
       * install it crosses no network at all — and reported around 11 MB/s as
       * though it were the reader's line. Their round trip has been guarded since
       * Phase 1; their bandwidth was measured the same way and never was.
       */
      status:
        tp === null || !tp.consented
          ? 'skipped'
          : loopbackTransfer || tp.downloadBps.value === null
            ? 'unavailable'
            : 'pass',
      headline:
        loopbackTransfer || tp?.downloadBps.value === undefined || tp.downloadBps.value === null
          ? null
          : `${(tp.downloadBps.value / 125_000).toFixed(1)} Mbps`,
      summary:
        tp === null || !tp.consented
          ? 'Not run: the speed test is off by default because it uses your data.'
          : loopbackTransfer
            ? 'Not measurable — this tool is running on your own machine, so the transfer never left it.'
            : tp.downloadBps.value === null
              ? 'The speed test did not complete.'
              : `Measured about ${(tp.downloadBps.value / 125_000).toFixed(1)} Mbps down.`,
      technical:
        tp === null || !tp.consented
          ? 'Throughput measurement is opt-in. It transfers several megabytes, which costs real money on a metered connection, so it is never run without being asked for — and it is the least important of the client measurements, since latency and loss explain far more slow-page complaints than bandwidth does.'
          : 'One download and one upload against our own endpoint, hard-capped in both bytes and seconds. Treat it as an order of magnitude rather than a precise figure, and as a floor rather than a ceiling: a single short transfer spends much of its life in TCP slow start, so a genuinely fast link measures slower than it is. There is no ramp and no repetition — this is a sanity check, not a speed test.',
      evidence:
        tp === null
          ? []
          : [
              {
                label: 'Download',
                value: loopbackTransfer
                  ? 'not measured'
                  : tp.downloadBps.value === null
                    ? 'not measured'
                    : `${formatBytes(tp.downloadBps.value)}/s`,
                provenance: loopbackTransfer ? 'unavailable' : tp.downloadBps.provenance,
              },
              {
                label: 'Upload',
                value: loopbackTransfer
                  ? 'not measured'
                  : tp.uploadBps.value === null
                    ? 'not measured'
                    : `${formatBytes(tp.uploadBps.value)}/s`,
                provenance: loopbackTransfer ? 'unavailable' : tp.uploadBps.provenance,
              },
            ],
      relatedFindings: link('client-low-throughput'),
    }),
  );

  if (client.connectionHint !== null) {
    const h = client.connectionHint;
    checks.push(
      check({
        id: 'client.browser-hint',
        phase: 'client',
        title: 'What your browser reports',
        status: 'pass',
        headline: h.effectiveType,
        summary: `Your browser describes the connection as "${h.effectiveType ?? 'unknown'}".`,
        technical:
          'Read from the Network Information API. Corroboration only, never primary evidence: browsers derive these values from recent observed traffic, round them heavily, and deliberately coarsen them to limit fingerprinting. Useful for sanity-checking our own measurements, not for drawing conclusions.',
        evidence: [
          { label: 'Effective type', value: h.effectiveType ?? 'unknown', provenance: 'inferred' },
          {
            label: 'Estimated downlink',
            value: h.downlinkMbps === null ? 'unknown' : `${String(h.downlinkMbps)} Mbps`,
            provenance: 'inferred',
          },
          {
            label: 'Estimated round trip',
            value: h.rttMs === null ? 'unknown' : ms(h.rttMs),
            provenance: 'inferred',
          },
          {
            label: 'Data saver',
            value: h.saveData === true ? 'on' : 'off',
            provenance: 'inferred',
          },
        ],
      }),
    );
  }

  return checks;
}
