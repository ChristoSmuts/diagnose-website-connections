import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { checkRows, openApp, runDiagnostic, setTheme } from '../support/app.js';

/**
 * Accessibility is treated as a requirement, not a score to improve later.
 *
 * Both themes are audited because contrast is the failure mode most likely to be
 * introduced by a visual change, and the dark palette is a separate set of token
 * values — passing in light says nothing about dark.
 *
 * axe cannot judge whether the reading order makes sense or whether a label is
 * meaningful, so the keyboard and focus assertions below cover what it cannot.
 */

async function audit(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    // WCAG 2.2 AA is the floor for this project.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  /**
   * Report the rule, the element, and — for contrast — the measured ratio and the
   * two colours involved.
   *
   * A bare count or rule name means re-running locally to find out anything. axe
   * has already computed the exact figures, so a CI log should carry them.
   */
  const summary = results.violations.map((v) => {
    const nodes = v.nodes.map((n) => {
      const target = n.target.join(' ');
      const contrast = n.any.find((c) => c.id === 'color-contrast')?.data as
        | {
            contrastRatio?: number;
            expectedContrastRatio?: string;
            fgColor?: string;
            bgColor?: string;
          }
        | undefined;

      if (contrast?.contrastRatio === undefined) return `    ${target}`;
      return (
        `    ${target}\n` +
        `      ${String(contrast.contrastRatio)}:1 (needs ${contrast.expectedContrastRatio ?? '?'}) ` +
        `fg ${contrast.fgColor ?? '?'} on bg ${contrast.bgColor ?? '?'}`
      );
    });

    return `${v.id} (${v.impact ?? 'unknown'}): ${v.help}\n${nodes.join('\n')}`;
  });

  expect(summary, `axe violations — ${context}`).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility in ${theme} mode`, () => {
    test(`the empty state has no violations (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await audit(page, `empty state, ${theme}`);
    });

    test(`a full report has no violations (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await runDiagnostic(page);
      await audit(page, `report, ${theme}`);
    });

    test(`an expanded check has no violations (${theme})`, async ({ page }) => {
      await openApp(page);
      await setTheme(page, theme);
      await runDiagnostic(page);

      // Expanded detail introduces a table and provenance abbreviations, which are
      // the parts most likely to be missing structure.
      await checkRows(page).first().locator('button.summary').click();
      await audit(page, `expanded check, ${theme}`);
    });
  });
}

test.describe('keyboard and focus', () => {
  test('every interactive element in the empty state is reachable by keyboard', async ({
    page,
  }) => {
    await openApp(page);

    const reached: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const description = await page.evaluate(() => {
        // Focus can land inside a shadow root, so walk activeElement down.
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        return el === null ? 'none' : `${el.tagName.toLowerCase()}`;
      });
      reached.push(description);
    }

    // The URL input and the run button must both be tab-reachable.
    expect(reached).toContain('input');
    expect(reached.some((t) => t === 'button')).toBe(true);
  });

  test('focus is always visible, never removed by a restyle', async ({ page }) => {
    await openApp(page);

    const input = page.locator('dwc-url-input input');
    await input.focus();

    // The base rule in tailwind.css applies a box-shadow focus ring. A component
    // that restyled focus away would show `none` here.
    const shadow = await input.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe('none');
    expect(shadow.length).toBeGreaterThan(0);
  });

  test('charts carry a text equivalent for screen readers', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    // An SVG waterfall is meaningless to a screen reader without one.
    const waterfall = page.locator('dwc-waterfall');
    await expect(waterfall).toBeVisible();
    await expect(waterfall.locator('.sr-only, table')).not.toHaveCount(0);
  });

  test('the score dial announces its value, not its shape', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    const meter = page.locator('dwc-score-dial [role="meter"]');
    await expect(meter).toHaveAttribute('aria-valuenow', /\d+/);
    await expect(meter).toHaveAttribute('aria-label', /out of 100/);
  });
});
