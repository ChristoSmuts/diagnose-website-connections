import { z } from 'zod';
import { EvidenceSchema } from './evidence.js';
import { VerdictSchema } from './verdict.js';

/**
 * Who owns a row.
 *
 * Present from day one even though the default deployment has exactly one
 * implicit principal. Scoping every query by it now costs almost nothing;
 * retrofitting it later would mean touching every query in the codebase.
 */
export const PrincipalSchema = z.object({
  id: z.string(),
  /** Display name; "Local" in the default single-user mode. */
  name: z.string(),
  mode: z.enum(['none', 'password', 'multiuser']),
});
export type Principal = z.infer<typeof PrincipalSchema>;

/** The implicit principal used when AUTH_MODE=none. */
export const LOCAL_PRINCIPAL: Principal = {
  id: 'local',
  name: 'Local',
  mode: 'none',
};

export const SiteSchema = z.object({
  id: z.string(),
  principalId: z.string(),
  url: z.url(),
  /** User-editable friendly name; defaults to the hostname. */
  label: z.string(),
  tags: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
  /** Non-null means archived. Soft delete, so restore is lossless. */
  archivedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Site = z.infer<typeof SiteSchema>;

export const ReportStatusSchema = z.enum(['running', 'complete', 'failed']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

/**
 * A single diagnostic run.
 *
 * Immutable and append-only: re-running a site inserts a new row rather than
 * updating an old one. That gives per-site history, trend charts and future
 * scheduled monitoring for free, and guarantees a stored report always reflects
 * what was actually observed at that moment.
 *
 * Both `evidence` and `verdict` are stored. Keeping only evidence would let a
 * later change to the engine's thresholds silently rewrite history.
 */
export const ReportSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  principalId: z.string(),
  status: ReportStatusSchema,
  /** Null while running or if the run failed outright. */
  verdict: VerdictSchema.nullable(),
  evidence: EvidenceSchema.nullable(),
  error: z.string().nullable().default(null),
  archivedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type Report = z.infer<typeof ReportSchema>;

/** Compact projection for the navigation tree — avoids loading full evidence. */
export const ReportSummarySchema = z.object({
  id: z.string(),
  siteId: z.string(),
  status: ReportStatusSchema,
  culprit: VerdictSchema.shape.culprit.nullable(),
  score: z.number().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

/** Site plus the data the sidebar needs, without a second round trip. */
export const SiteWithSummarySchema = SiteSchema.extend({
  reportCount: z.int().nonnegative(),
  latestReport: ReportSummarySchema.nullable(),
});
export type SiteWithSummary = z.infer<typeof SiteWithSummarySchema>;
