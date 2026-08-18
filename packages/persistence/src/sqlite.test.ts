import { analyse } from '@dwc/diagnostics';
import { scenarios } from '@dwc/diagnostics/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LATEST_VERSION } from './migrations.js';
import { ImmutableReportError, type Repositories } from './repositories.js';
import { openDatabase } from './sqlite.js';

let repos: Repositories & { migrated: string[] };

const ALICE = 'alice';
const BOB = 'bob';

beforeEach(() => {
  repos = openDatabase({ path: ':memory:' });
});

const newSite = (principalId = ALICE, url = 'https://example.com/') =>
  repos.sites.create({ principalId, url, label: 'Example', tags: ['prod'] });

describe('migrations', () => {
  it('brings an empty database fully up to date on open', () => {
    expect(repos.migrated.length).toBeGreaterThan(0);
    expect(LATEST_VERSION).toBeGreaterThan(0);
  });

  it('is idempotent — reopening applies nothing further', () => {
    const again = openDatabase({ path: ':memory:' });
    expect(again.migrated.length).toBeGreaterThan(0);
    // A second migrate() on the same connection must be a no-op.
    expect(openDatabase({ path: ':memory:' }).migrated).toEqual(again.migrated);
  });
});

describe('sites', () => {
  it('round-trips a site including its tags', () => {
    const created = newSite();
    const found = repos.sites.findById(ALICE, created.id);

    expect(found?.url).toBe('https://example.com/');
    expect(found?.tags).toEqual(['prod']);
    expect(found?.archivedAt).toBeNull();
  });

  it('rejects the same URL twice for one principal', () => {
    newSite();
    expect(() => newSite()).toThrow(/already saved/i);
  });

  it('allows two principals to track the same URL independently', () => {
    newSite(ALICE);
    expect(() => newSite(BOB)).not.toThrow();
  });

  it('edits labels and tags without touching the measured URL', () => {
    const site = newSite();
    const updated = repos.sites.update(ALICE, site.id, { label: 'Renamed', tags: ['staging'] });

    expect(updated?.label).toBe('Renamed');
    expect(updated?.tags).toEqual(['staging']);
    expect(updated?.url).toBe(site.url);
  });
});

describe('archive is reversible, delete is not', () => {
  it('removes an archived site from the active list but keeps it retrievable', () => {
    const site = newSite();
    repos.sites.archive(ALICE, site.id);

    expect(repos.sites.list(ALICE, 'active')).toHaveLength(0);
    expect(repos.sites.list(ALICE, 'archived')).toHaveLength(1);
    expect(repos.sites.list(ALICE, 'all')).toHaveLength(1);
  });

  it('restores an archived site and its reports together', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });

    repos.sites.archive(ALICE, site.id);
    expect(repos.reports.listForSite(ALICE, site.id, 'active')).toHaveLength(0);

    repos.sites.restore(ALICE, site.id);
    expect(repos.sites.list(ALICE, 'active')).toHaveLength(1);
    expect(repos.reports.listForSite(ALICE, site.id, 'active')).toHaveLength(1);
    expect(repos.reports.findById(ALICE, report.id)?.archivedAt).toBeNull();
  });

  it('cascades a hard delete to the site’s reports', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });

    expect(repos.sites.hardDelete(ALICE, site.id)).toBe(true);
    expect(repos.sites.findById(ALICE, site.id)).toBeNull();
    // Depends on PRAGMA foreign_keys being ON, which is off by default in SQLite.
    expect(repos.reports.findById(ALICE, report.id)).toBeNull();
  });
});

/**
 * Reports are the historical record. If they can be rewritten, the history is
 * worthless — so the storage layer refuses, rather than trusting callers.
 */
describe('report immutability', () => {
  it('stores both the evidence and the rendered verdict', () => {
    const site = newSite();
    const created = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const evidence = scenarios.slowServer();
    const verdict = analyse(evidence);

    const completed = repos.reports.complete(created.id, evidence, verdict);

    expect(completed?.status).toBe('complete');
    expect(completed?.verdict?.culprit).toBe('server');
    expect(completed?.evidence?.server.target.host).toBe('example.com');
  });

  it('refuses to overwrite a finished report', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const evidence = scenarios.healthy();

    repos.reports.complete(report.id, evidence, analyse(evidence));

    expect(() => repos.reports.complete(report.id, evidence, analyse(evidence))).toThrow(
      ImmutableReportError,
    );
    expect(() => repos.reports.fail(report.id, 'nope')).toThrow(ImmutableReportError);
  });

  it('treats a re-run as a new row, preserving the earlier result', () => {
    const site = newSite();

    const first = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const slow = scenarios.slowServer();
    repos.reports.complete(first.id, slow, analyse(slow));

    const second = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const healthy = scenarios.healthy();
    repos.reports.complete(second.id, healthy, analyse(healthy));

    const history = repos.reports.listForSite(ALICE, site.id, 'active');

    expect(history).toHaveLength(2);
    // This is what makes trend charts and future scheduled runs possible.
    expect(history.map((r) => r.culprit).sort()).toEqual(['healthy', 'server']);
  });

  it('exposes score and culprit without parsing stored JSON', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const evidence = scenarios.slowServer();
    repos.reports.complete(report.id, evidence, analyse(evidence));

    const summary = repos.reports.listForSite(ALICE, site.id, 'active')[0];
    expect(summary?.culprit).toBe('server');
    expect(summary?.score).toBeGreaterThan(0);
  });
});

/**
 * The security property of the whole storage layer. Worth testing even though
 * the default deployment has one principal, because that is exactly the
 * situation in which such a bug would go unnoticed until multi-user is enabled.
 */
describe('principal scoping', () => {
  it('hides one principal’s sites from another', () => {
    const site = newSite(ALICE);

    expect(repos.sites.findById(BOB, site.id)).toBeNull();
    expect(repos.sites.list(BOB, 'all')).toHaveLength(0);
  });

  it('hides one principal’s reports from another', () => {
    const site = newSite(ALICE);
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });

    expect(repos.reports.findById(BOB, report.id)).toBeNull();
    expect(repos.reports.listForSite(BOB, site.id, 'all')).toHaveLength(0);
  });

  it('refuses cross-principal mutation and deletion', () => {
    const site = newSite(ALICE);
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });

    expect(repos.sites.update(BOB, site.id, { label: 'hijacked' })).toBeNull();
    expect(repos.sites.hardDelete(BOB, site.id)).toBe(false);
    expect(repos.reports.archive(BOB, report.id)).toBe(false);
    expect(repos.reports.hardDelete(BOB, report.id)).toBe(false);

    // Still intact and still Alice's.
    expect(repos.sites.findById(ALICE, site.id)?.label).toBe('Example');
  });
});

describe('sidebar projection', () => {
  it('reports the count and newest report per site', () => {
    const site = newSite();
    const older = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const evidence = scenarios.healthy();
    repos.reports.complete(older.id, evidence, analyse(evidence));

    const listed = repos.sites.list(ALICE, 'active')[0];

    expect(listed?.reportCount).toBe(1);
    expect(listed?.latestReport?.culprit).toBe('healthy');
  });

  it('shows no reports for a site that has never been run', () => {
    newSite();
    const listed = repos.sites.list(ALICE, 'active')[0];

    expect(listed?.reportCount).toBe(0);
    expect(listed?.latestReport).toBeNull();
  });
});
