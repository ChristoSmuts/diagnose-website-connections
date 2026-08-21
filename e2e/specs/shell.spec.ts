import { expect, test } from '@playwright/test';
import {
  ensureSiteExpanded,
  openApp,
  openSidebar,
  runDiagnostic,
  SECOND_TARGET,
  verdictHeadline,
} from '../support/app.js';

/**
 * Behaviours that only exist once you use the app for more than one thing:
 * coming back to it, putting the sidebar away, and clearing out old runs.
 */

test.describe('a report survives a reload', () => {
  /**
   * Refresh used to cold-start to the hero and discard whatever you were reading,
   * which made the saved history much less useful than it looks.
   */
  test('reloading returns you to the same report', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    await expect(page).toHaveURL(/\/report\/[\w-]+$/);
    const url = page.url();
    const headline = await verdictHeadline(page).textContent();

    await page.reload();

    await expect(page).toHaveURL(url);
    await expect(verdictHeadline(page)).toHaveText(headline ?? '');
  });

  test('back returns to the hero and forward comes again', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('dwc-url-input input')).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/report\/[\w-]+$/);
  });

  /**
   * A report URL outlives the report it names — deleted, or from someone else's
   * instance. A blank page under a URL that will never work again is the worst
   * possible answer.
   */
  test('a report id that no longer exists lands on the hero, explained', async ({ page }) => {
    await page.goto('/report/00000000-0000-0000-0000-000000000000');

    await expect(page.locator('dwc-url-input input')).toBeVisible();
    await expect(page.locator('[role="alert"]')).toContainText(/no longer exists/i);
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('the sidebar collapses', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'The persistent sidebar only exists above the desktop breakpoint.',
  );

  test('collapses to a rail and is remembered across a reload', async ({ page }) => {
    await openApp(page);

    const aside = page.locator('dwc-app').locator('aside');
    const expanded = (await aside.boundingBox())?.width ?? 0;
    expect(expanded).toBeGreaterThan(200);

    await page.getByRole('button', { name: /collapse the sidebar/i }).click();

    // Asserted on measured width rather than on the attribute: the attribute can
    // be set while the grid track that decides the real width is not.
    await expect
      .poll(async () => (await aside.boundingBox())?.width ?? 0)
      .toBeLessThan(expanded / 2);

    await page.reload();
    expect((await aside.boundingBox())?.width ?? 0).toBeLessThan(expanded / 2);

    // The way back has to stay reachable, or the rail is a trap.
    await page.getByRole('button', { name: /expand the sidebar/i }).click();
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  });
});

test.describe('clearing out old runs', () => {
  /*
   * These count a site's reports, so they use a host of their own: history.spec
   * renames and then hard-deletes HEALTHY_TARGET's site out from under anything
   * sharing it.
   */
  const TARGET = SECOND_TARGET;

  test('a past report can be deleted from the sidebar', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page, TARGET);

    await openSidebar(page);
    const nav = page.locator('dwc-nav-tree');

    // A second run, so there is history to delete from rather than one lone row.
    // Driven from the sidebar rather than the hero, which a rendered report
    // replaces — reports are append-only, so this is a new row every time.
    await nav
      .getByRole('button', { name: new RegExp(`Run a new check for ${TARGET}`, 'i') })
      .click();
    await expect(verdictHeadline(page)).not.toBeEmpty({ timeout: 75_000 });

    // Starting a run closes the drawer on purpose, so it has to be reopened.
    await openSidebar(page);
    await ensureSiteExpanded(page, TARGET);

    await expect.poll(async () => await nav.locator('.report-row').count()).toBeGreaterThan(1);
    const before = await nav.locator('.report-row').count();

    await nav
      .getByRole('button', { name: /Delete the check from/i })
      .first()
      .click();

    const dialog = page.locator('dwc-dialog dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /delete/i }).click();

    // The list must update itself. Refreshing only the site list left the row that
    // had just been deleted on screen until the user collapsed the site.
    await expect.poll(async () => await nav.locator('.report-row').count()).toBe(before - 1);
  });

  test('a past report can be archived and brought back', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page, TARGET);

    await openSidebar(page);
    const nav = page.locator('dwc-nav-tree');
    await ensureSiteExpanded(page, TARGET);
    await expect.poll(async () => await nav.locator('.report-row').count()).toBeGreaterThan(0);

    // Relative to what is there, not to zero: the suite shares one database, so
    // earlier tests have already left runs against this host.
    const before = await nav.locator('.report-row').count();

    await nav
      .getByRole('button', { name: /Archive the check from/i })
      .first()
      .click();
    await expect.poll(async () => await nav.locator('.report-row').count()).toBe(before - 1);

    /*
     * The archived view lists every site, not only archived ones — a report can be
     * archived while its site stays active, and listing only archived sites left
     * those reports with nowhere to appear.
     */
    await openSidebar(page);
    await page.getByRole('button', { name: /view archived/i }).click();

    // Switching lists collapses the tree — that reset is deliberate: expansion used
    // to survive the switch and show an empty history, because the cache is cleared
    // and nothing re-requested it.
    await ensureSiteExpanded(page, TARGET);

    await expect
      .poll(async () => await nav.getByRole('button', { name: /Restore the check from/i }).count())
      .toBeGreaterThan(0);

    await nav
      .getByRole('button', { name: /Restore the check from/i })
      .first()
      .click();
    // Switching lists collapses the tree on purpose, so expand again to look.
    await openSidebar(page);
    await page.getByRole('button', { name: /back to your sites/i }).click();
    await ensureSiteExpanded(page, TARGET);
    await expect.poll(async () => await nav.locator('.report-row').count()).toBeGreaterThan(0);
  });
});

