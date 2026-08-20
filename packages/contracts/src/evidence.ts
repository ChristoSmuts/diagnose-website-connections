import { z } from 'zod';
import { MetricSchema, SampleStatsSchema } from './primitives.js';

/** The site under test, after normalisation. */
export const TargetSchema = z.object({
  /** Exactly what the user typed, preserved for display. */
  inputUrl: z.string(),
  /** After adding a scheme, lowercasing the host, stripping fragments. */
  normalizedUrl: z.url(),
  host: z.string(),
  port: z.int().min(1).max(65535),
  scheme: z.enum(['http', 'https']),
});
export type Target = z.infer<typeof TargetSchema>;

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

export const DnsRecordSchema = z.object({
  type: z.enum(['A', 'AAAA', 'CNAME', 'NS', 'MX', 'TXT', 'SOA', 'CAA']),
  value: z.string(),
  ttl: z.int().nonnegative().nullable(),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

/**
 * One public resolver's answer.
 *
 * We deliberately query several. Disagreement between resolvers is a real and
 * commonly missed failure mode — mid-propagation changes, split-horizon DNS, or
 * a stale negative cache all show up here and nowhere else.
 */
export const ResolverAnswerSchema = z.object({
  resolver: z.string(),
  resolverName: z.string(),
  addresses: z.array(z.string()),
  durationMs: MetricSchema,
  error: z.string().nullable(),
});
export type ResolverAnswer = z.infer<typeof ResolverAnswerSchema>;

export const DnsEvidenceSchema = z.object({
  records: z.array(DnsRecordSchema),
  resolvers: z.array(ResolverAnswerSchema),
  /** True when every resolver returned the same address set. */
  consistent: z.boolean(),
  /** Timing straight to the domain's own authoritative nameservers. */
  authoritative: z.array(
    z.object({
      nameserver: z.string(),
      durationMs: MetricSchema,
      error: z.string().nullable(),
    }),
  ),
  /** Length of the CNAME chain before reaching an address. */
  cnameChainLength: z.int().nonnegative(),
  minTtlSeconds: z.int().nonnegative().nullable(),
  dnssec: z.boolean().nullable(),
  lookupMs: MetricSchema,
});
export type DnsEvidence = z.infer<typeof DnsEvidenceSchema>;

// ---------------------------------------------------------------------------
// Network identity
// ---------------------------------------------------------------------------
// Declared before the address schema because addresses now carry one. Zod
// schemas are plain values, so a forward reference here is a runtime error, not
// a type error — it would surface as an unhelpful TDZ crash at import time.

/** Sourced from Team Cymru's free DNS-based ASN service — no key, no account. */
export const NetworkIdentitySchema = z.object({
  /** Canonical form, prefix included: "AS13335". Renderers must not add another. */
  asn: z.string().nullable(),
  asnName: z.string().nullable(),
  prefix: z.string().nullable(),
  /** Country the *announced prefix* is registered in. */
  country: z.string().nullable(),
  /**
   * Country the *autonomous system operator* is registered in.
   *
   * A different fact from `country` and worth having separately: a network
   * registered to a company in one country routinely announces prefixes
   * registered in several others. Where they disagree, that is information, not
   * an error to be resolved by preferring one.
   */
  asnCountry: z.string().nullable().default(null),
  registry: z.string().nullable(),
  /** Derived from ASN against a bundled open mapping. */
  cdnDetected: z.string().nullable(),
});
export type NetworkIdentity = z.infer<typeof NetworkIdentitySchema>;

// ---------------------------------------------------------------------------
// Per-address reachability (IPv4 and IPv6 measured separately)
// ---------------------------------------------------------------------------

/**
 * Broken or slow IPv6 while IPv4 is healthy is a classic cause of "the site is
 * slow, but only for some people". Collapsing the two would hide it, so every
 * resolved address is probed independently.
 */
export const AddressEvidenceSchema = z.object({
  address: z.string(),
  family: z.union([z.literal(4), z.literal(6)]),
  reachable: z.boolean(),
  tcpConnectMs: MetricSchema,
  error: z.string().nullable(),
  /**
   * Reverse DNS for this address, or null when the zone publishes none.
   *
   * Hosting providers name these after the facility — `ams`, `fra1`,
   * `af-south-1` — which is often the only public clue about where a machine
   * physically sits. It is a naming convention and nothing more, so it is
   * treated as a hint rather than as a fact.
   */
  ptr: z.string().nullable().default(null),
  /**
   * Network identity for this specific address.
   *
   * `ServerEvidence.network` describes one address only — whichever answered
   * first. That is the right summary for a single-homed site and actively
   * misleading for a site whose addresses live on different networks, or in
   * different countries, which is exactly the case somebody asking "where is
   * this hosted" needs to see.
   */
  network: NetworkIdentitySchema.nullable().default(null),
});
export type AddressEvidence = z.infer<typeof AddressEvidenceSchema>;

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

export const CertificateSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  daysUntilExpiry: z.number(),
  subjectAltNames: z.array(z.string()),
  /** Whether the cert actually covers the hostname requested. */
  hostnameMatches: z.boolean(),
  chainLength: z.int().nonnegative(),
  selfSigned: z.boolean(),
  /**
   * Structured identity from the certificate subject and issuer.
   *
   * Present only on organisation- and extended-validation certificates. A
   * domain-validated certificate — which is most of them — proves control of a
   * hostname and asserts nothing about who or where its owner is, so these being
   * null is the normal case and says nothing about the site.
   */
  subjectCountry: z.string().nullable().default(null),
  subjectOrg: z.string().nullable().default(null),
  issuerCountry: z.string().nullable().default(null),
});
export type Certificate = z.infer<typeof CertificateSchema>;

