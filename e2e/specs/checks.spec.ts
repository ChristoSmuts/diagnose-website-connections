import { expect, test } from '@playwright/test';
import { checkRows, openApp, runDiagnostic } from '../support/app.js';

/**
 * Layer 3: the technical depth behind each individual check.
 *
 * These assert the thing that distinguishes a check from a finding — that
 * inspecting a *passing* check is worthwhile — and that the provenance badging
 * survives all the way to the rendered table.
 */
test.describe('inspecting individual checks', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);
  });

  test('summarises passes, problems and inconclusive results', async ({ page }) => {
    await expect(page.locator('text=/\\d+ passed, \\d+ worth attention/')).toBeVisible();
  });

  test('groups checks by the stage of the request they belong to', async ({ page }) => {
    // Reading down the list follows the request itself, rather than an arbitrary
    // protocol ordering the reader has to already know.
    await expect(page.locator('text=Finding the address').first()).toBeVisible();
    await expect(page.locator('text=Securing the connection').first()).toBeVisible();
  });

  test('expanding a check reveals real technical detail', async ({ page }) => {
    const first = checkRows(page).first();
    const toggle = first.locator('button.summary');

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Layer 3 is deliberately not simplified, so the explanation should be
    // substantial prose rather than a restatement of the one-line summary.
    const technical = first.locator('.technical');
    await expect(technical).toBeVisible();
    expect((await technical.innerText()).length).toBeGreaterThan(120);
  });

  test('a passing check is still worth expanding', async ({ page }) => {
    /*
     * The specific gap this feature closed: before checks existed, a healthy site
     * produced no findings and therefore nothing to inspect at all.
     */
    const passing = checkRows(page)
      .filter({ has: page.locator('dwc-icon[label="Pass"]') })
      .first();
    await expect(passing).toBeVisible();

    await passing.locator('button.summary').click();
    const technical = passing.locator('.technical');
    await expect(technical).toBeVisible();
    expect((await technical.innerText()).length).toBeGreaterThan(80);
  });

  test('marks any value it could not measure, rather than implying it observed it', async ({
    page,
  }) => {
    // Self-hosted, so the client checks cannot be measured. Expanding one must show
    // the honest state rather than a number.
    const clientCheck = checkRows(page).filter({ hasText: 'Your connection latency' }).first();

    await clientCheck.locator('button.summary').click();
    await expect(clientCheck).toContainText(/your own machine|not run/i);
  });

  /*
   * Note the selector: `dwc-button`, not `button`.
   *
   * The inner <button> lives in the component's shadow root and contains only a
   * <slot>, so its text content is empty — `button:has-text(...)` never matches.
   * The label is light-DOM content of the custom element, which is also where the
   * click handler is bound.
   */
  test('the problems-only filter hides passing checks and restores them', async ({ page }) => {
    const total = await checkRows(page).count();

    await page.locator('dwc-button:has-text("Only show problems")').click();
    const filtered = await checkRows(page).count();
    expect(filtered).toBeLessThan(total);

    await page.locator('dwc-button:has-text("Show all checks")').click();
    await expect(checkRows(page)).toHaveCount(total);
  });

  test('keeps a check open across a filter change', async ({ page }) => {
    /*
     * Open state is held by the report rather than by each row precisely so this
     * works: toggling the filter re-renders the list, and Lit reuses DOM across
     * that render, so per-row state would silently collapse.
     */
    const problem = checkRows(page)
      .filter({ has: page.locator('dwc-icon[label="Worth improving"]') })
      .first();

    await problem.locator('button.summary').click();
    await expect(problem.locator('button.summary')).toHaveAttribute('aria-expanded', 'true');

    await page.locator('dwc-button:has-text("Only show problems")').click();

    const stillOpen = checkRows(page)
      .filter({ has: page.locator('dwc-icon[label="Worth improving"]') })
      .first();
    await expect(stillOpen.locator('button.summary')).toHaveAttribute('aria-expanded', 'true');
  });

  test('checks are operable by keyboard alone', async ({ page }) => {
    const toggle = checkRows(page).first().locator('button.summary');

    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
