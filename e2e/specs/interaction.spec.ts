import { expect, test } from '@playwright/test';
import { HEALTHY_TARGET, openApp, verdictHeadline } from '../support/app.js';

/**
 * Two things a mouse does that a keyboard does not, both of which shipped broken.
 *
 * Every other spec drives the app with `press('Enter')`, which is the one route
 * through the form that never touched the button — so the primary call to action
 * was dead to a click for an entire release while the suite stayed green. These
 * tests exist to make the pointer path first-class.
 */

test.describe('the primary call to action', () => {
  /**
   * Form association does not cross a shadow boundary. The real `<button>` lives
   * inside `dwc-button`'s shadow root, so it is not associated with the `<form>`
   * in `dwc-url-input` and `type="submit"` did nothing on click. Enter still
   * worked, because implicit submission acts on the form directly — which is
   * precisely what made the fault invisible.
   */
  test('starts a diagnostic when clicked, not only on Enter', async ({ page }) => {
    await openApp(page);

    await page.locator('dwc-url-input input').fill(HEALTHY_TARGET);
    await page.locator('dwc-url-input dwc-button').click();

    await expect(verdictHeadline(page)).not.toBeEmpty({ timeout: 75_000 });
  });

  test('clicking with the field empty asks for an address rather than doing nothing', async ({
    page,
  }) => {
    await openApp(page);

    await page.locator('dwc-url-input dwc-button').click();

    // The click must reach the form's own handler, which owns this validation.
    await expect(page.locator('dwc-url-input [role="alert"]')).toContainText(/enter a website/i);
  });
});

test.describe('the confirmation dialog', () => {
  /**
   * A modal `<dialog>` is centred by the UA stylesheet through `margin: auto`
   * against `inset: 0`. Tailwind's preflight resets margin to 0 on every element,
   * and the compiled sheet is adopted into every shadow root — so the dialog
   * pinned itself to the top-left corner. Nothing in the component's own CSS
   * looked wrong, which is why reading it never found this.
   *
   * Asserted on geometry rather than on the declaration, because `margin: auto`
   * being present says nothing about where the box actually landed.
   */
  test('opens in the centre of the viewport', async ({ page }) => {
    await openApp(page);

    await page.locator('dwc-url-input input').fill(HEALTHY_TARGET);
    await page.locator('dwc-url-input dwc-button').click();
    await expect(verdictHeadline(page)).not.toBeEmpty({ timeout: 75_000 });

    // Site actions carry explicit aria-labels, so the delete control is named
    // for the site it belongs to rather than being a bare "Delete".
    await page
      .locator('dwc-nav-tree')
      .getByRole('button', { name: new RegExp(`Delete ${HEALTHY_TARGET}`, 'i') })
      .click();

    const dialog = page.locator('dwc-dialog dialog');
    await expect(dialog).toBeVisible();

    const offset = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        horizontal: Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
        vertical: Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
        left: box.left,
        top: box.top,
      };
    });

    // A few pixels of slack for the scrollbar gutter; the bug parked it at 0, 0.
    expect(offset.horizontal).toBeLessThan(12);
    expect(offset.vertical).toBeLessThan(12);
    expect(offset.left).toBeGreaterThan(0);
    expect(offset.top).toBeGreaterThan(0);
  });
});
