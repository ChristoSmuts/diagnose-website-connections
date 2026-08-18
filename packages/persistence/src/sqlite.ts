import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Evidence,
  Report,
  ReportSummary,
  Site,
  SiteWithSummary,
  Verdict,
} from '@dwc/contracts';
import Database from 'better-sqlite3';
import { and, desc, eq, isNotNull, isNull, sql, type Column } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from './migrations.js';
import {
  DuplicateSiteError,
  ImmutableReportError,
  RunningReportError,
  type CreateReportInput,
  type CreateSiteInput,
  type Repositories,
  type ReportRepository,
  type SiteRepository,
  type UpdateSiteInput,
} from './repositories.js';
import { reports, sites, type ReportRow, type SiteRow } from './schema.js';

export interface OpenOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  /** Injectable so tests can assert on timestamps deterministically. */
  now?: () => string;
  idFactory?: () => string;
}

type Db = BetterSQLite3Database<Record<string, never>>;

// --- row mapping -----------------------------------------------------------

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    principalId: row.principalId,
    url: row.url,
    label: row.label,
    tags: parseTags(row.tags),
    notes: row.notes,
    iconDataUrl: row.iconDataUrl,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Tags are stored as JSON; a corrupt value must not break the whole listing. */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toReport(row: ReportRow): Report {
  return {
    id: row.id,
    siteId: row.siteId,
    principalId: row.principalId,
    status: row.status,
    verdict: row.verdictJson === null ? null : (JSON.parse(row.verdictJson) as Verdict),
    evidence: row.evidenceJson === null ? null : (JSON.parse(row.evidenceJson) as Evidence),
    error: row.error,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

function toSummary(row: ReportRow): ReportSummary {
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status,
    culprit: (row.culprit as ReportSummary['culprit']) ?? null,
    score: row.score,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Shared archive filter, so 'active' can never accidentally include archived
 * rows. Generic over the column because both sites and reports are archivable.
 */
function archiveFilter(column: Column, include: 'active' | 'archived' | 'all') {
  if (include === 'active') return isNull(column);
  if (include === 'archived') return isNotNull(column);
  return undefined;
}

// --- repositories ----------------------------------------------------------

class SqliteSiteRepository implements SiteRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => string,
    private readonly newId: () => string,
  ) {}

  create(input: CreateSiteInput): Site {
    const timestamp = this.now();
    const row = {
      id: this.newId(),
      principalId: input.principalId,
      url: input.url,
      label: input.label,
      tags: JSON.stringify(input.tags),
      notes: null,
      iconDataUrl: null,
      iconFetchedAt: null,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      this.db.insert(sites).values(row).run();
    } catch (error) {
      // Surfaced as a domain error so the route can respond helpfully rather
      // than leaking a constraint name.
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new DuplicateSiteError(input.url);
      }
      throw error;
    }

    return toSite(row satisfies SiteRow);
  }

  findById(principalId: string, id: string): Site | null {
    const row = this.db
      .select()
      .from(sites)
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id)))
      .get();
    return row === undefined ? null : toSite(row);
  }

  findByUrl(principalId: string, url: string): Site | null {
    const row = this.db
      .select()
      .from(sites)
      .where(and(eq(sites.principalId, principalId), eq(sites.url, url)))
      .get();
    return row === undefined ? null : toSite(row);
  }

  list(principalId: string, include: 'active' | 'archived' | 'all'): SiteWithSummary[] {
    const rows = this.db
      .select()
      .from(sites)
      .where(and(eq(sites.principalId, principalId), archiveFilter(sites.archivedAt, include)))
      .orderBy(desc(sites.updatedAt))
      .all();

    return rows.map((row) => {
      // Sidebar needs a count and the newest report; fetching full evidence for
      // every site would mean parsing megabytes of JSON to draw a list.
      const countRow = this.db
        .select({ value: sql<number>`count(*)` })
        .from(reports)
        .where(and(eq(reports.siteId, row.id), isNull(reports.archivedAt)))
        .get();

      const latest = this.db
        .select()
        .from(reports)
        .where(and(eq(reports.siteId, row.id), isNull(reports.archivedAt)))
        .orderBy(desc(reports.createdAt))
        .limit(1)
        .get();

      return {
        ...toSite(row),
        reportCount: countRow?.value ?? 0,
        latestReport: latest === undefined ? null : toSummary(latest),
      };
    });
  }

  update(principalId: string, id: string, input: UpdateSiteInput): Site | null {
    const existing = this.findById(principalId, id);
    if (existing === null) return null;

    const patch: Partial<SiteRow> = { updatedAt: this.now() };
    if (input.label !== undefined) patch.label = input.label;
    if (input.tags !== undefined) patch.tags = JSON.stringify(input.tags);
    if (input.notes !== undefined) patch.notes = input.notes;

    this.db
      .update(sites)
      .set(patch)
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id)))
      .run();

    return this.findById(principalId, id);
  }

  /**
   * Records the outcome of an icon lookup, found or not.
   *
   * The timestamp is written either way: without it a site with no favicon would
   * be re-fetched on every single run, which is a request to someone else's
   * server for something we already know is not there.
   */
  setIcon(principalId: string, id: string, dataUrl: string | null): void {
    this.db
      .update(sites)
      .set({ iconDataUrl: dataUrl, iconFetchedAt: this.now() })
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id)))
      .run();
  }

  /** True when this site has never been looked up. */
  needsIcon(principalId: string, id: string): boolean {
    const row = this.db
      .select()
      .from(sites)
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id)))
      .get();
    return row !== undefined && row.iconFetchedAt === null;
  }

  archive(principalId: string, id: string): Site | null {
    const timestamp = this.now();
    this.db
      .update(sites)
      .set({ archivedAt: timestamp, updatedAt: timestamp })
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id), isNull(sites.archivedAt)))
      .run();

    // Archiving a site archives its reports, so the tree stays clean. They are
    // restored together, which is why the reports keep their own flag.
    this.db
      .update(reports)
      .set({ archivedAt: timestamp })
      .where(and(eq(reports.siteId, id), isNull(reports.archivedAt)))
      .run();

    return this.findById(principalId, id);
  }

  restore(principalId: string, id: string): Site | null {
    /*
     * Restores only what archiving this site actually took with it.
     *
     * This used to clear archivedAt on every report for the site, which
     * resurrected runs the user had archived individually — silent, and
     * unrecoverable without noticing. Archiving stamps the cascade with the
     * site's own timestamp and skips reports already archived, so a matching
     * timestamp is what identifies the ones that came along for the ride.
     */
    const current = this.findById(principalId, id);
    if (current === null) return null;
    const cascadeStamp = current.archivedAt;

    this.db
      .update(sites)
      .set({ archivedAt: null, updatedAt: this.now() })
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id)))
      .run();

    if (cascadeStamp !== null) {
      this.db
        .update(reports)
        .set({ archivedAt: null })
        .where(and(eq(reports.siteId, id), eq(reports.archivedAt, cascadeStamp)))
        .run();
    }

    return this.findById(principalId, id);
  }

  hardDelete(principalId: string, id: string): boolean {
    const result = this.db
      .delete(sites)
      .where(and(eq(sites.principalId, principalId), eq(sites.id, id)))
      .run();
    return result.changes > 0;
  }
}

