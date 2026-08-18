import type Database from 'better-sqlite3';

/**
 * Versioned, forward-only migrations applied at boot.
 *
 * Written as plain SQL against SQLite's own `user_version` counter rather than
 * shipping drizzle-kit into production. A self-hosted deployment should be able
 * to start from an empty directory with no extra tooling and no migration step
 * to remember — that is the whole appeal of a single-file database.
 */
interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: `
      CREATE TABLE sites (
        id            TEXT PRIMARY KEY,
        principal_id  TEXT NOT NULL,
        url           TEXT NOT NULL,
        label         TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',
        notes         TEXT,
        archived_at   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX sites_principal_idx ON sites (principal_id);
      CREATE UNIQUE INDEX sites_principal_url_idx ON sites (principal_id, url);

      CREATE TABLE reports (
        id            TEXT PRIMARY KEY,
        site_id       TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL,
        status        TEXT NOT NULL,
        culprit       TEXT,
        score         INTEGER,
        verdict_json  TEXT,
        evidence_json TEXT,
        error         TEXT,
        archived_at   TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX reports_site_idx ON reports (site_id);
      CREATE INDEX reports_principal_idx ON reports (principal_id);
      CREATE INDEX reports_site_created_idx ON reports (site_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'site icons',
    up: `
      -- The site's own favicon, stored as a data URL.
      --
      -- Kept here rather than fetched by the browser on demand: a per-site request
      -- from the page would leak every saved site to its origin on every load, and
      -- a third-party favicon service would break the offline guarantee outright.
      -- The server already fetches from these hosts under the SSRF guard, so it is
      -- the right place to do it once and remember the answer.
      ALTER TABLE sites ADD COLUMN icon_data_url TEXT;
      -- Null means never attempted; a timestamp with a null icon means we tried
      -- and there was nothing there, which stops us asking again on every run.
      ALTER TABLE sites ADD COLUMN icon_fetched_at TEXT;
    `,
  },
];

export function migrate(db: Database.Database): { from: number; to: number; applied: string[] } {
  // Foreign keys are OFF by default in SQLite, which would silently defeat the
  // ON DELETE CASCADE that deleting a site relies on.
  db.pragma('foreign_keys = ON');
  // WAL gives far better concurrent read behaviour while a probe is writing.
  db.pragma('journal_mode = WAL');

  const rows = db.pragma('user_version') as { user_version: number }[];
  const from = rows[0]?.user_version ?? 0;
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;

    // Each migration is atomic: a partial schema is worse than none.
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
      db.exec('COMMIT');
      applied.push(`${migration.version}: ${migration.name}`);
    } catch (error) {
      db.exec('ROLLBACK');
      // `cause` matters here: the SQLite error carries the offending statement,
      // and a failed migration at boot is precisely when that detail is needed.
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  const after = db.pragma('user_version') as { user_version: number }[];
  return { from, to: after[0]?.user_version ?? from, applied };
}

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
