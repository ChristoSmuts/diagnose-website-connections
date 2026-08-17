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

/** Sourced from Team Cymru's free DNS-based ASN service — no key, no account. */
export const NetworkIdentitySchema = z.object({
  asn: z.string().nullable(),
  asnName: z.string().nullable(),
  prefix: z.string().nullable(),
  country: z.string().nullable(),
  registry: z.string().nullable(),
  /** Derived from ASN against a bundled open mapping. */
  cdnDetected: z.string().nullable(),
});
export type NetworkIdentity = z.infer<typeof NetworkIdentitySchema>;

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
  /** Vantage K: browser → our control endpoint. Characterises the user's link. */
  control: SampleStatsSchema,
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
