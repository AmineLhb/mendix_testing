// One-off helper: captures real screenshots of the running UI for the
// project report (docs/report.html references these under
// docs/screenshots/). Requires `npm run ui` already running on :4300,
// and the OccupationalMedicine project to already exist.
// Usage: node docs/capture-screenshots.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT_DIR = 'docs/screenshots';
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto('http://localhost:4300');
await page.waitForSelector('.project-card', { timeout: 10000 });
await page.screenshot({ path: `${OUT_DIR}/01-project-list.png` });

await page.locator('.project-card', { hasText: 'OccupationalMedicine' }).first().click();
await page.waitForSelector('#tests-table', { timeout: 10000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT_DIR}/02-tests-tab.png` });

await page.locator('.tab-btn[data-tab="review"]').click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT_DIR}/03-review-tab.png` });

await page.locator('.tab-btn[data-tab="insights"]').click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT_DIR}/04-insights-tab.png` });

await page.locator('.tab-btn[data-tab="settings"]').click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT_DIR}/05-settings-tab.png` });
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT_DIR}/06-settings-sessions.png` });

await page.locator('.tab-btn[data-tab="coverage"]').click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT_DIR}/07-coverage-tab.png` });

await browser.close();
console.log('Screenshots written to', OUT_DIR);