class SqliteReportRepository implements ReportRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => string,
    private readonly newId: () => string,
  ) {}

  create(input: CreateReportInput): Report {
    const row: ReportRow = {
      id: this.newId(),
      siteId: input.siteId,
      principalId: input.principalId,
      status: 'running',
      culprit: null,
      score: null,
      verdictJson: null,
      evidenceJson: null,
      error: null,
      archivedAt: null,
      createdAt: this.now(),
    };
    this.db.insert(reports).values(row).run();
    return toReport(row);
  }

  complete(id: string, evidence: Evidence, verdict: Verdict): Report | null {
    this.assertStillRunning(id);

    this.db
      .update(reports)
      .set({
        status: 'complete',
        culprit: verdict.culprit,
        score: verdict.score,
        verdictJson: JSON.stringify(verdict),
        evidenceJson: JSON.stringify(evidence),
      })
      .where(eq(reports.id, id))
      .run();

    const row = this.db.select().from(reports).where(eq(reports.id, id)).get();
    return row === undefined ? null : toReport(row);
  }

  fail(id: string, error: string): Report | null {
    this.assertStillRunning(id);

    this.db.update(reports).set({ status: 'failed', error }).where(eq(reports.id, id)).run();

    const row = this.db.select().from(reports).where(eq(reports.id, id)).get();
    return row === undefined ? null : toReport(row);
  }

  /**
   * Enforces the append-only rule at the storage boundary.
   *
   * Without this, a retry or a duplicated event could overwrite a finished
   * report, and the stored history would no longer be a record of what happened.
   */
  private assertStillRunning(id: string): void {
    const row = this.db.select().from(reports).where(eq(reports.id, id)).get();
    if (row !== undefined && row.status !== 'running') {
      throw new ImmutableReportError(id, row.status);
    }
  }

  findById(principalId: string, id: string): Report | null {
    const row = this.db
      .select()
      .from(reports)
      .where(and(eq(reports.principalId, principalId), eq(reports.id, id)))
      .get();
    return row === undefined ? null : toReport(row);
  }

  listForSite(
    principalId: string,
    siteId: string,
    include: 'active' | 'archived' | 'all',
  ): ReportSummary[] {
    return this.db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.principalId, principalId),
          eq(reports.siteId, siteId),
          archiveFilter(reports.archivedAt, include),
        ),
      )
      .orderBy(desc(reports.createdAt))
      .all()
      .map(toSummary);
  }

  archive(principalId: string, id: string): boolean {
    const result = this.db
      .update(reports)
      .set({ archivedAt: this.now() })
      .where(and(eq(reports.principalId, principalId), eq(reports.id, id)))
      .run();
    return result.changes > 0;
  }

  restore(principalId: string, id: string): boolean {
    const result = this.db
      .update(reports)
      .set({ archivedAt: null })
      .where(and(eq(reports.principalId, principalId), eq(reports.id, id)))
      .run();
    return result.changes > 0;
  }

  /**
   * Deletes a finished report. Refuses one that is still running.
   *
   * A running report has a diagnostic streaming into it. Deleting it mid-flight
   * left `complete()` updating nothing and returning null, so the run finished
   * against a row that no longer existed and failed silently. Refusing is both
   * simpler than aborting the probe and easier to explain to whoever clicked it.
   */
  hardDelete(principalId: string, id: string): boolean {
    const row = this.db
      .select()
      .from(reports)
      .where(and(eq(reports.principalId, principalId), eq(reports.id, id)))
      .get();

    if (row === undefined) return false;
    if (row.status === 'running') throw new RunningReportError(id);

    const result = this.db
      .delete(reports)
      .where(and(eq(reports.principalId, principalId), eq(reports.id, id)))
      .run();
    return result.changes > 0;
  }
}

/**
 * Open (and if necessary create) the database, then migrate it.
 *
 * Migrating on open means a fresh self-hosted install works from an empty
 * directory with no separate setup command to forget.
 */
export function openDatabase(options: OpenOptions): Repositories & { migrated: string[] } {
  const { path, now = () => new Date().toISOString(), idFactory = randomUUID } = options;

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  const applied = migrate(sqlite);
  const db = drizzle(sqlite);

  return {
    sites: new SqliteSiteRepository(db, now, idFactory),
    reports: new SqliteReportRepository(db, now, idFactory),
    close: () => sqlite.close(),
    migrated: applied.applied,
  };
}
