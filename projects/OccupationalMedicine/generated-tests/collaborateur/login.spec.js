import { test, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage.js';
import { submitLogin, submitLoginExpectingFailure } from '../../../../steps/business-steps.js';

// Hand-authored rather than recorded/enriched — a login flow is simple and
// stable enough to write directly against the widgets already verified by
// create-visit.spec.js and edit-visit.spec.js (textBox1, textBox2, actionButton1).
//
// test.step() labels below are Given/When/Then BDD steps — Playwright's HTML
// report renders them as an expandable per-test tree, and the companion
// login.feature doc alongside this file is mechanically derived from these
// exact labels (see scripts/gherkin.js). Edit the labels here, then run
// `npm run features:sync` to regenerate login.feature to match.

test.describe('Login', { tag: '@smoke' }, () => {
  // Order matters here: verified 2026-09-04 that submitting a wrong password
  // triggers a brief server-side cooldown that makes the VERY NEXT login
  // attempt fail with a generic "Unknown error occurred" — even with correct
  // credentials. Running the valid-credentials test first avoids tripping
  // that cooldown for itself; the wrong-credentials test doesn't care what
  // ran before it.
  test('logs in successfully with valid credentials', async ({ page }) => {
    const basePage = new BasePage(page);

    await test.step('Given the user is on the login page', async () => {
      await page.goto('/');
    });

    let status, body;
    await test.step('When they submit valid credentials', async () => {
      ({ status, body } = await submitLogin(basePage, {
        username: process.env.MENDIX_TEST_USERNAME,
        password: process.env.MENDIX_TEST_PASSWORD,
      }));
    });

    await test.step('Then they log in as the Collaborateur role and land on the visit list page', async () => {
      basePage.expectApiSuccess({ status, body });
      expect(body.roles).toContain('Collaborateur');
      expect(body.user.attributes.Name.value).toBe(process.env.MENDIX_TEST_USERNAME);

      await basePage.waitForMendixIdle();
      await basePage.expectNoErrorMessage();

      // "Ajouter une visite" only appears once past the login page.
      await expect(basePage.mx('actionButton14')).toBeVisible();
    });

    await test.step('And the user logs out', async () => {
      await basePage.logout();
    });
  });

  test('shows an error with wrong credentials', async ({ page }) => {
    const basePage = new BasePage(page);

    await test.step('Given the user is on the login page', async () => {
      await page.goto('/');
    });

    await test.step('When they submit an incorrect password', async () => {
      await submitLoginExpectingFailure(basePage, process.env.MENDIX_TEST_USERNAME, 'this-is-not-the-right-password');
    });

    await test.step('Then an error message is shown and the user stays on the login page', async () => {
      await expect(page.getByText('The username or password you entered is incorrect')).toBeVisible();
      // Still on the login form, not navigated away.
      await expect(basePage.mx('textBox1')).toBeVisible();
    });
  });
});
