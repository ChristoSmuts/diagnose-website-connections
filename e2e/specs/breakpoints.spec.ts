import { expect, test, type Page } from '@playwright/test';
import { openApp, runDiagnostic, setTheme } from '../support/app.js';

/**
 * The widths where the layout actually changes.
 *
 * This codebase has four breakpoints — 32rem, 34rem, 48rem and 60rem — and until
 * this spec existed not one of them was ever crossed by a test. The suite ran at
 * 412px and 1280px, and every threshold sits between the two. Anything could have
 * been broken in that gap for as long as it has existed and nothing would have
 * said so.
 *
 * These run in one project. They are about width, not about engine differences,
 * and running them three times over would triple a slow suite to learn nothing.
 */
test.describe('across every breakpoint', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'Viewports are set explicitly here; running the sweep twice would only be slower.',
  );

  /**
   * Each threshold and a width either side of it, plus 412 — the one real device
   * width in the suite, which the overflow sweep never used because it forces
   * 320/360/390.
   */
  const WIDTHS = [320, 412, 511, 512, 543, 544, 767, 768, 959, 960, 1024];

  /** Every element sticking out past the viewport, named so a failure is actionable. */
  const overflowing = (page: Page) =>
    page.evaluate(() => {
      const found: string[] = [];
      const limit = document.documentElement.clientWidth;

      const walk = (root: Document | ShadowRoot): void => {
        for (const element of root.querySelectorAll('*')) {
          const box = element.getBoundingClientRect();
          if (box.right > limit + 1 && box.width > 1) {
            const cls =
              typeof element.className === 'string' && element.className !== ''
                ? `.${element.className.trim().split(/\s+/).join('.')}`
                : '';
            const text = (element.textContent ?? '').trim().slice(0, 40);
            found.push(
              `${element.tagName.toLowerCase()}${cls} right=${Math.round(box.right)} :: ${text}`,
            );
          }
          if (element.shadowRoot !== null) walk(element.shadowRoot);
        }
      };

      walk(document);
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: limit, found };
    });

  for (const width of WIDTHS) {
    test(`the hero fits at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page);

      const result = await overflowing(page);
      expect(result.found, result.found.join('\n')).toEqual([]);
      expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
    });
  }

  /**
   * A report with **every** check expanded, not just the first.
   *
   * The evidence table sets `white-space: nowrap` on its row labels and sits in a
   * container with no horizontal scroll, so a long label puts a hard floor under
   * the whole table. Which labels exist depends on which checks ran — and the
   * hosting checks added in 0.4.0 carry some of the longest strings in the app.
   * Expanding only the first row tested DNS and nothing else.
   */
  for (const width of [320, 412, 768]) {
    test(`a report with every check open fits at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page);
      await runDiagnostic(page);

      const rows = page.locator('dwc-check-row');
      const count = await rows.count();
      expect(count).toBeGreaterThan(10);
      for (let i = 0; i < count; i += 1) await rows.nth(i).click();

      const result = await overflowing(page);
      expect(result.found, result.found.join('\n')).toEqual([]);
      expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
    });
  }
});

/**
 * Container queries are sized by the content column, not the viewport — and the
 * content column moves by 15.5rem when the rail collapses. So the same viewport
 * renders two different layouts depending on sidebar state, and only one of them
 * was ever tested.
 */
test.describe('sidebar state changes the layout at one viewport', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'The collapsible rail only exists above the desktop breakpoint.',
  );

  test('the report survives the rail collapsing under it', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await openApp(page);
    await runDiagnostic(page);

    const tiles = page.locator('dwc-report-view').locator('.tiles');
    const expanded = (await tiles.boundingBox())?.width ?? 0;

    await page.getByRole('button', { name: /collapse the sidebar/i }).click();
    await expect
      .poll(async () => (await tiles.boundingBox())?.width ?? 0)
      .toBeGreaterThan(expanded);

    // Widening the content column can only push containers over a threshold, not
    // under one — but it must not push anything off the side of the page.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});

/**
 * The rail is a desktop idea, and the flag that drives it outlives the viewport.
 *
 * It is remembered in localStorage, and the control that unsets it is
 * `display: none` below 60rem — so collapsing on a desktop and then loading on a
 * phone opened the drawer as a rail of unlabelled icons with no way back.
 */
test.describe('a collapsed rail does not follow you to a phone', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'The collapse control only exists above the desktop breakpoint.',
  );

  test('the drawer shows full labels even when the rail was collapsed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    await runDiagnostic(page);

    await page.getByRole('button', { name: /collapse the sidebar/i }).click();
    const aside = page.locator('dwc-app').locator('aside');
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeLessThan(120);

    // Same tab, same stored flag, narrow viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page
      .locator('dwc-app')
      .getByRole('button', { name: /open menu/i })
      .click();

    await expect(aside).toHaveAttribute('data-collapsed', 'false');
    // The site name must be readable, which is the thing the rail hides.
    await expect(page.locator('dwc-nav-tree').locator('.name').first()).toBeVisible();
  });
});

/**
 * States that no width test had ever rendered.
 *
 * The overflow sweep only ever saw the hero and a finished report. Progress,
 * the error banner, the open drawer and dark mode were all measured at exactly
 * zero widths, which is to say never — and the drawer is the interesting one,
 * because it is 85vw of full-width nav tree inside a 320px viewport.
 */
test.describe('states nothing had measured', () => {
  const noOverflow = async (page: Page) => {
    const result = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
  };

  test('the open drawer fits on the narrowest phone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openApp(page);
    await runDiagnostic(page);

    await page
      .locator('dwc-app')
      .getByRole('button', { name: /open menu/i })
      .click();
    await expect(page.locator('dwc-app').locator('aside')).toHaveAttribute('data-open', 'true');
    await noOverflow(page);
  });

  test('the progress panel fits while a diagnostic is running', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openApp(page);

    await page.locator('dwc-url-input input').fill('example.com');
    await page
      .locator('dwc-url-input')
      .getByRole('button', { name: /run diagnostic/i })
      .click();

    // Measured mid-run, which is the whole point — this state lasts seconds and
    // had never been rendered at any width by any test.
    await expect(page.locator('dwc-progress-steps')).toBeVisible();
    await noOverflow(page);
  });

  test('the error banner fits when a host cannot be reached', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openApp(page);
    await runDiagnostic(page, 'this-host-does-not-exist.invalid');

    await noOverflow(page);
  });

  test('a report in dark mode fits on the narrowest phone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openApp(page);
    await setTheme(page, 'dark');
    await runDiagnostic(page);

    await noOverflow(page);
  });

  /**
   * Six `@media print` blocks and a Print button, and nothing had ever asked the
   * browser to render the print stylesheet.
   */
  test('the print layout drops the shell and keeps the report', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openApp(page);
    await runDiagnostic(page);

    await page.emulateMedia({ media: 'print' });

    const shell = page.locator('dwc-app');
    await expect(shell.locator('header')).toBeHidden();
    await expect(shell.locator('aside')).toBeHidden();
    // The point of printing is the report, and every check with it — collapsed
    // detail on paper would be a blank page with headings.
    await expect(page.locator('dwc-report-view')).toBeVisible();
    await expect(page.locator('dwc-check-row').first().locator('.detail')).toBeVisible();
  });
});
