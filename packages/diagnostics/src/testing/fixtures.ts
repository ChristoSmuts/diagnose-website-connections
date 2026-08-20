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
  /**
   * Origin the control measurement was taken against. Null means same-origin.
   *
   * Set it to exercise a CONTROL_URL deployment, where the baseline comes from a
   * different machine and the report has to say so.
   */
  controlOrigin?: string | null;
  /** Whether the browser said the control endpoint was on this machine or LAN. */
  controlIsLocal?: boolean;
  /** False when CONTROL_URL points at something that is not another instance. */
  controlIsPaired?: boolean;
  /** True when the control endpoint answered from a CDN edge rather than itself. */
  controlIsEdgeTerminated?: boolean;
  /** Medians for timed reference endpoints, keyed by origin. */
  referenceSamples?: Record<string, number[]>;
  /** Whether the page itself is served from loopback — the throughput case. */
  appIsLocal?: boolean;
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
  /** Reverse DNS for the IPv4 address. Null means the zone publishes none. */
  ptr?: string | null;
  /** The AS operator's own registered country, distinct from the prefix's. */
  asnCountry?: string | null;
  /** Certificate subject identity — null on a domain-validated cert, as usual. */
  certCountry?: string | null;
  certOrg?: string | null;
  /** Extra response headers, for the edge-location signals. */
  extraHeaders?: Record<string, string>;
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
    ptr = null,
    asnCountry = 'US',
    certCountry = null,
    certOrg = null,
    extraHeaders = {},
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
        ptr,
        network: null,
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
              ptr: null,
              network: null,
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
              subjectCountry: certCountry,
              subjectOrg: certOrg,
              issuerCountry: 'US',
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
            headers: { server: 'nginx', ...extraHeaders },
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
      asnCountry,
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
    controlOrigin = null,
    controlIsLocal = false,
    controlIsPaired = true,
    controlIsEdgeTerminated = false,
    referenceSamples = {},
    appIsLocal = opts.controlIsLocal ?? false,
  } = opts;

  if (clientRttSamples === null) return null;

  const control = clientRttSamples ?? [30, 32, 29, 31, 30];
  // By default the browser's view of the target is consistent with the two
  // endpoints, so no phantom path problem appears unless a test asks for one.
  const target = clientTargetSamples ?? control.map((c) => c + (opts.ttfbMs ?? 90));

  return {
    observedAt: '2026-08-17T12:00:05.000Z',
    control: computeStats(control, clientFailed, 'ms'),
    controlOrigin,
    controlIsLocal,
    controlIsPaired,
    controlIsEdgeTerminated,
    appIsLocal,
    references: Object.entries(referenceSamples).map(([origin, samples]) => ({
      origin,
      stats: computeStats(samples, 0, 'ms'),
    })),
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

  /**
   * Self-hosted on the reader's own machine: the control endpoint is loopback.
   *
   * The most important scenario in this file. Every client-side round trip comes
   * back in single-digit milliseconds, which describes no internet connection at
   * all, and the engine must refuse to judge either client vantage rather than
   * reporting a flattering number it never measured.
   */
  localInstall: (): Evidence =>
    makeEvidence({
      clientRttSamples: [2, 3, 2, 3, 2],
      clientTargetSamples: [95, 98, 92, 99, 94],
      controlIsLocal: true,
    }),

  /**
   * Local, but with a loopback round trip slow enough to look like a real link.
   *
   * Not hypothetical: WebKit measured 15 ms to 127.0.0.1 on an ordinary developer
   * machine. That is above LOCAL_CONTROL_RTT_MS, so the latency heuristic did not
   * fire and the report announced "Your connection: Healthy (15 ms round trip)"
   * about a loopback interface — the precise false accusation the threshold was
   * added to prevent, arriving through a door the threshold cannot watch.
   */
  slowLoopback: (): Evidence =>
    makeEvidence({
      clientRttSamples: [15, 16, 14, 17, 15],
      clientTargetSamples: [95, 98, 92, 99, 94],
      controlIsLocal: true,
    }),

  /**
   * Self-hosted, but with CONTROL_URL pointed at an instance across the internet.
   *
   * The baseline is real, so both client vantages become answerable — and the
   * report has to say which endpoint produced the figure, because the same number
   * from a different machine is a different claim.
   */
  remoteControl: (): Evidence =>
    makeEvidence({
      clientRttSamples: [38, 41, 36, 40, 39],
      controlOrigin: 'https://control.example.net',
    }),

  /**
   * A laptop install with reference endpoints configured.
   *
   * The control is loopback and useless, but the references still establish the
   * reader's floor — so the route becomes answerable on a machine that has no
   * second instance anywhere.
   */
  localWithReferences: (): Evidence =>
    makeEvidence({
      controlIsLocal: true,
      clientRttSamples: [3, 3, 4, 3, 3],
      clientTargetSamples: [140, 145, 138, 142, 141],
      referenceSamples: { 'https://reference.example.net': [35, 37, 34, 36, 35] },
    }),

  /**
   * The same, but the reader pays far more for this site than for a reference.
   *
   * The server reaches it quickly, so the extra is on the reader's side of the
   * target rather than the site being slow or far.
   */
  localReferencesShowRoute: (): Evidence =>
    makeEvidence({
      ttfbMs: 60,
      tcpMs: 20,
      tlsMs: 30,
      controlIsLocal: true,
      clientRttSamples: [3, 3, 4, 3, 3],
      clientTargetSamples: [820, 840, 810, 835, 825],
      referenceSamples: { 'https://reference.example.net': [40, 42, 39, 41, 40] },
    }),

  /**
   * A paired instance, but fronted by a CDN or a tunnel.
   *
   * The nastiest of the three, because everything looks right: the control is a
   * real instance of this app, the hostname is public, and the round trip is a
   * genuine internet measurement. It just ended at an edge near the reader rather
   * than at the machine, so it is too short to subtract.
   */
  edgeTerminatedControl: (): Evidence =>
    makeEvidence({
      clientRttSamples: [11, 12, 10, 12, 11],
      clientTargetSamples: [480, 495, 470, 488, 484],
      controlOrigin: 'https://diagnostics.example.com',
      controlIsEdgeTerminated: true,
    }),

  /**
   * CONTROL_URL pointed at something that is not another instance.
   *
   * A public endpoint answers the round trip perfectly well, so "your connection"
   * becomes answerable on a local install. The path does not: subtracting a
   * baseline measured against a nearby anycast edge from the time to a distant
   * target manufactures excess out of ordinary geography.
   */
  unpairedControl: (): Evidence =>
    makeEvidence({
      clientRttSamples: [22, 24, 21, 23, 22],
      controlOrigin: 'https://www.google.com',
      controlIsPaired: false,
    }),
  /**
   * Behind an anycast CDN edge, with the registry pointing somewhere else.
   *
   * The ordinary case for most of the web, and the one the location checks have
   * to get right: the prefix is registered in the United States, the edge that
   * answered is in Cape Town, and neither record is wrong. Reconciling them would
   * be the mistake.
   */
  anycastEdge: (): Evidence =>
    makeEvidence({
      cdn: 'Cloudflare',
      tcpMs: 14,
      extraHeaders: { 'cf-ray': 'a2d1207049284193-CPT', server: 'cloudflare' },
    }),

  /**
   * One origin, reached directly, with reverse DNS naming a cloud region.
   */
  directOrigin: (): Evidence =>
    makeEvidence({
      cdn: null,
      tcpMs: 30,
      ptr: 'ec2-13-244-1-1.af-south-1.compute.amazonaws.com',
      asnCountry: 'ZA',
    }),

  /**
   * Far from the reader, nothing in front of it, and the route itself is fine.
   *
   * The only shape in which distance is a defensible conclusion rather than a
   * guess: a CDN would have put a copy nearby, and a bad route would have shown
   * up as unexplained excess.
   */
  distantOrigin: (): Evidence =>
    makeEvidence({
      cdn: null,
      tcpMs: 190,
      ttfbMs: 120,
      clientRttSamples: [30, 32, 29, 31, 30],
      clientTargetSamples: [330, 335, 328, 332, 331],
    }),

  /** An organisation-validated certificate, which does carry an identity. */
  organisationCert: (): Evidence =>
    makeEvidence({
      certCountry: 'ZA',
      certOrg: 'Example Holdings (Pty) Ltd',
    }),
};
