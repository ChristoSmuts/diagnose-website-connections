import { expect, test } from '@playwright/test';
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

    // The scrim dismisses it, which is the expected gesture on a phone.
    await page.locator('.scrim').click();
    await expect(drawer).not.toHaveAttribute('data-open', 'true');
  });
});
