import { expect, test, type Page } from '@playwright/test';
import { HEALTHY_TARGET, openApp, openSidebar, verdictHeadline } from '../support/app.js';

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
    await openSidebar(page);
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

test.describe('the speed-test option', () => {
  /**
   * The reason this suite cannot simply click the row.
   *
   * The throughput test transfers against the page's own origin, never the
   * control endpoint — so on a local install it never leaves the machine. The app
   * therefore hides the option entirely rather than offering something it cannot
   * deliver, and this harness is loopback by definition, so the row is absent
   * here exactly as it is on a laptop install.
   */
  test('is not offered when the app is served from the reader’s own machine', async ({ page }) => {
    await openApp(page);

    await expect(page.locator('dwc-switch')).toHaveCount(0);
    await expect(page.getByText(/measure my connection speed/i)).toHaveCount(0);
  });
});

/**
 * The switch itself, mounted directly.
 *
 * `dwc-switch` is registered by the app bundle but only rendered on a non-local
 * install, which a loopback harness can never be. Driving the element on its own
 * is the honest way to keep its contract covered: these assert the behaviour a
 * plain `<input type="checkbox">` gave for free and a custom element has to earn
 * back — a real toggle, a state assistive technology can read, keyboard
 * operation, and a hit area the rest of the app would accept.
 */
test.describe('dwc-switch', () => {
  const mount = async (page: Page): Promise<void> => {
    await openApp(page);
    await page.evaluate(() => {
      const el = document.createElement('dwc-switch');
      el.setAttribute('aria-label', 'Measure my connection speed too');
      el.id = 'probe-switch';
      document.body.append(el);
    });
    await expect(page.locator('#probe-switch')).toBeVisible();
  };

  test('toggles on click and reports its state to assistive technology', async ({ page }) => {
    await mount(page);
    const control = page.locator('#probe-switch').getByRole('switch');

    await expect(control).toHaveAttribute('aria-checked', 'false');
    await control.click();
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await control.click();
    await expect(control).toHaveAttribute('aria-checked', 'false');
  });

  test('toggles from the keyboard with Space', async ({ page }) => {
    await mount(page);
    const control = page.locator('#probe-switch').getByRole('switch');

    await control.focus();
    await page.keyboard.press(' ');
    await expect(control).toHaveAttribute('aria-checked', 'true');
  });

  test('reflects its state to the host so a surrounding row can style itself', async ({ page }) => {
    await mount(page);

    await page.locator('#probe-switch').getByRole('switch').click();
    await expect(page.locator('#probe-switch')).toHaveAttribute('checked', '');
  });

  /**
   * A 1.1rem checkbox was the previous control, well under the tap target the
   * rest of the app holds to and the likeliest thing on that page to be reached
   * for on a phone.
   */
  test('offers a tap target the rest of the app would accept', async ({ page }) => {
    await mount(page);

    const box = await page.locator('#probe-switch').getByRole('switch').boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
