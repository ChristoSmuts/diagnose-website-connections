import { z } from 'zod';
import { ConfidenceSchema, OwnerSchema, SeveritySchema } from './primitives.js';

/**
 * The headline answer: whose fault is it?
 *
 * This is the entire product in one field. Everything else in the report
 * exists to justify, qualify or act on this value.
 */
export const CulpritSchema = z.enum([
  /** Nothing meaningfully wrong. */
  'healthy',
  /** Slow even from a neutral, well-connected vantage. Their end. */
  'server',
  /** Our control endpoint is equally slow for this user. Their end. */
  'user-connection',
  /** Server fine, user's link fine, but the path between them is not. */
  'network-path',
  /** More than one genuine problem; findings carry independent severity. */
  'mixed',
  /** Could not connect at all — down, blocked, or does not exist. */
  'unreachable',
  /**
   * Not enough evidence to attribute honestly. A real and necessary outcome:
   * saying "we don't know" beats inventing a culprit.
   */
  'inconclusive',
]);
export type Culprit = z.infer<typeof CulpritSchema>;

export const VantageStatusSchema = z.enum(['ok', 'degraded', 'bad', 'unknown']);
export type VantageStatus = z.infer<typeof VantageStatusSchema>;

/** One of the three corners of the diagnostic triangle, as shown in Layer 1. */
export const VantageHealthSchema = z.object({
  status: VantageStatusSchema,
  /** Plain label for the tile, e.g. "Their server". */
  label: z.string(),
  /** One short line a non-technical reader can act on. */
  summary: z.string(),
  /** 0–100; null when status is unknown. */
  score: z.number().min(0).max(100).nullable(),
});
export type VantageHealth = z.infer<typeof VantageHealthSchema>;

/**
 * Stable identifiers for every issue the engine can detect.
 *
 * Codes rather than free text so tests can assert on them, the UI can attach
 * remediation content, and translations become possible later without
 * rewriting the engine.
 */
export const FindingCodeSchema = z.enum([
  // Reachability
  'unreachable',
  'dns-resolution-failed',
  'connection-refused',
  'connection-timeout',
  // DNS
  'dns-slow',
  'dns-resolver-disagreement',
  'dns-long-cname-chain',
  'dns-low-ttl',
  'dns-authoritative-slow',
  // Connectivity
  'tcp-slow',
  'ipv6-broken',
  'ipv6-absent',
  // TLS
  'tls-handshake-slow',
  'tls-cert-expiring-soon',
  'tls-cert-expired',
  'tls-cert-hostname-mismatch',
  'tls-cert-self-signed',
  'tls-outdated-protocol',
  'tls-long-chain',
  'tls-no-resumption',
  'tls-no-ocsp-stapling',
  // HTTP
  'ttfb-slow',
  'redirect-chain-long',
  'redirect-to-https-missing',
  'no-compression',
  'no-http2',
  'no-http3',
  'no-cache-headers',
  'payload-large',
  'http-error-status',
  // Stability
  'unstable-response-times',
  'no-cdn-caching-benefit',
  // Security posture (reported, never the headline)
  'no-hsts',
  'no-csp',
  // Client side
  'client-high-latency',
  'client-high-jitter',
  'client-packet-loss',
  'client-low-throughput',
  // Path
  'path-degraded',
  'no-cdn',
  'origin-geographically-distant',
]);
export type FindingCode = z.infer<typeof FindingCodeSchema>;

/**
 * One supporting number, ready to render.
 *
 * Shared by findings and checks so both render through the same component and,
 * more importantly, so both are forced to carry provenance. A row that renders
 * an inferred number as though it were observed is the failure this type exists
 * to prevent.
 */
export const EvidenceRowSchema = z.object({
  label: z.string(),
  value: z.string(),
  provenance: z.enum(['measured', 'inferred', 'unavailable']),
});
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

/**
 * Concrete, actionable fix guidance — Layer 3.
 *
 * `steps` are imperative and specific; `snippet` is copyable config. Both are
 * meaningless without `owner` on the parent finding, which is why that field
 * is mandatory there.
 */
export const RemediationSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
  /** Copyable configuration, e.g. an nginx directive or header value. */
  snippet: z
    .object({
      language: z.string(),
      code: z.string(),
      caption: z.string().optional(),
    })
    .nullable()
    .default(null),
  /** Honest, hedged expectation — never a precise promise. */
  expectedImprovement: z.string().nullable().default(null),
});
export type Remediation = z.infer<typeof RemediationSchema>;

/**
 * A single issue, written for three audiences at once.
 *
 * `title`/`plain`/`impact` are Layer 2 and must contain no unexplained jargon.
 * `technical` and `evidence` are Layer 3, revealed only on expand.
 */
