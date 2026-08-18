import { expect, test } from '@playwright/test';
import { checkRows, openApp, runDiagnostic, setTheme, volatileRegions } from '../support/app.js';

/**
 * Visual regression across light/dark × mobile/desktop.
 *
 * Two decisions make the difference between a suite that protects the design and
 * one that gets disabled after a week of false failures:
 *
 *  1. **Linux-only baselines.** Font rasterisation differs by platform, so
 *     baselines taken on Windows or macOS can never match CI. Only Linux baselines
 *     are committed — produced in CI or locally through the official Playwright
 *     container. Everywhere else these specs skip.
 *
 *  2. **Volatile regions are masked.** Latency figures, timestamps and the health
 *     score all change every run against the live internet. Comparing them would
 *     fail for reasons unrelated to the design, so they are masked out and asserted
 *     in the functional specs instead.
 */
test.describe('visual regression', () => {
  test.skip(
    process.platform !== 'linux',
    'Snapshot baselines are Linux-only — run in the Playwright container (via WSL) or in CI.',
  );

  for (const theme of ['light', 'dark'] as const) {
    test(`the empty state looks right (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);

      // The empty state has no measured values, so nothing needs masking.
      await expect(page).toHaveScreenshot(`empty-${theme}.png`, { fullPage: true });
    });

    test(`the verdict hero looks right (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await runDiagnostic(page);

      // Only the banner: the ambient wash, display type and the dial's relationship
      // to the headline are what this guards.
      await expect(page.locator('dwc-verdict-banner')).toHaveScreenshot(`hero-${theme}.png`, {
        mask: [page.locator('dwc-score-dial')],
      });
    });

    test(`the full report looks right (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await runDiagnostic(page);

      await expect(page).toHaveScreenshot(`report-${theme}.png`, {
        fullPage: true,
        mask: volatileRegions(page),
      });
    });

    test(`an expanded check looks right (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await runDiagnostic(page);

      const first = checkRows(page).first();
      await first.locator('button.summary').click();

      await expect(first).toHaveScreenshot(`check-expanded-${theme}.png`, {
        mask: [first.locator('.headline'), first.locator('td.value')],
      });
    });
  }

  test('the mobile drawer looks right when open', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-mobile',
      'The drawer only exists below the desktop breakpoint.',
    );

    await openApp(page);
    await page.locator('.menu-button, button[aria-label*="menu" i]').first().click();

    await expect(page).toHaveScreenshot('drawer-open.png');
  });
});

test.describe('reduced motion', () => {
  test('renders the final score immediately, with no count-up', async ({ page }) => {
    /*
     * Not a snapshot test: the point is that the *value* is correct at every
     * instant, because someone may read or screenshot it mid-flight. Under reduced
     * motion the dial must skip the animation entirely rather than animate faster.
     *
     * Emulated per-page rather than via `test.use` so the preference is set before
     * the dial ever reads `matchMedia`, and so the assertion is explicit about what
     * it depends on.
     */
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await openApp(page);
    await runDiagnostic(page);

    const meter = page.locator('dwc-score-dial [role="meter"]');
    const announced = Number(await meter.getAttribute('aria-valuenow'));
    const displayed = Number((await page.locator('dwc-score-dial .number').innerText()).trim());

    expect(displayed).toBe(announced);
  });
});
