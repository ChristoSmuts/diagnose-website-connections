import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Every run gets its own database.
 *
 * The history lifecycle specs create, archive and hard-delete sites. Sharing a
 * database between runs would make them order-dependent and would let a failed
 * run leave state that makes the next one pass for the wrong reason.
 */
const databasePath = join(mkdtempSync(join(tmpdir(), 'dwc-e2e-')), 'e2e.db');

const PORT = 8799;
const baseURL = `http://127.0.0.1:${String(PORT)}`;

/**
 * Visual snapshots are Linux-only, on purpose.
 *
 * Font rasterisation differs between Windows, macOS and Linux, so baselines taken
 * on a developer machine can never match CI. Rather than commit three sets, only
 * Linux baselines are committed — generated either in CI or locally through the
 * official Playwright container (which on this project's primary machine means
 * WSL). Elsewhere the visual specs skip themselves; see specs/visual.spec.ts.
 */
export const VISUAL_PLATFORM = 'linux';

export default defineConfig({
  testDir: './specs',
  // Generous: a real diagnostic performs DNS, TCP, TLS and several HTTP samples.
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Antialiasing differs slightly even between runs on the same machine.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    },
  },

  fullyParallel: false,
  // A shared SQLite database and a shared sidebar make parallel writes to the
  // same site list a source of flake rather than a source of speed.
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
    // Firefox is deliberately absent: it is not installed on the primary dev
    // machine, and a project that silently never runs is worse than none.
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
  ],

  /**
   * The app is served the way it is actually deployed: one process, with the API
   * serving the built web app same-origin.
   *
   * This matters beyond convenience. A cross-origin dev setup would add a CORS
   * preflight to every /api/ping request, inflating the very latency baseline the
   * whole diagnosis rests on — so testing against `vite dev` would measure
   * something the product never does.
   */
  webServer: {
    command: 'node apps/api/src/index.ts',
    cwd: repoRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: databasePath,
      AUTH_MODE: 'none',
      LOG_LEVEL: 'warn',
      // Below 5 samples the engine treats variance as noise, so keep the real
      // default rather than speeding tests up into a different code path.
      STABILITY_SAMPLES: '5',
      RATE_LIMIT_PER_MINUTE: '200',
    },
  },
});

/**
 * Fails loudly if the app was not built, rather than serving a 404 and letting
 * every spec fail with an unhelpful "element not found".
 */
if (!existsSync(join(repoRoot, 'apps/web/dist/index.html'))) {
  throw new Error(
    'apps/web/dist is missing — run `pnpm run build` before the E2E suite. ' +
      'The API serves the built app, so there is nothing to test without it.',
  );
}
