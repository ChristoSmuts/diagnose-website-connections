import type { Evidence } from '@dwc/contracts';
import { analyse } from '@dwc/diagnostics';
import { scenarios } from '@dwc/diagnostics/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LATEST_VERSION } from './migrations.js';
import { ImmutableReportError, RunningReportError, type Repositories } from './repositories.js';
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

  /**
   * The archive cascade used to be a one-way trip for anything caught in it.
   *
   * `restore` cleared `archived_at` on every report belonging to the site, so a
   * run the user had deliberately archived came back the moment they restored
   * the site — silently, and with nothing to show it had happened. The fix keys
   * off the cascade's own timestamp, which is why this test drives the clock:
   * distinct timestamps are exactly the assumption being relied on.
   */
  it('leaves an individually archived report archived when its site is restored', () => {
    let tick = 0;
    const clock = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
    const scoped = openDatabase({ path: ':memory:', now: clock });

    const site = scoped.sites.create({
      principalId: ALICE,
      url: 'https://a.test/',
      label: 'A',
      tags: [],
    });
    const kept = scoped.reports.create({ principalId: ALICE, siteId: site.id });
    const hidden = scoped.reports.create({ principalId: ALICE, siteId: site.id });

    // The user archives one run on its own, then archives the whole site later.
    scoped.reports.archive(ALICE, hidden.id);
    scoped.sites.archive(ALICE, site.id);
    expect(scoped.reports.listForSite(ALICE, site.id, 'active')).toHaveLength(0);

    scoped.sites.restore(ALICE, site.id);

    const active = scoped.reports.listForSite(ALICE, site.id, 'active').map((r) => r.id);
    expect(active).toEqual([kept.id]);
    expect(scoped.reports.findById(ALICE, hidden.id)?.archivedAt).not.toBeNull();
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

  /**
   * The browser half of a run arrives after the row is written, and has to stick.
   *
   * Only the server can be probed while the reader waits; the browser cannot start
   * measuring until there is a target to measure against. That evidence used to be
   * computed, returned for display and thrown away, so revisiting a report showed
   * "your connection: not measured" about a run that had measured it — and the
   * export, the sidebar dot and the stored score all disagreed with the screen.
   */
  it('attaches browser evidence to a finished report', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });

    // A server-only run: no browser evidence, so the client vantage is unknown.
    const serverOnly: Evidence = { ...scenarios.healthy(), client: null };
    repos.reports.complete(report.id, serverOnly, analyse(serverOnly));
    expect(repos.reports.findById(ALICE, report.id)?.verdict?.vantages.userConnection.status).toBe(
      'unknown',
    );

    const merged = scenarios.healthy();
    const attached = repos.reports.attachClientEvidence(ALICE, report.id, merged, analyse(merged));

    expect(attached?.evidence?.client).not.toBeNull();
    const reopened = repos.reports.findById(ALICE, report.id);
    expect(reopened?.verdict?.vantages.userConnection.status).not.toBe('unknown');
    expect(reopened?.evidence?.client).not.toBeNull();
  });

  /**
   * The guard that keeps immutability intact: a report can be completed once, not
   * revised. Without it this method would be a general-purpose rewrite of history
   * wearing a narrow name.
   */
  it('refuses a second attachment, leaving the first standing', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const serverOnly: Evidence = { ...scenarios.healthy(), client: null };
    repos.reports.complete(report.id, serverOnly, analyse(serverOnly));

    const first = scenarios.healthy();
    repos.reports.attachClientEvidence(ALICE, report.id, first, analyse(first));
    const afterFirst = repos.reports.findById(ALICE, report.id)?.verdict?.culprit;

    const second = scenarios.slowClient();
    expect(
      repos.reports.attachClientEvidence(ALICE, report.id, second, analyse(second)),
    ).toBeNull();

    expect(repos.reports.findById(ALICE, report.id)?.verdict?.culprit).toBe(afterFirst);
  });

  it('refuses to attach across principals, or to a report that never completed', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const evidence = scenarios.healthy();

    // Still running: there is nothing to attach to yet.
    expect(
      repos.reports.attachClientEvidence(ALICE, report.id, evidence, analyse(evidence)),
    ).toBeNull();

    const serverOnly: Evidence = { ...evidence, client: null };
    repos.reports.complete(report.id, serverOnly, analyse(serverOnly));

    expect(
      repos.reports.attachClientEvidence(BOB, report.id, evidence, analyse(evidence)),
    ).toBeNull();
    expect(repos.reports.findById(ALICE, report.id)?.evidence?.client).toBeNull();
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
/**
 * Deleting is allowed; deleting out from under a live diagnostic is not.
 *
 * A running report has a probe streaming into it. Removing the row mid-flight
 * left `complete()` matching nothing and returning null, so the run ended against
 * a record that no longer existed and reported nothing at all.
 */
describe('deleting a running report', () => {
  it('refuses while the diagnostic is still streaming', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });

    expect(() => repos.reports.hardDelete(ALICE, report.id)).toThrow(RunningReportError);
    expect(repos.reports.findById(ALICE, report.id)).not.toBeNull();
  });

  it('allows it once the report has finished', () => {
    const site = newSite();
    const report = repos.reports.create({ principalId: ALICE, siteId: site.id });
    const evidence = scenarios.healthy();
    repos.reports.complete(report.id, evidence, analyse(evidence));

    expect(repos.reports.hardDelete(ALICE, report.id)).toBe(true);
    expect(repos.reports.findById(ALICE, report.id)).toBeNull();
  });

  it('reports a missing report as not found rather than throwing', () => {
    expect(repos.reports.hardDelete(ALICE, 'no-such-report')).toBe(false);
  });
});

/**
 * The icon lookup is remembered whether or not it found anything.
 *
 * Without that, every site with no favicon would be asked again on every single
 * run — a request to somebody else's server for something already known absent.
 */
describe('site icons', () => {
  it('has not been looked up on a new site', () => {
    const site = newSite();
    expect(repos.sites.needsIcon(ALICE, site.id)).toBe(true);
    expect(repos.sites.findById(ALICE, site.id)?.iconDataUrl).toBeNull();
  });

  it('stores an icon and stops asking', () => {
    const site = newSite();
    repos.sites.setIcon(ALICE, site.id, 'data:image/png;base64,AAAA');

    expect(repos.sites.findById(ALICE, site.id)?.iconDataUrl).toBe('data:image/png;base64,AAAA');
    expect(repos.sites.needsIcon(ALICE, site.id)).toBe(false);
  });

  it('stops asking even when there was nothing to find', () => {
    const site = newSite();
    repos.sites.setIcon(ALICE, site.id, null);

    expect(repos.sites.findById(ALICE, site.id)?.iconDataUrl).toBeNull();
    expect(repos.sites.needsIcon(ALICE, site.id)).toBe(false);
  });

  it('cannot be set across principals', () => {
    const site = newSite();
    repos.sites.setIcon(BOB, site.id, 'data:image/png;base64,AAAA');

    expect(repos.sites.findById(ALICE, site.id)?.iconDataUrl).toBeNull();
  });
});

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
