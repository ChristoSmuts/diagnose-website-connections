import { expect, test } from '@playwright/test';
import { AUTH_PASSWORD, authBaseURL } from '../playwright.config.js';

/**
 * The password gate.
 *
 * `AUTH_MODE=password` had a server implementation and no client at all: turning
 * it on produced an app that loaded, 401'd, and offered no way in. These run
 * against a second API process started by the spec, because the shared harness
 * deliberately runs with `AUTH_MODE=none` — which is what every local install
 * uses, and which must never see this screen.
 */

test.describe('a password-protected instance', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 960,
    'One viewport is enough for a flow test; layout is covered elsewhere.',
  );

  test('asks for the password, refuses a wrong one, and remembers a right one', async ({
    page,
  }) => {
    await page.goto(authBaseURL);

    const field = page.locator('dwc-app').locator('#password');
    await expect(field).toBeVisible();

    await field.fill('wrong');
    await page
      .locator('dwc-app')
      .getByRole('button', { name: /sign in/i })
      .click();
    await expect(page.locator('dwc-app').locator('.gate-error')).toContainText(/not correct/i);

    await field.fill(AUTH_PASSWORD);
    await page
      .locator('dwc-app')
      .getByRole('button', { name: /sign in/i })
      .click();

    // The gate is gone and the real app is behind it.
    await expect(page.locator('dwc-app').locator('#password')).toHaveCount(0);
    await expect(page.locator('dwc-app').locator('h1')).toContainText(/whose fault|is it/i);

    // The cookie outlives a reload, or the password would be asked for on
    // every page load and the session would be pointless.
    await page.reload();
    await expect(page.locator('dwc-app').locator('#password')).toHaveCount(0);
  });
});

test.describe('an open instance', () => {
  /**
   * The other half of the guarantee. `AUTH_MODE=none` is the default and what
   * every local install runs, so the gate must be invisible there — a login
   * screen on a laptop would be a regression, not a feature.
   */
  test('never asks for a password', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('dwc-app').locator('#password')).toHaveCount(0);
    await expect(page.locator('dwc-app').locator('h1')).toContainText(/is it the website/i);
  });
});