export const TlsEvidenceSchema = z.object({
  handshakeMs: MetricSchema,
  protocol: z.string().nullable(),
  cipher: z.string().nullable(),
  /** Negotiated ALPN — how we know whether HTTP/2 is actually in use. */
  alpn: z.string().nullable(),
  keyExchange: z.string().nullable(),
  certificate: CertificateSchema.nullable(),
  ocspStapled: z.boolean().nullable(),
  /**
   * Second handshake reusing a session ticket. The delta against the first is
   * the real-world saving returning visitors get, which is invisible from a
   * single handshake.
   */
  resumedHandshakeMs: MetricSchema,
  resumptionSupported: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type TlsEvidence = z.infer<typeof TlsEvidenceSchema>;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const RedirectHopSchema = z.object({
  url: z.url(),
  status: z.int(),
  location: z.string().nullable(),
  durationMs: MetricSchema,
});
export type RedirectHop = z.infer<typeof RedirectHopSchema>;

export const HttpEvidenceSchema = z.object({
  status: z.int(),
  httpVersion: z.string(),
  /** Advertised via Alt-Svc; we detect support without speaking QUIC ourselves. */
  http3Advertised: z.boolean(),
  ttfbMs: MetricSchema,
  /** Time from first byte to last byte — the transfer phase proper. */
  downloadMs: MetricSchema,
  totalMs: MetricSchema,
  /** Chain the user never sees but always pays for. */
  redirects: z.array(RedirectHopSchema),
  contentEncoding: z.string().nullable(),
  compressionRatio: MetricSchema,
  transferredBytes: MetricSchema,
  uncompressedBytes: MetricSchema,
  cacheControl: z.string().nullable(),
  /** Whether the origin let us see its own internal timing. */
  serverTiming: z.string().nullable(),
  hsts: z.boolean(),
  contentSecurityPolicy: z.boolean(),
  /** Set by the site; when present the browser can also measure sub-phases. */
  timingAllowOrigin: z.boolean(),
  headers: z.record(z.string(), z.string()),
});
export type HttpEvidence = z.infer<typeof HttpEvidenceSchema>;

// ---------------------------------------------------------------------------
// Stability and network identity
// ---------------------------------------------------------------------------

export const StabilityEvidenceSchema = z.object({
  ttfb: SampleStatsSchema,
  /**
   * First request versus subsequent ones. A large gap means caching or a CDN is
   * doing real work; no gap at all often means neither is present.
   */
  coldTtfbMs: MetricSchema,
  warmTtfbMs: MetricSchema,
});
export type StabilityEvidence = z.infer<typeof StabilityEvidenceSchema>;

// ---------------------------------------------------------------------------
// Vantage points
// ---------------------------------------------------------------------------

/** Vantage S — our server to the target. A neutral, well-connected observer. */
export const ServerEvidenceSchema = z.object({
  target: TargetSchema,
  observedAt: z.iso.datetime(),
  vantage: z.string().default('primary'),
  dns: DnsEvidenceSchema,
  addresses: z.array(AddressEvidenceSchema),
  tls: TlsEvidenceSchema.nullable(),
  http: HttpEvidenceSchema.nullable(),
  stability: StabilityEvidenceSchema.nullable(),
  network: NetworkIdentitySchema,
  /** Set when the probe could not complete at all (DNS failure, refused, etc). */
  fatalError: z.string().nullable(),
});
export type ServerEvidence = z.infer<typeof ServerEvidenceSchema>;

export const ThroughputEvidenceSchema = z.object({
  downloadBps: MetricSchema,
  uploadBps: MetricSchema,
  /** Users must opt in; this spends their data. */
  consented: z.boolean(),
});
export type ThroughputEvidence = z.infer<typeof ThroughputEvidenceSchema>;

/**
 * Vantages K and T — measured in the user's browser.
 *
 * `control` is the load-bearing one: latency to *our own* endpoint is what lets
 * us separate "your connection is slow" from "that site is slow". Without a
 * control we could only ever guess.
 */
export const ClientEvidenceSchema = z.object({
  observedAt: z.iso.datetime(),
  /** Vantage K: browser → the control endpoint. Characterises the user's link. */
  control: SampleStatsSchema,
  /**
   * Which endpoint answered the control measurement. Null means same-origin.
   *
   * Provenance, not decoration: the same round-trip figure means something
   * different depending on what produced it, and a reader cannot tell from the
   * number alone. Defaulted so reports stored before this field parse unchanged.
   */
  controlOrigin: z.string().nullable().default(null),
  /**
   * Whether that endpoint was on this machine or this LAN.
   *
   * Determined by the browser from the address it actually measured, not guessed
   * from how fast the answer came back. The latency heuristic that used to decide
   * this alone is a heuristic: WebKit's loopback round trip measured 15 ms on a
   * developer machine, sailed past the threshold, and the report announced
   * "your connection is healthy" about a loopback interface — the exact false
   * accusation the threshold exists to prevent.
   *
   * Defaulted false so evidence recorded before this field still parses; the
   * latency check remains as a second line of defence.
   */
  controlIsLocal: z.boolean().default(false),
  /**
   * Whether the control endpoint is another instance of this app.
   *
   * `CONTROL_URL` may point at anything the browser can reach — the round trip is
   * timed opaquely, so the far end grants nothing and need not know this tool
   * exists. What that buys is a real baseline for the reader's own link on a
   * local install, and it is genuinely useful for that.
   *
   * It is not a substitute in the path arithmetic, which subtracts this figure
   * from the browser's time to the target. That subtraction assumes the two are
   * comparable measurements. A large anycast endpoint answers from whichever edge
   * is nearest the reader, by design, so the baseline comes out too small, the
   * expected time too low, and the unexplained remainder — which the report
   * attributes to the reader's provider — is inflated by ordinary distance to the
   * target. Blaming an ISP for geography is the same class of error as blaming
   * one for loopback.
   *
   * Defaulted true so evidence recorded before this field, which could only have
   * come from a paired endpoint, still means what it meant.
   */
  controlIsPaired: z.boolean().default(true),
  /**
   * Whether the connection to the control endpoint ended at a CDN edge.
   *
   * A paired instance behind Cloudflare, a tunnel, or any distributed frontend
   * answers the browser from a point of presence near the reader rather than from
   * the machine itself. The round trip is real and still describes the reader's
   * own link — it is arguably a better measure of it than a distant origin would
   * be — but it cannot be subtracted from their time to the target, because the
   * baseline is then short by however far the target actually is.
   *
   * This is the same fault as loopback and as an unpaired anycast control, which
   * is why all three now share one predicate. Reported by the endpoint that
   * answered, from the request headers it received, rather than guessed from the
   * timing.
   *
   * Defaulted false so evidence recorded before this field still means what it
   * meant: at the time, nothing could have been edge-terminated and undetected.
   */
  controlIsEdgeTerminated: z.boolean().default(false),
  /**
   * Whether the page itself is served from this machine or this LAN.
   *
   * Distinct from `controlIsLocal`, which describes the control endpoint. The
   * throughput test always fetches from the page's own origin, so on a local
   * install it measures loopback however remote `CONTROL_URL` points — and a
   * loopback transfer is not a statement about anyone's bandwidth any more than a
   * loopback round trip is about their latency.
   *
   * Defaulted false so evidence recorded before this field still parses; the
   * throughput check treats false as "not known to be local" rather than as a
   * guarantee.
   */
  appIsLocal: z.boolean().default(false),
  /**
   * Round trips from the browser to well-known public endpoints.
   *
   * A second way to reason about the route, and the only one that needs nothing
   * of our own deployment. The control measurement compares vantages — the
   * reader against our server — and breaks whenever our end sits closer to the
   * reader than the target does. These compare *destinations* instead: the
   * quickest reference is roughly the reader's floor, so whatever the target
   * costs above that is what reaching this particular site costs them.
   *
   * That works on a laptop and behind a CDN, where the control cannot anchor
   * anything. It is opt-in because it means contacting third parties, which this
   * project otherwise refuses — empty unless an operator sets REFERENCE_URLS.
   */
  references: z.array(z.object({ origin: z.string(), stats: SampleStatsSchema })).default([]),
  /** Vantage T: browser → the target. Coarse; CORS hides the detail. */
  target: SampleStatsSchema,
  throughput: ThroughputEvidenceSchema.nullable(),
  /** navigator.connection — corroboration only, never primary evidence. */
  connectionHint: z
    .object({
      effectiveType: z.string().nullable(),
      downlinkMbps: z.number().nullable(),
      rttMs: z.number().nullable(),
      saveData: z.boolean().nullable(),
    })
    .nullable(),
});
export type ClientEvidence = z.infer<typeof ClientEvidenceSchema>;

/**
 * The complete evidence bundle handed to the attribution engine.
 *
 * `client` is nullable because a server-only run is still useful — it just
 * cannot ever conclude that the user's connection is at fault, and the engine
 * enforces that rather than guessing.
 */
export const EvidenceSchema = z.object({
  server: ServerEvidenceSchema,
  /** Additional vantages, when extra probe instances are configured. */
  additionalVantages: z.array(ServerEvidenceSchema).default([]),
  client: ClientEvidenceSchema.nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
