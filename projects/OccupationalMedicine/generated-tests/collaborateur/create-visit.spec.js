import { test, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage.js';

// test.step() labels below are Given/When/Then BDD steps — Playwright's HTML
// report renders them as an expandable per-test tree, and the companion
// create-visit.feature doc alongside this file is mechanically derived from
// these exact labels (see scripts/gherkin.js). Edit the labels here, then run
// `npm run features:sync` to regenerate create-visit.feature to match.

test('visit app and validate form', async ({ page }) => {
  const basePage = new BasePage(page);

  await test.step('Given the user is on the login page', async () => {
    await page.goto('http://localhost:8080/');
    await basePage.waitForMendixIdle();
  });

  await test.step('When they log in with valid credentials', async () => {
    const usernameField = basePage.mx('textBox1');
    await expect(usernameField).toBeVisible();
    await usernameField.fill(process.env.MENDIX_TEST_USERNAME ?? '');
    await basePage.expectNoErrorMessage();

    const passwordField = basePage.mx('textBox2');
    await expect(passwordField).toBeVisible();
    await passwordField.fill(process.env.MENDIX_TEST_PASSWORD ?? '');
    await basePage.expectNoErrorMessage();

    const connectButton = basePage.mx('actionButton1');
    await expect(connectButton).toBeVisible();
    await connectButton.click();
    await basePage.waitForMendixIdle();
  });

  await test.step('Then they land on the visit list page', async () => {
    await expect(basePage.mx('actionButton14')).toBeVisible();
  });

  await test.step('When they open the add-visit form', async () => {
    const addVisitButton = basePage.mx('actionButton14');
    await addVisitButton.click();
    await basePage.waitForMendixIdle();
  });

  await test.step('And they select the visit type', async () => {
    const typeVisitSelect = basePage.mx('comboBox4');
    await expect(typeVisitSelect).toBeVisible();
    await typeVisitSelect.click();
    const spontaneousOption = page.locator('#downshift-0-item-0 > .widget-combobox-caption-text');
    await expect(spontaneousOption).toBeVisible();
    await spontaneousOption.click();
    await basePage.waitForMendixIdle();
  });

  await test.step('And they fill in the reason for the visit', async () => {
    const motifField = basePage.mx('textArea1');
    await expect(motifField).toBeVisible();
    await motifField.fill('test');
    await basePage.expectNoErrorMessage();
  });

  let status, body;
  await test.step('When they submit and confirm the visit', async () => {
    const validateButton = basePage.mx('actionButton1').filter({ hasText: 'Valider' });
    await expect(validateButton).toBeVisible();
    await validateButton.click();
    await basePage.waitForMendixIdle();

    // Confirm validation — capture the real API response instead of just
    // checking the DOM, so we assert on the actual persisted record.
    // Verified 2026-09-04 (explorer/inspect-api-responses.js): the first
    // Valider click's response still has reason/visitType as null; the
    // record only commits on this confirm click, so matchBody waits
    // specifically for a Visit object with a non-null reason.
    const confirmValidateButton = basePage.mx('actionButton3').filter({ hasText: 'Valider' });
    await expect(confirmValidateButton).toBeVisible();
    ({ status, body } = await basePage.captureApiResponse(
      () => confirmValidateButton.click(),
      {
        matchBody: (b) =>
          (b.objects || []).some(
            (o) => o.objectType === 'MedicalSurveillance.Visit' && o.attributes?.reason?.value != null
          ),
      }
    ));
  });

  await test.step('Then the visit is created with the correct details', async () => {
    basePage.expectApiSuccess({ status, body });
    const savedVisit = basePage.findApiObject(body, 'MedicalSurveillance.Visit');
    expect(savedVisit.attributes.reason.value).toBe('test');
    expect(savedVisit.attributes.visitStatus.value).toBe('En_attente');

    await basePage.waitForMendixIdle();
  });

  await test.step('And the app returns to the visit list page', async () => {
    await expect(page).toHaveURL(/http:\/\/localhost:8080\/.*$/);
  });

  await test.step('And the user logs out', async () => {
    await basePage.logout();
  });
});
