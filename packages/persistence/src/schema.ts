import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Sites the user has saved.
 *
 * `archivedAt` implements archive as a soft delete, so restoring is lossless.
 * Hard delete is a separate, explicitly-confirmed operation.
 */
export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    /** Every row is scoped by principal, even in single-user mode. */
    principalId: text('principal_id').notNull(),
    url: text('url').notNull(),
    label: text('label').notNull(),
    /** JSON array — SQLite has no array type and a join table is overkill here. */
    tags: text('tags').notNull().default('[]'),
    notes: text('notes'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('sites_principal_idx').on(table.principalId),
    // The same URL twice in one account is almost always a mistake rather than
    // an intent, and it would split a site's history in two.
    uniqueIndex('sites_principal_url_idx').on(table.principalId, table.url),
  ],
);

/**
 * Diagnostic runs. Append-only: a re-run inserts a row and never updates one.
 *
 * `verdict` is stored alongside `evidence` on purpose. Keeping only the raw
 * evidence would mean a later change to the engine's thresholds silently
 * rewrote what past reports concluded.
 */
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    status: text('status', { enum: ['running', 'complete', 'failed'] }).notNull(),
    /** Denormalised from the verdict so the sidebar needs no JSON parsing. */
    culprit: text('culprit'),
    score: integer('score'),
    verdictJson: text('verdict_json'),
    evidenceJson: text('evidence_json'),
    error: text('error'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('reports_site_idx').on(table.siteId),
    index('reports_principal_idx').on(table.principalId),
    // History is always read newest-first for a given site.
    index('reports_site_created_idx').on(table.siteId, table.createdAt),
  ],
);

export type SiteRow = typeof sites.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
