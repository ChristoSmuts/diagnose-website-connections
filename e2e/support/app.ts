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

/**
 * A second stable host, for specs that need a site of their own.
 *
 * The suite deliberately shares one database so history accumulates the way it
 * does in real use, but `history.spec` renames and then hard-deletes
 * HEALTHY_TARGET's site. Any other spec counting that site's reports is racing
 * it — which is exactly what happened, and only on the last project to run.
 */
export const SECOND_TARGET = 'example.net';

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

/**
 * Opens the sidebar when it is a drawer, and does nothing when it is not.
 *
 * Below the desktop breakpoint the sidebar is off-canvas and inert, so anything
 * inside it — site actions, report history — is genuinely unreachable until the
 * drawer is opened. A spec that clicks straight into the tree passes on a desktop
 * viewport and hangs on a phone, which is exactly what happened.
 */
export async function openSidebar(page: Page): Promise<void> {
  const menu = page.locator('.menu-button');
  if (!(await menu.isVisible())) return;
  if ((await menu.getAttribute('aria-expanded')) === 'true') return;
  await menu.click();
  await expect(page.locator('aside[data-open="true"]')).toBeVisible();
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

/**
 * Opens a site's history, whether or not it is already open.
 *
 * The tree reveals whichever site is current, so after a run the site being
 * tested is usually expanded already and its disclosure reads "Collapse …".
 * Specs that clicked "Expand …" unconditionally then waited on a button that no
 * longer existed. Clicking it anyway would have been worse than the timeout: it
 * would have closed the very list the spec was about to count.
 */
export async function ensureSiteExpanded(page: Page, host: string): Promise<void> {
  const nav = page.locator('dwc-nav-tree');
  // Named for the host: the suite shares one database, so a bare /Expand /
  // matches more than one row.
  const expand = nav.getByRole('button', { name: new RegExp(`Expand ${host}`, 'i') });
  if ((await expand.count()) > 0) await expand.first().click();

  await expect(
    nav.getByRole('button', { name: new RegExp(`Collapse ${host}`, 'i') }).first(),
  ).toBeVisible();
}

export function sidebarSites(page: Page): Locator {
  return page.locator('dwc-nav-tree');
}

/**
 * The content column as a fixed rectangle, with the sidebar left out.
 *
 * Masking the tree was not enough, and the reason is worth recording: a mask
 * hides an element's *content*, not its *size*. Every spec shares one database
 * and `visual.spec` sorts last, so the sidebar it screenshots holds whatever the
 * earlier specs left behind — while baselines are regenerated from a run of
 * `visual.spec` alone, where the tree reads "No sites yet." One line of text
 * against five site rows is a different height whether it is masked or not, and
 * every comparison failed on it.
 *
 * Clipping to a rectangle fixes both halves of that: the sidebar is outside the
 * image entirely, and the rectangle is the same size on every run regardless of
 * what is in the page. The sidebar keeps its own coverage in `layout.spec` and
 * `shell.spec`, which assert its geometry by measuring — which is the better
 * instrument for it anyway.
 */
export async function contentClip(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const box = await page.locator('main').boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) {
    throw new Error('contentClip needs a rendered <main> and a fixed viewport');
  }

  // Full viewport height rather than the element's: the element grows with the
  // report's findings, and that is the other thing no mask can absorb.
  return {
    x: Math.round(box.x),
    y: 0,
    width: Math.round(Math.min(box.width, viewport.width - box.x)),
    height: viewport.height,
  };
}
