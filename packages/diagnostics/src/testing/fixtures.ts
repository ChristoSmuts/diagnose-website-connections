import type { ClientEvidence, Evidence, ServerEvidence } from '@dwc/contracts';
import { measured, unavailable } from '@dwc/contracts';
import { computeStats } from '../stats.js';

/**
 * Evidence builders for tests.
 *
 * Defaults describe a healthy site on a healthy connection, so each test only
 * states the one thing it is actually about. That keeps the decision-table
 * tests readable as a specification rather than as a wall of object literals.
 */
export interface ScenarioOptions {
  host?: string;
  /** Server-side time to first byte, ms. The main "is the server slow" dial. */
  ttfbMs?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  /** Repeated TTFB samples; drives the stability/variance signals. */
  ttfbSamples?: number[];
  /** null means no browser measurement at all — a server-only run. */
  clientRttSamples?: number[] | null;
  /** Browser → target timings. Defaults to a value consistent with the others. */
  clientTargetSamples?: number[];
  clientFailed?: number;
  downloadBps?: number | null;
  compression?: string | null;
  httpVersion?: string;
  redirectCount?: number;
  status?: number;
  fatalError?: string | null;
  ipv6Reachable?: boolean | null;
  certDaysUntilExpiry?: number;
  hostnameMatches?: boolean;
  tlsProtocol?: string;
  cdn?: string | null;
  cacheControl?: string | null;
  transferredBytes?: number;
}

export function makeServerEvidence(opts: ScenarioOptions = {}): ServerEvidence {
  const {
    host = 'example.com',
    ttfbMs = 90,
    dnsMs = 20,
    tcpMs = 25,
    tlsMs = 40,
    ttfbSamples,
    compression = 'br',
    httpVersion = '2',
    redirectCount = 0,
    status = 200,
    fatalError = null,
    ipv6Reachable = true,
    certDaysUntilExpiry = 180,
    hostnameMatches = true,
    tlsProtocol = 'TLSv1.3',
    cdn = 'Cloudflare',
    cacheControl = 'public, max-age=3600',
    transferredBytes = 45_000,
  } = opts;

  const samples = ttfbSamples ?? [
    ttfbMs,
    ttfbMs * 1.05,
    ttfbMs * 0.95,
    ttfbMs * 1.02,
    ttfbMs * 0.98,
  ];

  return {
    target: {
      inputUrl: host,
      normalizedUrl: `https://${host}/`,
      host,
      port: 443,
      scheme: 'https',
    },
    observedAt: '2026-08-17T12:00:00.000Z',
    vantage: 'primary',
    dns: {
      records: [
        { type: 'A', value: '93.184.216.34', ttl: 300 },
        { type: 'NS', value: 'ns1.example.com', ttl: 3600 },
      ],
      resolvers: [
        {
          resolver: '1.1.1.1',
          resolverName: 'Cloudflare',
          addresses: ['93.184.216.34'],
          durationMs: measured(dnsMs, 'ms'),
          error: null,
        },
        {
          resolver: '8.8.8.8',
          resolverName: 'Google',
          addresses: ['93.184.216.34'],
          durationMs: measured(dnsMs + 3, 'ms'),
          error: null,
        },
      ],
      consistent: true,
      authoritative: [
        { nameserver: 'ns1.example.com', durationMs: measured(dnsMs, 'ms'), error: null },
      ],
      cnameChainLength: 0,
      minTtlSeconds: 300,
      dnssec: true,
      lookupMs: measured(dnsMs, 'ms'),
    },
    addresses: [
      {
        address: '93.184.216.34',
        family: 4,
        reachable: fatalError === null,
        tcpConnectMs:
          fatalError === null ? measured(tcpMs, 'ms') : unavailable('ms', 'connection failed'),
        error: fatalError,
      },
      ...(ipv6Reachable === null
        ? []
        : [
            {
              address: '2606:2800:220:1:248:1893:25c8:1946',
              family: 6 as const,
              reachable: ipv6Reachable,
              tcpConnectMs: ipv6Reachable
                ? measured(tcpMs + 5, 'ms')
                : unavailable('ms', 'IPv6 connection failed'),
              error: ipv6Reachable ? null : 'ETIMEDOUT',
            },
          ]),
    ],
    tls:
      fatalError !== null
        ? null
        : {
            handshakeMs: measured(tlsMs, 'ms'),
            protocol: tlsProtocol,
            cipher: 'TLS_AES_256_GCM_SHA384',
            alpn: httpVersion === '2' ? 'h2' : 'http/1.1',
            keyExchange: 'X25519',
            certificate: {
              subject: `CN=${host}`,
              issuer: "Let's Encrypt",
              validFrom: '2026-05-01T00:00:00.000Z',
              validTo: '2027-02-13T00:00:00.000Z',
              daysUntilExpiry: certDaysUntilExpiry,
              subjectAltNames: hostnameMatches ? [host, `www.${host}`] : ['other.example.net'],
              hostnameMatches,
              chainLength: 2,
              selfSigned: false,
            },
            ocspStapled: true,
            resumedHandshakeMs: measured(tlsMs * 0.4, 'ms'),
            resumptionSupported: true,
            error: null,
          },
    http:
      fatalError !== null
        ? null
        : {
            status,
            httpVersion,
            http3Advertised: true,
            ttfbMs: measured(ttfbMs, 'ms'),
            downloadMs: measured(30, 'ms'),
            totalMs: measured(ttfbMs + 30, 'ms'),
            redirects: Array.from({ length: redirectCount }, (_, i) => ({
              url: `https://${host}/hop${i}`,
              status: 301,
              location: `https://${host}/hop${i + 1}`,
              durationMs: measured(45, 'ms'),
            })),
            contentEncoding: compression,
            compressionRatio: compression
              ? measured(0.3, 'ratio')
              : unavailable('ratio', 'response was not compressed'),
            transferredBytes: measured(transferredBytes, 'bytes'),
            uncompressedBytes: measured(transferredBytes * 3, 'bytes'),
            cacheControl,
            serverTiming: null,
            hsts: true,
            contentSecurityPolicy: true,
            timingAllowOrigin: false,
            headers: { server: 'nginx' },
          },
    stability:
      fatalError !== null
        ? null
        : {
            ttfb: computeStats(samples, 0, 'ms'),
            coldTtfbMs: measured(samples[0] ?? ttfbMs, 'ms'),
            warmTtfbMs: measured((samples[1] ?? ttfbMs) * 0.5, 'ms'),
          },
    network: {
      asn: 'AS13335',
      asnName: 'CLOUDFLARENET',
      prefix: '93.184.216.0/24',
      country: 'US',
      registry: 'arin',
      cdnDetected: cdn,
    },
    fatalError,
  };
}