test.describe('the theme control follows the viewport', () => {
  test('lives in the header on a desktop', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) < 960, 'Desktop layout only.');
    await openApp(page);

    // Exactly one, never two: a duplicate would be a second tab stop and a second
    // thing for a screen reader to announce for one setting.
    await expect(page.locator('dwc-theme-toggle')).toHaveCount(1);
    await expect(page.locator('dwc-app').locator('header dwc-theme-toggle')).toHaveCount(1);
  });

  test('lives in the drawer on a phone', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) >= 960, 'Mobile layout only.');
    await openApp(page);

    await expect(page.locator('dwc-theme-toggle')).toHaveCount(1);
    await expect(page.locator('dwc-app').locator('header dwc-theme-toggle')).toHaveCount(0);
    await expect(page.locator('dwc-app').locator('aside dwc-theme-toggle')).toHaveCount(1);
  });
});

test.describe('the site health dot', () => {
  /*
   * It shipped as an oval leaning right. The favicon clipped its own contents so
   * remote artwork could not spill, and the dot was positioned to overhang that
   * same box — so the clip took the dot's right and bottom edges and all of its
   * ring with them.
   *
   * getBoundingClientRect() reports the unclipped geometry, exactly as it does
   * for a .sr-only element, so a size assertion on its own would have passed
   * against the bug. The clipping has to be asserted separately.
   */
  test('is round, and nothing between it and the row clips it', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page, SECOND_TARGET);
    await openSidebar(page);

    const dot = page.locator('dwc-nav-tree').locator('.favicon .status-dot').first();
    await expect(dot).toBeAttached();

    const box = await dot.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBeCloseTo(box.height, 1);

    // Every ancestor up to the shadow root — parentElement stops there by itself.
    const clipping = await dot.evaluate((el) => {
      const offenders: string[] = [];
      for (let node = el.parentElement; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).overflow !== 'visible') {
          offenders.push(node.className === '' ? node.tagName : node.className);
        }
      }
      return offenders;
    });
    expect(clipping).toEqual([]);
  });
});

test.describe('the site health dot in the rail', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'The rail only exists above the desktop breakpoint.',
  );

  test('stays inside the rail when the sidebar is collapsed', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page, SECOND_TARGET);

    await page.getByRole('button', { name: /collapse the sidebar/i }).click();

    const aside = page.locator('dwc-app').locator('aside');
    const dot = page.locator('dwc-nav-tree').locator('.favicon .status-dot').first();
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeLessThan(120);

    // The collapsed aside sets overflow-x: hidden, which is a second clipping
    // ancestor the component itself cannot see. The dot has to fit within it.
    const railBox = await aside.boundingBox();
    const dotBox = await dot.boundingBox();
    expect(railBox).not.toBeNull();
    expect(dotBox).not.toBeNull();
    expect(dotBox!.x).toBeGreaterThanOrEqual(railBox!.x);
    expect(dotBox!.x + dotBox!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width);
  });
});
