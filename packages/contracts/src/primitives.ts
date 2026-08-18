import { z } from 'zod';

/**
 * Where a number came from.
 *
 * This is the single most important type in the codebase. A browser genuinely
 * cannot observe cross-origin DNS/TCP/TLS timings — CORS redacts them — so any
 * tool in this space is constantly tempted to present a guess as a fact.
 * Carrying provenance on the value itself makes that mistake impossible to
 * make by accident: the UI cannot render a number without also knowing whether
 * it was actually observed.
 */
export const ProvenanceSchema = z.enum([
  /** Directly observed by us. Trustworthy. */
  'measured',
  /** Derived or estimated. Must state its basis and be badged in the UI. */
  'inferred',
  /** We tried and could not obtain it. Distinct from "zero" or "fine". */
  'unavailable',
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const UnitSchema = z.enum(['ms', 'bytes', 'bytes-per-second', 'count', 'ratio', 'percent']);
export type Unit = z.infer<typeof UnitSchema>;

/**
 * A single measured quantity, inseparable from how we know it.
 *
 * `basis` is required whenever provenance is not `measured`, enforced below —
 * an inferred number without a stated basis is not reportable.
 */
export const MetricSchema = z
  .object({
    value: z.number().nullable(),
    unit: UnitSchema,
    provenance: ProvenanceSchema,
    /** Plain-language explanation of how an inferred/unavailable value arose. */
    basis: z.string().optional(),
  })
  .refine((m) => m.provenance === 'measured' || typeof m.basis === 'string', {
    message: 'Non-measured metrics must state a basis',
    path: ['basis'],
  })
  .refine((m) => m.provenance !== 'unavailable' || m.value === null, {
    message: 'Unavailable metrics must have a null value, not a placeholder number',
    path: ['value'],
  });
export type Metric = z.infer<typeof MetricSchema>;

/** Convenience constructors — keep call sites honest and terse. */
export const measured = (value: number, unit: Unit): Metric => ({
  value,
  unit,
  provenance: 'measured',
});
export const inferred = (value: number, unit: Unit, basis: string): Metric => ({
  value,
  unit,
  provenance: 'inferred',
  basis,
});
export const unavailable = (unit: Unit, basis: string): Metric => ({
  value: null,
  unit,
  provenance: 'unavailable',
  basis,
});

/**
 * Summary of repeated samples.
 *
 * A single timing sample is close to worthless on a live network, so the engine
 * never reasons about one. Median and IQR are used rather than mean and stddev
 * because network latency distributions are heavily right-skewed — one GC pause
 * or retransmit would drag a mean somewhere misleading.
 */
export const SampleStatsSchema = z.object({
  count: z.int().nonnegative(),
  /** Samples that timed out or errored — the loss proxy. */
  failed: z.int().nonnegative(),
  min: z.number().nullable(),
  median: z.number().nullable(),
  p95: z.number().nullable(),
  max: z.number().nullable(),
  /** Interquartile range: the stability signal. High IQR = erratic. */
  iqr: z.number().nullable(),
  /** Mean absolute consecutive difference — jitter as a user would feel it. */
  jitter: z.number().nullable(),
  unit: UnitSchema,
});
export type SampleStats = z.infer<typeof SampleStatsSchema>;

/** Ordered worst-first; the UI relies on this ordering for ranking. */
export const SeveritySchema = z.enum(['critical', 'major', 'minor', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'major', 'minor', 'info'] as const;

/**
 * How much we trust a conclusion. Shown, never hidden — a low-confidence
 * verdict presented confidently is the main way a tool like this loses trust.
 */
export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * Who can actually act on a finding.
 *
 * This is the question real users have, and it is deliberately part of the data
 * model rather than prose: "enable Brotli compression" is useless advice to a
 * visitor who does not run the server.
 */
export const OwnerSchema = z.enum([
  /** The people who run the site being tested. */
  'site-owner',
  /** The person using this tool, on their own device or network. */
  'you',
  /** The user's internet provider. */
  'your-isp',
  /** Nobody — physics, distance, or simply how the internet works. */
  'nobody',
]);
export type Owner = z.infer<typeof OwnerSchema>;