export function makeClientEvidence(opts: ScenarioOptions = {}): ClientEvidence | null {
  const {
    clientRttSamples,
    clientTargetSamples,
    clientFailed = 0,
    downloadBps = 12_000_000,
  } = opts;

  if (clientRttSamples === null) return null;

  const control = clientRttSamples ?? [30, 32, 29, 31, 30];
  // By default the browser's view of the target is consistent with the two
  // endpoints, so no phantom path problem appears unless a test asks for one.
  const target = clientTargetSamples ?? control.map((c) => c + (opts.ttfbMs ?? 90));

  return {
    observedAt: '2026-08-17T12:00:05.000Z',
    control: computeStats(control, clientFailed, 'ms'),
    target: computeStats(target, 0, 'ms'),
    throughput:
      downloadBps === null
        ? null
        : {
            downloadBps: measured(downloadBps, 'bytes-per-second'),
            uploadBps: measured(downloadBps / 4, 'bytes-per-second'),
            consented: true,
          },
    connectionHint: null,
  };
}

export function makeEvidence(opts: ScenarioOptions = {}): Evidence {
  return {
    server: makeServerEvidence(opts),
    additionalVantages: [],
    client: makeClientEvidence(opts),
  };
}

/** The canonical situations the engine exists to tell apart. */
export const scenarios = {
  /** Fast site, healthy link. */
  healthy: (): Evidence => makeEvidence(),

  /** Slow backend, healthy link — must convict the server. */
  slowServer: (): Evidence => makeEvidence({ ttfbMs: 1800 }),

  /** Fast site, poor link — must convict the user's connection. */
  slowClient: (): Evidence =>
    makeEvidence({
      clientRttSamples: [420, 460, 390, 500, 445],
      downloadBps: 400_000,
    }),

  /** Both ends fine, but the browser's view of the target is far worse. */
  slowPath: (): Evidence =>
    makeEvidence({
      ttfbMs: 90,
      clientRttSamples: [30, 32, 29, 31, 30],
      clientTargetSamples: [1400, 1450, 1380, 1500, 1420],
    }),

  /** Genuinely two problems at once. */
  both: (): Evidence =>
    makeEvidence({
      ttfbMs: 1900,
      clientRttSamples: [430, 470, 410, 500, 450],
      downloadBps: 350_000,
    }),

  /** Nothing answered. */
  unreachable: (): Evidence => makeEvidence({ fatalError: 'ECONNREFUSED' }),

  /** Server-side only: the browser never reported in. */
  serverOnly: (): Evidence => makeEvidence({ clientRttSamples: null }),

  /** Erratic rather than uniformly slow. */
  unstable: (): Evidence =>
    makeEvidence({ ttfbMs: 300, ttfbSamples: [90, 850, 120, 1400, 110, 980, 130] }),
};
