import { expect, test, type Page } from '@playwright/test';
import { openApp, openSidebar, runDiagnostic, verdictHeadline } from '../support/app.js';

/**
 * The full lifecycle of stored sites and reports.
 *
 * Serial by design: the whole point is that state accumulates and survives, so
 * isolating each step behind its own fixture would test the opposite of what
 * matters. Each test picks up where the previous one left off.
 *
 * The load-bearing assertion is that a re-run creates a *second* report rather
 * than editing the first. Reports are immutable and append-only, which is what
 * makes per-site history and future trend charts possible at all.
 */
test.describe.configure({ mode: 'serial' });

const SITE = 'example.com';
const RENAMED = 'Renamed by a test';

const nav = (page: Page) => page.locator('dwc-nav-tree');

/** Site actions are exposed with explicit aria-labels, so specs target those. */
const siteAction = (page: Page, action: string, label: string) =>
  nav(page).getByRole('button', { name: `${action} ${label}` });

test.describe('sites and report history', () => {
  test('a first diagnostic saves the site', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page, SITE);

    await expect(nav(page)).toContainText(SITE);
  });

  test('re-running adds a second report instead of replacing the first', async ({ page }) => {
    await openApp(page);

    // Expand the site to reveal its report list.
    await openSidebar(page);
    await siteAction(page, 'Expand', SITE).click();
    const reportsBefore = await nav(page).getByRole('treeitem').count();

    await openSidebar(page);

    await siteAction(page, 'Run a new check for', SITE).click();
    await expect(verdictHeadline(page)).not.toBeEmpty({ timeout: 75_000 });

    await expect
      .poll(async () => nav(page).getByRole('treeitem').count(), { timeout: 20_000 })
      .toBeGreaterThan(reportsBefore);
  });

  test('a site label can be renamed', async ({ page }) => {
    await openApp(page);

    // Rename uses a native prompt, which Playwright must answer explicitly.
    page.once('dialog', (dialog) => void dialog.accept(RENAMED));
    await openSidebar(page);
    await siteAction(page, 'Rename', SITE).click();

    await expect(nav(page)).toContainText(RENAMED);
  });

  test('archiving moves the site out of the main tree', async ({ page }) => {
    await openApp(page);

    await openSidebar(page);

    await siteAction(page, 'Archive', RENAMED).click();

    // Archived sites leave the main tree but are never hidden outright.
    await expect(nav(page)).not.toContainText(RENAMED);
  });

  test('the archived view lists it and can restore it', async ({ page }) => {
    await openApp(page);

    // The archived view swaps what the sidebar lists rather than taking over the
    // main pane — archived items are moved out of the way, never hidden.
    await openSidebar(page);
    await page.getByRole('button', { name: /view archived/i }).click();
    await expect(page.locator('.sidebar-title')).toHaveText(/archived/i);
    await expect(nav(page)).toContainText(RENAMED);

    await openSidebar(page);

    await siteAction(page, 'Restore', RENAMED).click();

    // The toggle is the same control with a different label once it is showing
    // the archived list.
    await page.getByRole('button', { name: /back to your sites/i }).click();
    await expect(nav(page)).toContainText(RENAMED);
  });

  test('everything survives a reload, proving it is persisted', async ({ page }) => {
    await openApp(page);
    await expect(nav(page)).toContainText(RENAMED);

    await page.reload();
    await expect(nav(page)).toContainText(RENAMED);
  });

  test('deleting asks for confirmation and then removes it for good', async ({ page }) => {
    await openApp(page);

    await openSidebar(page);

    await siteAction(page, 'Delete', RENAMED).click();

    /*
     * Delete is a genuine hard delete, so it is confirmed through a real,
     * focus-trapped dialog rather than a native confirm().
     *
     * The assertion targets the inner native <dialog>, not the custom element:
     * dwc-dialog wraps `<dialog>` and calls showModal(), so the host itself has no
     * box of its own and never reports as visible.
     */
    const dialog = page.locator('dwc-dialog dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /delete/i }).click();

    await expect(nav(page)).not.toContainText(RENAMED);

    // Hard delete means it does not reappear in the archived view either.
    await openSidebar(page);
    await page.getByRole('button', { name: /view archived/i }).click();
    await expect(page.locator('main')).not.toContainText(RENAMED);
  });
});
