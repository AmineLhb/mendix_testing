import { test, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage.js';

// test.step() labels below are Given/When/Then BDD steps — Playwright's HTML
// report renders them as an expandable per-test tree, and the companion
// edit-visit.feature doc alongside this file is mechanically derived from
// these exact labels (see scripts/gherkin.js). Edit the labels here, then run
// `npm run features:sync` to regenerate edit-visit.feature to match.

test('Mendix app end‑to‑end flow', async ({ page }) => {
  const basePage = new BasePage(page);

  await test.step('Given the user is on the login page', async () => {
    await page.goto('http://localhost:8080/');
    await basePage.expectNoErrorMessage();
  });

  await test.step('When they log in with valid credentials', async () => {
    await page.getByLabel("Nom d'utilisateur").click();
    await page.getByLabel("Nom d'utilisateur").fill(process.env.MENDIX_TEST_USERNAME ?? '');
    await page.getByLabel("Nom d'utilisateur").press('Tab');
    await page.getByLabel('Mot de passe').fill(process.env.MENDIX_TEST_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await basePage.waitForMendixIdle();
    await basePage.expectNoErrorMessage();
  });

  await test.step('Then they land on the visit list page', async () => {
    await expect(basePage.mx('actionButton14')).toBeVisible();
  });

  await test.step('When they open an existing visit for editing', async () => {
    // Don't target a specific row by content — this suite's own create-visit
    // test adds a new row every run, so any hardcoded row identity (e.g. a
    // specific visit number) will eventually get pushed off the first page.
    // Instead, edit whichever row actually has a "Modifier" action — that's
    // guaranteed to be a real data row regardless of how many rows exist.
    const editableRow = page.getByRole('row').filter({ has: page.getByLabel('Modifier') }).first();
    await expect(editableRow).toBeVisible();
    await editableRow.getByLabel('Modifier').click();
    await basePage.waitForMendixIdle();
    await basePage.expectNoErrorMessage();
  });

  await test.step('And they change the reason for the visit', async () => {
    const motifInput = page.getByPlaceholder('Motif');
    await motifInput.fill('testjjghg');
    await expect(motifInput).toHaveValue('testjjghg');
  });

  await test.step('When they save the changes', async () => {
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await basePage.waitForMendixIdle();
    await basePage.expectNoErrorMessage();
  });

  await test.step('And they validate the changes', async () => {
    await page.getByRole('button', { name: 'Valider' }).click();
    await basePage.waitForMendixIdle();
    await basePage.expectNoErrorMessage();
  });

  await test.step('Then the app returns to the visit list page', async () => {
    await expect(basePage.mx('actionButton14')).toBeVisible();
  });

  await test.step('And the user logs out', async () => {
    await basePage.logout();
  });
});
