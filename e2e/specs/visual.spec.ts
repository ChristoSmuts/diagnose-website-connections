import { expect, test } from '@playwright/test';
import { contentClip, openApp, setTheme, verdictHeadline } from '../support/app.js';
import { readVisualFixture } from '../support/visual-fixture.js';

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
 *     baselines taken on Windows or macOS can never match CI. Regenerate them
 *     with `./scripts/update-visual-baselines.sh`, which runs the official
 *     Playwright container locally, or with the update-snapshots CI job.
 *  2. **Volatile regions are masked.** Latency figures, timestamps and the health
 *     score change every run against the live internet, and comparing them would
 *     fail for reasons that have nothing to do with the design.
 */
test.describe('visual regression', () => {
  test.skip(
    process.platform !== 'linux',
    'Snapshot baselines are Linux-only — run ./scripts/update-visual-baselines.sh, or the update-snapshots CI job.',
  );

  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'One viewport is enough to catch a page that failed to render; layout has its own specs.',
  );

  /**
   * Reduced motion, so nothing is mid-flight when the shutter opens.
   *
   * The score dial counts up in JavaScript, which `animations: 'disabled'` does
   * not reach — that option settles CSS animations and transitions, not a
   * requestAnimationFrame loop. Under this preference the dial renders its final
   * value immediately, which the spec below asserts independently. Every duration
   * token collapses to 1 ms too, so transitions are finished rather than merely
   * frozen part-way.
   *
   * This is what makes the shots below need no masks at all.
   *
   * Emulated per page rather than through `test.use`, so the preference is in
   * place before the dial ever reads `matchMedia` — the same reason the spec at
   * the bottom of this file does it this way.
   */
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  /**
   * The empty state, clipped to the content column.
   *
   * Nothing here comes off the network — no diagnostic has run — so the only
   * thing that ever varied was the sidebar, and the clip removes it.
   */
  test('the empty state looks right', async ({ page }) => {
    await openApp(page);
    await setTheme(page, 'light');

    await expect(page).toHaveScreenshot('empty-light.png', { clip: await contentClip(page) });
  });

  /**
   * Both themes for the report, because a theme that stops applying is exactly
   * the failure this is here for and it shows up in the palette rather than the
   * structure.
   *
   * A *seeded* report, not a fresh diagnostic. Photographing a live one meant
   * photographing whatever the target was doing that minute: a few tens of
   * milliseconds either way flips the verdict, and with it the headline, the
   * findings and the banner's entire background colour. See `global-setup.ts`.
   *
   * Nothing is masked, and that is the payoff. While these ran against a live
   * target, almost everything worth looking at had to be hidden — the score, the
   * vantage tiles, the waterfall, every check headline and the verdict paragraph
   * — which left a comparison of the page's furniture and little else. A stored
   * verdict renders identically every time, so the whole content column is under
   * comparison: the score really is that number, the tiles really are in that
   * arrangement, and a token that changes colour is caught rather than covered up.
   *
   * The one genuinely time-dependent thing on the page, the "Checked <date>"
   * footer, sits far below the clip.
   */
  for (const theme of ['light', 'dark'] as const) {
    test(`the full report looks right (${theme})`, async ({ page }) => {
      await page.goto(`/report/${readVisualFixture()}`);
      await setTheme(page, theme);
      await expect(verdictHeadline(page)).not.toBeEmpty();

      await expect(page).toHaveScreenshot(`report-${theme}.png`, {
        clip: await contentClip(page),
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

    // The seeded report again: this asserts the dial's behaviour, not the
    // engine's, and a stored verdict renders it through the same path without
    // spending ten seconds on a live probe.
    await page.goto(`/report/${readVisualFixture()}`);

    const meter = page.locator('dwc-score-dial [role="meter"]');
    const announced = Number(await meter.getAttribute('aria-valuenow'));
    const displayed = Number((await page.locator('dwc-score-dial .number').innerText()).trim());

    expect(displayed).toBe(announced);
  });
});
