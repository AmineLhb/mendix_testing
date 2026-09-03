import { test, expect } from '@playwright/test';
import { BasePage } from '../pages/BasePage.js';

test('visit app and validate form', async ({ page }) => {
  const basePage = new BasePage(page);

  // Step 1: Visit the app
  await page.goto('http://localhost:8080/');
  await basePage.waitForMendixIdle();

  // Step 2: Fill username
  const usernameField = basePage.mx('textBox1');
  await expect(usernameField).toBeVisible();
  await usernameField.fill(process.env.MENDIX_TEST_USERNAME ?? '');
  await basePage.expectNoErrorMessage();

  // Step 3: Fill password
  const passwordField = basePage.mx('textBox2');
  await expect(passwordField).toBeVisible();
  await passwordField.fill(process.env.MENDIX_TEST_PASSWORD ?? '');
  await basePage.expectNoErrorMessage();

  // Step 4: Click on Se connecter
  const connectButton = basePage.mx('actionButton1');
  await expect(connectButton).toBeVisible();
  await connectButton.click();
  await basePage.waitForMendixIdle();

  // Step 5: Click on Ajouter une visite
  const addVisitButton = basePage.mx('actionButton14');
  await expect(addVisitButton).toBeVisible();
  await addVisitButton.click();
  await basePage.waitForMendixIdle();

  // Step 6: Select Type de visite
  const typeVisitSelect = basePage.mx('comboBox4');
  await expect(typeVisitSelect).toBeVisible();
  await typeVisitSelect.click();
  const spontaneousOption = page.locator('#downshift-0-item-0 > .widget-combobox-caption-text');
  await expect(spontaneousOption).toBeVisible();
  await spontaneousOption.click();
  await basePage.waitForMendixIdle();

  // Step 7: Fill motif
  const motifField = basePage.mx('textArea1');
  await expect(motifField).toBeVisible();
  await motifField.fill('test');
  await basePage.expectNoErrorMessage();

  // Step 8: Click on Valider
  const validateButton = basePage.mx('actionButton1').filter({ hasText: 'Valider' });
  await expect(validateButton).toBeVisible();
  await validateButton.click();
  await basePage.waitForMendixIdle();

  // Step 9: Confirm validation
  const confirmValidateButton = basePage.mx('actionButton3').filter({ hasText: 'Valider' });
  await expect(confirmValidateButton).toBeVisible();
  await confirmValidateButton.click();
  await basePage.waitForMendixIdle();

  // Step 10: Assert that the app is on the correct page
  await expect(page).toHaveURL(/http:\/\/localhost:8080\/.*$/);
});
