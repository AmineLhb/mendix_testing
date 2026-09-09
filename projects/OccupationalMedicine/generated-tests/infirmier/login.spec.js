import { test, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage.js';

// Hand-authored rather than recorded/enriched, mirroring
// generated-tests/collaborateur/login.spec.js — same login page/widgets,
// just a different role's credentials and post-login role check.
//
// test.step() labels below are Given/When/Then BDD steps — Playwright's HTML
// report renders them as an expandable per-test tree, and the companion
// login.feature doc alongside this file is mechanically derived from these
// exact labels (see scripts/gherkin.js). Edit the labels here, then run
// `npm run features:sync` to regenerate login.feature to match.

test.describe('Login (infirmier)', () => {
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
    await test.step('When they submit valid infirmier credentials', async () => {
      await basePage.mx('textBox1').fill(process.env.MENDIX_TEST_USERNAME_INFIRMIER ?? '');
      await basePage.mx('textBox2').fill(process.env.MENDIX_TEST_PASSWORD_INFIRMIER ?? '');

      // Capture the real API response, not just the resulting DOM — a click can
      // trigger several /xas/ calls in sequence; matchBody waits for the one
      // that actually carries the post-login session payload (roles/user),
      // not the login action's own near-empty response.
      ({ status, body } = await basePage.captureApiResponse(
        () => basePage.mx('actionButton1').click(),
        { matchBody: (b) => 'roles' in b }
      ));
    });

    await test.step('Then they log in as the Infirmier role and land on the visit list page', async () => {
      basePage.expectApiSuccess({ status, body });
      expect(body.roles).toContain('Infirmier');
      // Verified 2026-09-07 (explorer/discover-roles.js): this account's Name
      // attribute is stored uppercase ("INFIRMIER") regardless of the login
      // form's case, so compare case-insensitively rather than exact-match.
      expect(body.user.attributes.Name.value.toUpperCase()).toBe(
        (process.env.MENDIX_TEST_USERNAME_INFIRMIER ?? '').toUpperCase()
      );

      await basePage.waitForMendixIdle();
      await basePage.expectNoErrorMessage();

      // Verified 2026-09-07: infirmier lands on the same "Ajouter une visite"
      // list page as the default role, so this widget is a valid past-login
      // signal here too.
      await expect(basePage.mx('actionButton14')).toBeVisible();
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
      await basePage.mx('textBox1').fill(process.env.MENDIX_TEST_USERNAME_INFIRMIER ?? '');
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
