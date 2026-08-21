import { expect, test } from '@playwright/test';
import { checkRows, openApp, runDiagnostic, scoreDial, verdictHeadline } from '../support/app.js';

/**
 * The core journey: paste a URL, get an answer you can act on.
 *
 * Assertions are on meaning rather than markup wherever possible — that the
 * verdict names an owner, that unmeasured vantages say so — because those are the
 * product's actual promises. A test that only checks "an element appeared" would
 * pass on a report that confidently blames the wrong party.
 */
test.describe('running a diagnostic', () => {
  test('reports a verdict with a score and an owner', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    await expect(verdictHeadline(page)).toContainText('example.com');

    // The dial exposes a meter role with a real value, not just a drawn ring.
    const dial = scoreDial(page);
    await expect(dial).toBeVisible();
    const score = Number(await dial.getAttribute('aria-valuenow'));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);

    // Layer 1 must name who owns the problem. That is the question people have.
    await expect(page.locator('dwc-verdict-banner dwc-badge')).toBeVisible();
  });

  test('shows progress phases while the report streams in', async ({ page }) => {
    await openApp(page);

    await page.locator('dwc-url-input input').fill('example.com');
    await page.locator('dwc-url-input input').press('Enter');

    // Results arrive over SSE, so the phase list should appear well before the
    // verdict does. This is what makes the wait feel like progress.
    await expect(page.locator('dwc-progress-steps')).toBeVisible({ timeout: 20_000 });
    await expect(verdictHeadline(page)).not.toBeEmpty({ timeout: 75_000 });
  });

  test('is honest that it cannot measure the reader’s connection when self-hosted', async ({
    page,
  }) => {
    /*
     * The most important behavioural promise in the app.
     *
     * The control endpoint is on loopback here, exactly as in the default
     * self-hosted deployment. Both client-side vantages must therefore report "not
     * measured" rather than a flattering "healthy" — reporting the ~3ms loopback
     * round trip as a healthy connection is what previously made the engine blame
     * the reader's ISP for latency it had never measured.
     *
     * The promise is unchanged; where it is kept has moved. An unmeasured vantage
     * no longer takes a tile — it is named in a note under the grid instead — so
     * this asserts the absence of the tile *and* the presence of the explanation.
     * Asserting only the first would pass just as happily if the report had
     * quietly dropped the whole subject.
     */
    await openApp(page);
    await runDiagnostic(page);

    // The server vantage was measured, so exactly one tile survives.
    const tiles = page.locator('dwc-vantage-tile');
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first()).toContainText(/their server/i);
    await expect(tiles.first()).not.toContainText(/your connection/i);

    // Both client vantages are accounted for, with the reason and the remedy.
    const note = page.locator('[data-testid="not-measured"]');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/your connection/i);
    await expect(note).toContainText(/the path between/i);
    await expect(note).toContainText(/CONTROL_URL/);

    // And the prose must agree with the note beside it.
    await expect(page.locator('dwc-verdict-banner .prose')).not.toContainText(/round trip/i);
  });

  test('lists every check, including the ones that passed', async ({ page }) => {
    await openApp(page);
    await runDiagnostic(page);

    // A healthy site produces roughly thirty checks. Findings alone would leave
    // almost nothing to inspect, which is the gap this section exists to close.
    await expect(page.locator('text=Every check we ran')).toBeVisible();
    expect(await checkRows(page).count()).toBeGreaterThan(15);
  });

  test('refuses an empty address inline, without contacting the server', async ({ page }) => {
    await openApp(page);

    await page.locator('dwc-url-input input').press('Enter');

    // The only validation the component does itself. Anything non-empty is the
    // server's decision, because normalising a host is not the input's job.
    const alert = page.locator('dwc-url-input [role="alert"]');
    await expect(alert).toBeVisible();
    await expect(page.locator('dwc-url-input input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('dwc-url-input input')).toBeEnabled();
  });

  test('treats an unreachable host as a diagnosis, not an input error', async ({ page }) => {
    /*
     * "This domain does not resolve" is a finding about the site, not a complaint
     * about what the reader typed — so it earns a full report with an explanation
     * and an owner, rather than a red message under the field.
     */
    await openApp(page);
    await runDiagnostic(page, 'this-host-does-not-exist.invalid');

    await expect(verdictHeadline(page)).toContainText(/couldn.t reach/i);
    await expect(page.locator('dwc-verdict-banner .prose')).toContainText(/DNS|does not exist/i);

    // And it must not pretend to know anything about the reader's connection.
    await expect(page.locator('[data-testid="not-measured"]')).toContainText(/your connection/i);
  });
});
