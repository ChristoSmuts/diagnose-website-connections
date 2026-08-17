import { z } from 'zod';
import { ClientEvidenceSchema, ServerEvidenceSchema } from './evidence.js';
import { ReportSchema, SiteSchema } from './persistence.js';
import { VerdictSchema } from './verdict.js';

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export const StartDiagnosticRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  /** Attach to an existing saved site; omit to create one. */
  siteId: z.string().optional(),
  /** The user must opt in before we spend their bandwidth. */
  throughputConsent: z.boolean().default(false),
});
export type StartDiagnosticRequest = z.infer<typeof StartDiagnosticRequestSchema>;

/** Named phases, used for the progress UI and to order streamed events. */
export const ProbePhaseSchema = z.enum([
  'validating',
  'dns',
  'tcp',
  'tls',
  'http',
  'stability',
  'network',
  'client',
  'analysing',
]);
export type ProbePhase = z.infer<typeof ProbePhaseSchema>;

/**
 * Server-sent events emitted while a diagnostic runs.
 *
 * Streaming rather than one blocking response so the report builds in front of
 * the user instead of hiding behind a spinner — a full probe legitimately takes
 * several seconds, and watching it progress is far better than waiting blind.
 */
export const DiagnosticEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    reportId: z.string(),
    siteId: z.string(),
  }),
  z.object({
    type: z.literal('phase'),
    phase: ProbePhaseSchema,
    status: z.enum(['started', 'complete', 'skipped', 'failed']),
    /** Plain-language line for the progress UI. */
    message: z.string(),
  }),
  z.object({
    type: z.literal('partial'),
    /** Evidence gathered so far, so the UI can render as results land. */
    evidence: ServerEvidenceSchema.partial(),
  }),
  z.object({
    type: z.literal('complete'),
    report: ReportSchema,
  }),
  z.object({
    type: z.literal('failed'),
    reportId: z.string().nullable(),
    error: z.string(),
  }),
]);
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

/** Browser-measured evidence, posted up to be merged before attribution. */
export const SubmitClientEvidenceRequestSchema = z.object({
  reportId: z.string(),
  client: ClientEvidenceSchema,
});
export type SubmitClientEvidenceRequest = z.infer<typeof SubmitClientEvidenceRequestSchema>;

export const SubmitClientEvidenceResponseSchema = z.object({
  verdict: VerdictSchema,
});
export type SubmitClientEvidenceResponse = z.infer<typeof SubmitClientEvidenceResponseSchema>;

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const CreateSiteRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  label: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type CreateSiteRequest = z.infer<typeof CreateSiteRequestSchema>;

/** Only user-owned metadata is editable; the measured URL is not. */
export const UpdateSiteRequestSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export type UpdateSiteRequest = z.infer<typeof UpdateSiteRequestSchema>;

export const ListSitesQuerySchema = z.object({
  /** Archived items are never mixed into the main tree, but are never hidden. */
  include: z.enum(['active', 'archived', 'all']).default('active'),
});
export type ListSitesQuery = z.infer<typeof ListSitesQuerySchema>;

// ---------------------------------------------------------------------------
// Control endpoints — the "K" vantage the whole attribution rests on
// ---------------------------------------------------------------------------

/**
 * Tiny echo used to characterise the user's link.
 *
 * Deliberately trivial server-side work: any latency the browser sees here is
 * the network, not us. That is precisely what makes it a usable control.
 */
export const PingResponseSchema = z.object({
  t: z.number(),
});
export type PingResponse = z.infer<typeof PingResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  authMode: z.enum(['none', 'password', 'multiuser']),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'invalid-url',
      'blocked-target',
      'not-found',
      'rate-limited',
      'unauthorized',
      'internal',
    ]),
    /** Safe to show a user verbatim. */
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SiteResponseSchema = z.object({ site: SiteSchema });
export const ReportResponseSchema = z.object({ report: ReportSchema });
