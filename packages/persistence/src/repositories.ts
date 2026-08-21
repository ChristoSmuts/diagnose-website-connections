import type {
  Evidence,
  Report,
  ReportStatus,
  ReportSummary,
  Site,
  SiteWithSummary,
  Verdict,
} from '@dwc/contracts';

/**
 * The storage contract.
 *
 * Feature code depends only on these interfaces, never on SQLite or Drizzle.
 * That is what lets a Postgres adapter be added later without touching a single
 * route, and what lets the tests run against an in-memory database.
 *
 * Every method takes a principalId. It is not optional and there is no
 * "current user" hidden in module state — scoping has to be impossible to
 * forget, because forgetting it once would leak another account's data.
 */

export interface CreateSiteInput {
  principalId: string;
  url: string;
  label: string;
  tags: string[];
}

/**
 * Explicit `| undefined` on each field: under `exactOptionalPropertyTypes` an
 * optional property and one that may hold `undefined` are different types, and
 * zod's parsed output is the latter.
 */
export interface UpdateSiteInput {
  label?: string | undefined;
  tags?: string[] | undefined;
  notes?: string | null | undefined;
}

export interface SiteRepository {
  create(input: CreateSiteInput): Site;
  findById(principalId: string, id: string): Site | null;
  findByUrl(principalId: string, url: string): Site | null;
  list(principalId: string, include: 'active' | 'archived' | 'all'): SiteWithSummary[];
  update(principalId: string, id: string, input: UpdateSiteInput): Site | null;
  /** Records the outcome of a favicon lookup. Null means "looked, found nothing". */
  setIcon(principalId: string, id: string, dataUrl: string | null): void;
  /** True when this site has never had its favicon looked up. */
  needsIcon(principalId: string, id: string): boolean;
  /** Soft delete — reversible via restore. */
  archive(principalId: string, id: string): Site | null;
  restore(principalId: string, id: string): Site | null;
  /** Irreversible. Cascades to the site's reports. */
  hardDelete(principalId: string, id: string): boolean;
}

export interface CreateReportInput {
  principalId: string;
  siteId: string;
}

export interface ReportRepository {
  /** Inserts a 'running' row so the UI has something to attach progress to. */
  create(input: CreateReportInput): Report;
  /**
   * Records the outcome. This is the ONLY permitted mutation of a report, and
   * only from 'running' — reports are otherwise immutable so that history
   * cannot be rewritten.
   */
  complete(id: string, evidence: Evidence, verdict: Verdict): Report | null;
  /**
   * Attaches the browser half of the same run, and only ever once.
   *
   * This is the finish of a diagnostic rather than a second edit of a finished
   * one. The browser cannot start measuring until the server has answered, so its
   * evidence necessarily arrives seconds after the row is written — and leaving it
   * unsaved meant reopening a report showed "your connection: not measured" about
   * a run that had measured it perfectly well.
   *
   * Refusing when client evidence is already present is what keeps the
   * immutability rule intact: a report can be completed, never rewritten, and a
   * re-run is still a new row.
   */
  attachClientEvidence(
    principalId: string,
    id: string,
    evidence: Evidence,
    verdict: Verdict,
  ): Report | null;
  fail(id: string, error: string): Report | null;
  findById(principalId: string, id: string): Report | null;
  listForSite(
    principalId: string,
    siteId: string,
    include: 'active' | 'archived' | 'all',
  ): ReportSummary[];
  archive(principalId: string, id: string): boolean;
  restore(principalId: string, id: string): boolean;
  hardDelete(principalId: string, id: string): boolean;
}

export interface Repositories {
  sites: SiteRepository;
  reports: ReportRepository;
  close(): void;
}

/** Thrown when a write would violate the append-only rule. */
export class ImmutableReportError extends Error {
  constructor(id: string, status: ReportStatus) {
    super(`Report ${id} is already ${status} and cannot be modified.`);
    this.name = 'ImmutableReportError';
  }
}

/**
 * Thrown when a delete would pull a report out from under a running diagnostic.
 *
 * Distinct from ImmutableReportError: that one guards the append-only rule for
 * *writes*, this one guards a delete. Conflating them would make the API's reply
 * misleading — nothing is being rewritten here.
 */
export class RunningReportError extends Error {
  constructor(id: string) {
    super(`Report ${id} is still running. Wait for it to finish before deleting it.`);
    this.name = 'RunningReportError';
  }
}

export class DuplicateSiteError extends Error {
  constructor(url: string) {
    super(`${url} is already saved.`);
    this.name = 'DuplicateSiteError';
  }
}
