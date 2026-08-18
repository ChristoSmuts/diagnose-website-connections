import { expect, test, type Page } from '@playwright/test';
import { openApp, runDiagnostic } from '../support/app.js';

/**
 * Layout behaviours that are easy to break and invisible to a unit test.
 *
 * The sticky sidebar regressed twice from the same two causes, so it is asserted
 * on geometry rather than on CSS declarations — computed style can say
 * `position: sticky` while the element still scrolls away.
 */
test.describe('desktop shell', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'The persistent sidebar only exists above the desktop breakpoint.',
  );

  test('the sidebar stays put while the report scrolls past it', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    const geometry = await page.evaluate(() => {
      const shadow = document.querySelector('dwc-app')?.shadowRoot;
      const aside = shadow?.querySelector('aside');
      const header = shadow?.querySelector('header');
      if (!aside || !header) throw new Error('shell not rendered');

      const before = aside.getBoundingClientRect().top;

      // Instant: global.css sets scroll-behavior: smooth, so an animated scroll
      // would still be in flight when the measurement is taken — which once made
      // this look broken when it was not.
      window.scrollTo({ top: 1500, behavior: 'instant' });

      return new Promise<{
        before: number;
        after: number;
        headerBottom: number;
        scrolled: number;
      }>((resolve) => {
        requestAnimationFrame(() => {
          resolve({
            before: Math.round(before),
            after: Math.round(aside.getBoundingClientRect().top),
            headerBottom: Math.round(header.getBoundingClientRect().bottom),
            scrolled: Math.round(window.scrollY),
          });
        });
      });
    });

    // The page really did scroll, so the assertion below is not vacuous.
    expect(geometry.scrolled).toBeGreaterThan(500);

    // And the sidebar did not move with it.
    expect(geometry.after).toBe(geometry.before);

    // It sits flush against the header rather than tucking underneath it or
    // leaving a gap — the failure mode when the sticky offset and the header
    // height are written as separate literals.
    expect(geometry.after).toBe(geometry.headerBottom);
  });

  test('the sticky offset matches the header height exactly', async ({ page }) => {
    await openApp(page);

    const { headerHeight, stickyTop } = await page.evaluate(() => {
      const shadow = document.querySelector('dwc-app')?.shadowRoot;
      const aside = shadow?.querySelector('aside');
      const header = shadow?.querySelector('header');
      if (!aside || !header) throw new Error('shell not rendered');

      return {
        headerHeight: Math.round(header.getBoundingClientRect().height),
        stickyTop: Math.round(parseFloat(getComputedStyle(aside).top)),
      };
    });

    // Both derive from --dwc-header-height; this is what keeps them honest.
    expect(stickyTop).toBe(headerHeight);
  });
});

test.describe('mobile shell', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) >= 960,
    'The drawer only exists below the desktop breakpoint.',
  );

  test('the sidebar is a drawer that opens and closes', async ({ page }) => {
    await openApp(page);

    const drawer = page.locator('dwc-app').locator('aside');
    const menu = page.locator('.menu-button');

    // Off-canvas by default so the report gets the full viewport.
    await expect(menu).toBeVisible();

    await menu.click();
    await expect(page.locator('aside[data-open="true"]')).toBeVisible();

    /*
     * The scrim dismisses it, which is the expected gesture on a phone.
     *
     * Clicked near its right edge rather than at its centre: the scrim spans the
     * viewport but the drawer sits on top of its left portion, so a centre click
     * lands on the drawer and is intercepted — which is true for a real thumb too.
     */
    const scrim = page.locator('.scrim');
    const box = await scrim.boundingBox();
    await scrim.click({ position: { x: (box?.width ?? 400) - 20, y: 200 } });
    await expect(drawer).not.toHaveAttribute('data-open', 'true');
  });
});

/**
 * Nothing may make the page scroll sideways.
 *
 * Reported from a real phone, and impossible to find by reading CSS — several
 * candidates looked guilty and were not. Asserting the document's own scroll
 * width names the culprit instead of leaving it to inspection, and keeps it named
 * if it ever comes back.
 */
test.describe('no horizontal overflow', () => {
  const WIDTHS = [320, 360, 390];

  /**
   * Every element wider than the viewport, with enough identity to find it.
   *
   * Returning the offenders rather than a bare boolean is the whole point: a
   * failing assertion that says "scrollWidth 412 > 390" sends you back to reading
   * stylesheets, which is exactly what did not work the first time.
   */
  const overflowing = (page: Page) =>
    page.evaluate(() => {
      const found: string[] = [];
      const limit = document.documentElement.clientWidth;

      const walk = (root: Document | ShadowRoot): void => {
        for (const element of root.querySelectorAll('*')) {
          const box = element.getBoundingClientRect();
          // Right edge past the viewport, and wide enough to be real rather than
          // a sub-pixel rounding artefact.
          if (box.right > limit + 1 && box.width > 1) {
            const id = element.id === '' ? '' : `#${element.id}`;
            const cls =
              typeof element.className === 'string' && element.className !== ''
                ? `.${element.className.trim().split(/\s+/).join('.')}`
                : '';
            found.push(
              `${element.tagName.toLowerCase()}${id}${cls} right=${Math.round(box.right)} limit=${limit}`,
            );
          }
          if (element.shadowRoot !== null) walk(element.shadowRoot);
        }
      };

      walk(document);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: limit,
        offenders: found.slice(0, 12),
      };
    });

  for (const width of WIDTHS) {
    test(`the hero fits at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp(page);

      const result = await overflowing(page);
      expect(result.offenders, result.offenders.join('\n')).toEqual([]);
      expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
    });

    test(`a full report fits at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp(page);
      await runDiagnostic(page);

      // Checks carry the widest content in the app — evidence tables of cipher
      // suites, header values and IP addresses — so expand one before measuring.
      await page.locator('dwc-check-row').first().click();

      const result = await overflowing(page);
      expect(result.offenders, result.offenders.join('\n')).toEqual([]);
      expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
    });
  }
});