export const FindingSchema = z.object({
  code: FindingCodeSchema,
  severity: SeveritySchema,
  owner: OwnerSchema,
  confidence: ConfidenceSchema,

  /** Layer 2: short heading in ordinary words. */
  title: z.string(),
  /** Layer 2: what we observed, no jargon. */
  plain: z.string(),
  /** Layer 2: why a real visitor should care. Concrete, not abstract. */
  impact: z.string(),

  /** Layer 3: the precise technical explanation. */
  technical: z.string(),
  /** Layer 3: the supporting numbers, each badged with its provenance. */
  evidence: z.array(EvidenceRowSchema).default([]),

  remediation: RemediationSchema.nullable().default(null),
});
export type Finding = z.infer<typeof FindingSchema>;

// ---------------------------------------------------------------------------
// Checks — the full diagnostic surface, including everything that passed
// ---------------------------------------------------------------------------

/**
 * Outcome of a single check.
 *
 * `skipped` and `unavailable` are deliberately separate. "We did not run this"
 * and "we ran it and could not tell" are different facts, and collapsing them
 * into one grey state is how a report starts implying it looked at things it
 * never did. The first is usually about our environment (no IPv6 route from this
 * host), the second about the target (closed the connection early).
 */
export const CheckStatusSchema = z.enum(['pass', 'warn', 'fail', 'skipped', 'unavailable']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** Grouping for the UI, following the order a request actually happens in. */
export const CheckPhaseSchema = z.enum([
  'dns',
  'connectivity',
  'tls',
  'http',
  'stability',
  'network',
  'client',
]);
export type CheckPhase = z.infer<typeof CheckPhaseSchema>;

export const CHECK_PHASE_ORDER: readonly CheckPhase[] = [
  'dns',
  'connectivity',
  'tls',
  'http',
  'stability',
  'network',
  'client',
] as const;

/**
 * One thing we looked at, whether or not anything was wrong with it.
 *
 * Findings only exist for problems, which left a healthy site with almost
 * nothing to inspect — backwards for a diagnostics tool. Checks are the complete
 * record: every probe performed, each with its own technical detail.
 *
 * Unlike a finding, a check has no `owner` or `severity`. It is an observation,
 * not an accusation; when it warrants action it points at the finding that makes
 * the case via `relatedFindings`.
 */
export const CheckSchema = z.object({
  /** Stable identifier, e.g. `tls.resumption`. Safe to assert on in tests. */
  id: z.string(),
  phase: CheckPhaseSchema,
  /** Short, human. "Session resumption", not "tls.resumption". */
  title: z.string(),
  status: CheckStatusSchema,
  /** One line, readable, shown while collapsed. */
  summary: z.string(),
  /** The number or value that belongs on the collapsed row, pre-formatted. */
  headline: z.string().nullable().default(null),
  /**
   * Layer 3, and deliberately NOT simplified. Someone expanding a check wants
   * the real explanation: name the RFC, the header, the cipher, the exact value.
   */
  technical: z.string(),
  evidence: z.array(EvidenceRowSchema).default([]),
  /** Finding codes this check produced, so the UI can link the two. */
  relatedFindings: z.array(FindingCodeSchema).default([]),
});
export type Check = z.infer<typeof CheckSchema>;

/** A term used anywhere in the report, with a one-line plain definition. */
export const GlossaryEntrySchema = z.object({
  term: z.string(),
  definition: z.string(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

/**
 * The complete rendered conclusion.
 *
 * Persisted alongside raw evidence so a stored report keeps saying what it said
 * at the time, even after the engine's thresholds are later tuned.
 */
export const VerdictSchema = z.object({
  culprit: CulpritSchema,

  /** Layer 1: one sentence, no jargon. The whole answer for most people. */
  headline: z.string(),
  /** Layer 1: two or three sentences of plain elaboration. */
  plain: z.string(),

  /** Overall health, 0–100. */
  score: z.number().min(0).max(100),
  confidence: ConfidenceSchema,
  /** Why confidence is not high — shown whenever confidence is not 'high'. */
  confidenceReason: z.string().nullable().default(null),

  /** The three corners of the triangle, for the Layer 1 tiles. */
  vantages: z.object({
    server: VantageHealthSchema,
    userConnection: VantageHealthSchema,
    networkPath: VantageHealthSchema,
  }),

  /** Layer 2, pre-sorted worst-first. */
  findings: z.array(FindingSchema),

  /**
   * Layer 3: every check performed, passes included, in phase order.
   *
   * Defaults to empty so reports stored before checks existed still parse and
   * render — they simply have no checks section. Reports are immutable and keep
   * their rendered `summary_json`, so history is read in its original terms;
   * `engineVersion` is what tells you which terms those were.
   */
  checks: z.array(CheckSchema).default([]),

  glossary: z.array(GlossaryEntrySchema).default([]),

  /** Engine version, so an old report can be read in its original terms. */
  engineVersion: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
