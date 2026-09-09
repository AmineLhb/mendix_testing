import { test, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage.js';

// Hand-authored rather than recorded/enriched, mirroring
// generated-tests/collaborateur/login.spec.js — same login page/widgets,
// just a different role's credentials and post-login landing page.
//
// test.step() labels below are Given/When/Then BDD steps — Playwright's HTML
// report renders them as an expandable per-test tree, and the companion
// login.feature doc alongside this file is mechanically derived from these
// exact labels (see scripts/gherkin.js). Edit the labels here, then run
// `npm run features:sync` to regenerate login.feature to match.

test.describe('Login (admin-fonctionnel)', { tag: '@smoke' }, () => {
  // Order matters here: verified 2026-09-04 (on the collaborateur role, same
  // login form) that submitting a wrong password triggers a brief
  // server-side cooldown that makes the VERY NEXT login attempt fail with a
  // generic "Unknown error occurred" — even with correct credentials.
  // Running the valid-credentials test first avoids tripping that cooldown
  // for itself; the wrong-credentials test doesn't care what ran before it.
  test('logs in successfully with valid credentials', async ({ page }) => {
    const basePage = new BasePage(page);

    await test.step('Given the user is on the login page', async () => {
      await page.goto('http://localhost:8080/');
    });

    let status, body;
    await test.step('When they submit valid admin-fonctionnel credentials', async () => {
      await basePage.mx('textBox1').fill(process.env.MENDIX_TEST_USERNAME_ADMIN_FONCTIONNEL ?? '');
      await basePage.mx('textBox2').fill(process.env.MENDIX_TEST_PASSWORD_ADMIN_FONCTIONNEL ?? '');

      // Capture the real API response, not just the resulting DOM — a click can
      // trigger several /xas/ calls in sequence; matchBody waits for the one
      // that actually carries the post-login session payload (roles/user),
      // not the login action's own near-empty response.
      ({ status, body } = await basePage.captureApiResponse(
        () => basePage.mx('actionButton1').click(),
        { matchBody: (b) => 'roles' in b }
      ));
    });

    await test.step('Then they log in as the FunctionalAdmin role and land on the admin console home page', async () => {
      basePage.expectApiSuccess({ status, body });
      expect(body.roles).toContain('FunctionalAdmin');
      // Verified 2026-09-07 (explorer/discover-adf.js): this account's Name
      // attribute matches the login username exactly ("ADF").
      expect(body.user.attributes.Name.value).toBe(process.env.MENDIX_TEST_USERNAME_ADMIN_FONCTIONNEL);

      await basePage.waitForMendixIdle();
      await basePage.expectNoErrorMessage();

      // Verified 2026-09-07: admin-fonctionnel lands on the same internal
      // admin console ("Page d'accueil") as the admin role, not the visit-list
      // page other roles land on — actionButton14 doesn't exist here.
      await expect(basePage.mx('pageTitle1')).toHaveText("Page d'accueil");
    });

    await test.step('And the user logs out', async () => {
      await basePage.logout();
    });
  });

  test('shows an error with wrong credentials', async ({ page }) => {
    const basePage = new BasePage(page);

    await test.step('Given the user is on the login page', async () => {
      await page.goto('http://localhost:8080/');
    });

    await test.step('When they submit an incorrect password', async () => {
      await basePage.mx('textBox1').fill(process.env.MENDIX_TEST_USERNAME_ADMIN_FONCTIONNEL ?? '');
      await basePage.mx('textBox2').fill('this-is-not-the-right-password');
      await basePage.mx('actionButton1').click();
      await basePage.waitForMendixIdle();
    });

    await test.step('Then an error message is shown and the user stays on the login page', async () => {
      await expect(page.getByText('The username or password you entered is incorrect')).toBeVisible();
      // Still on the login form, not navigated away.
      await expect(basePage.mx('textBox1')).toBeVisible();
    });
  });
});
