import { LOCAL_PRINCIPAL } from '@dwc/contracts';
import { analyse } from '@dwc/diagnostics';
import { scenarios } from '@dwc/diagnostics/testing';
import { openDatabase } from '@dwc/persistence';
import {
  FIXTURE_SITE_LABEL,
  FIXTURE_SITE_URL,
  writeVisualFixture,
} from './support/visual-fixture.js';

/**
 * Seeds one report that never changes, for the visual specs to photograph.
 *
 * Every other spec drives a real diagnostic, which is the point of them — but it
 * makes a terrible subject for a reference image. Against a live target the
 * verdict itself moves: a few tens of milliseconds of extra response time flips
 * `example.com` from "responding normally" to "responds unevenly", which changes
 * the headline, the finding list and the banner's whole background colour. No
 * mask can absorb that, because the wash *is* the background.
 *
 * So the visual specs open a stored report instead. It is written straight into
 * the same SQLite file the server reads, using the fixtures the unit tests
 * already share, and it renders through exactly the same code path as any other
 * report — the view is fed from `verdict_json`, which is the whole reason reports
 * store their rendered verdict. Nothing about the app changes to accommodate this;
 * there is no test-only route and no seeding endpoint.
 *
 * The database path is handed over by the config rather than recomputed, because
 * each run gets a fresh temp directory and guessing it would seed the wrong file.
 */
export default function globalSetup(): void {
  const path = process.env.DWC_E2E_DB;
  if (path === undefined || path === '') {
    throw new Error('DWC_E2E_DB is not set — playwright.config.ts should export the database path');
  }

  const repos = openDatabase({ path });

  const site = repos.sites.create({
    principalId: LOCAL_PRINCIPAL.id,
    url: FIXTURE_SITE_URL,
    label: FIXTURE_SITE_LABEL,
    tags: [],
  });

  const report = repos.reports.create({
    principalId: LOCAL_PRINCIPAL.id,
    siteId: site.id,
  });

  /*
   * `healthy` rather than a failing scenario, and with browser evidence present,
   * so the shot covers the three-tile layout rather than the one-tile-and-a-note
   * arrangement a server-only run produces. Both are worth having; this is the
   * one with more of the design in it.
   */
  const evidence = scenarios.healthy();
  repos.reports.complete(report.id, evidence, analyse(evidence));

  writeVisualFixture(report.id);
}
