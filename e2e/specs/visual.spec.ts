import { expect, test } from '@playwright/test';
import { openApp, runDiagnostic, setTheme, volatileRegions } from '../support/app.js';

/**
 * Three snapshots, and deliberately only three.
 *
 * This suite used to take nine per browser project — the empty state, the verdict
 * banner, the whole report and an expanded check, in both themes, plus the mobile
 * drawer. It had no committed baselines at all, so it skipped on Windows and would
 * have created-and-failed on Linux: a gate that read as coverage and provided
 * none.
 *
 * The reason for cutting rather than generating all of them is what the rest of
 * this suite has proved. Every real layout bug here was caught by *measuring* —
 * the status dot that was an oval, the report that scrolled sideways at 320px,
 * the print stylesheet that could never open a collapsed check. None of those
 * needed a reference image, and all of them produce a failure that names the
 * offending element instead of showing a diff to squint at.
 *
 * What pixels are uniquely good at is catching the catastrophe no assertion
 * thinks to look for: a stylesheet that failed to load, a theme that stopped
 * applying, a page that renders blank. Three images cover that. The other six
 * mostly generated churn, because they changed every time the design did.
 *
 * Two constraints remain:
 *
 *  1. **Linux-only baselines.** Font rasterisation differs by platform, so
 *     baselines taken on Windows or macOS can never match CI. See
 *     `.github/workflows/ci.yml` for the job that regenerates them.
 *  2. **Volatile regions are masked.** Latency figures, timestamps and the health
 *     score change every run against the live internet, and comparing them would
 *     fail for reasons that have nothing to do with the design.
 */
test.describe('visual regression', () => {
  test.skip(
    process.platform !== 'linux',
    'Snapshot baselines are Linux-only — regenerate them with the update-snapshots CI job.',
  );

  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'One viewport is enough to catch a page that failed to render; layout has its own specs.',
  );

  test('the empty state looks right', async ({ page }) => {
    await openApp(page);
    await setTheme(page, 'light');
    await expect(page).toHaveScreenshot('empty-light.png', { fullPage: true });
  });

  /**
   * Both themes for the report, because a theme that stops applying is exactly
   * the failure this is here for and it shows up in the palette rather than the
   * structure.
   */
  for (const theme of ['light', 'dark'] as const) {
    test(`the full report looks right (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await runDiagnostic(page);

      await expect(page).toHaveScreenshot(`report-${theme}.png`, {
        fullPage: true,
        mask: volatileRegions(page),
      });
    });
  }
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
