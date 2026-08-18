import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Helpers shared by every spec.
 *
 * Playwright's selector engine pierces shadow DOM automatically for CSS
 * selectors, so `page.locator('dwc-url-input input')` reaches inside the shadow
 * root without any `>>>` plumbing. That is why these helpers are thin — they exist
 * to name intent, not to work around encapsulation.
 */

/** A host reachable from CI and stable enough to assert a healthy verdict against. */
export const HEALTHY_TARGET = 'example.com';

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('dwc-url-input input')).toBeVisible();
}

/**
 * Force a theme, bypassing the OS preference.
 *
 * Sets the attribute the app's own pre-paint script sets, so this exercises the
 * real `[data-theme]` code path rather than only the media-query one — the two are
 * separate blocks in the token sheet and can drift apart.
 */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
}

/**
 * Run a diagnostic and wait for the verdict.
 *
 * Waits on the verdict banner having real text rather than on a fixed timeout: the
 * report streams in over SSE, so the completion signal is content appearing, not
 * time passing.
 */
export async function runDiagnostic(page: Page, target = HEALTHY_TARGET): Promise<void> {
  await page.locator('dwc-url-input input').fill(target);
  await page.locator('dwc-url-input input').press('Enter');
  await expect(verdictHeadline(page)).not.toBeEmpty({ timeout: 75_000 });
}

export function verdictBanner(page: Page): Locator {
  return page.locator('dwc-verdict-banner');
}

export function verdictHeadline(page: Page): Locator {
  return page.locator('dwc-verdict-banner h2');
}

export function scoreDial(page: Page): Locator {
  return page.locator('dwc-score-dial [role="meter"]');
}

export function checkRows(page: Page): Locator {
  return page.locator('dwc-check-row');
}

export function sidebarSites(page: Page): Locator {
  return page.locator('dwc-nav-tree');
}

/**
 * Regions whose text changes every run and must be masked before a screenshot.
 *
 * Latency figures, timestamps and the score itself are all genuinely variable
 * against the live internet. Without masking, visual regression would fail on
 * every run for reasons that have nothing to do with the design — which is how a
 * visual suite gets disabled and stops protecting anything.
 */
export function volatileRegions(page: Page): Locator[] {
  return [
    page.locator('dwc-score-dial'),
    page.locator('dwc-vantage-tile'),
    page.locator('dwc-waterfall'),
    page.locator('dwc-check-row .headline'),
    page.locator('.meta'),
  ];
}
