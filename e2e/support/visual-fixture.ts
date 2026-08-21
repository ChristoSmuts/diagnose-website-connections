import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the seeded report's id is left for the specs to find.
 *
 * A file rather than an environment variable, because the two ends run in
 * different processes — global setup in the runner, the specs in workers — and a
 * source-relative path is the one thing both compute identically. The database
 * itself lives in a fresh temp directory per run, so its path cannot serve.
 *
 * Git-ignored: it names a row in a database that is deleted with the run.
 */
const FIXTURE_FILE = join(import.meta.dirname, '..', '.visual-fixture.json');

/** The site the fixture report belongs to. Deliberately not a real host. */
export const FIXTURE_SITE_URL = 'https://visual-fixture.test/';
export const FIXTURE_SITE_LABEL = 'visual-fixture.test';

export function writeVisualFixture(reportId: string): void {
  writeFileSync(FIXTURE_FILE, JSON.stringify({ reportId }, null, 2), 'utf8');
}

export function readVisualFixture(): string {
  try {
    const { reportId } = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as { reportId: string };
    return reportId;
  } catch {
    throw new Error(
      `No seeded report found at ${FIXTURE_FILE}. It is written by e2e/global-setup.ts; ` +
        'run the suite through `playwright test` rather than invoking a spec directly.',
    );
  }
}
