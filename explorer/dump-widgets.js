/**
 * Diagnostic tool: logs in, clicks through a sequence of mx-name widgets,
 * then dumps every mx-name-* widget currently in the DOM. Use this when a
 * generated test fails on "element(s) not found" to check whether the
 * widget name is real (present somewhere in the dump, maybe under a
 * different name or inside a dialog) or genuinely never rendered at that
 * point in the flow.
 *
 * Usage:
 *   MENDIX_TEST_USERNAME=... MENDIX_TEST_PASSWORD=... node explorer/dump-widgets.js \
 *     <app-url> [mxNameToClick ...]
 *
 * Example — reproduce up through "Ajouter une visite":
 *   node explorer/dump-widgets.js http://localhost:8080 actionButton1 actionButton14
 */
import { chromium } from "@playwright/test";
import { BasePage } from "../pages/BasePage.js";
import { loadProjectEnv } from "../scripts/project.js";

// Uses the active project's credentials — set MENDIX_PROJECT to target a
// different one (see scripts/project.js), defaults to DEFAULT_PROJECT.
await loadProjectEnv();

const [, , appUrl, ...clickSequence] = process.argv;

if (!appUrl) {
  console.error("Usage: node explorer/dump-widgets.js <app-url> [mxNameToClick ...]");
  process.exit(1);
}
if (!process.env.MENDIX_TEST_USERNAME || !process.env.MENDIX_TEST_PASSWORD) {
  console.error("Set MENDIX_TEST_USERNAME and MENDIX_TEST_PASSWORD in your environment first.");
  process.exit(1);
}

async function dumpWidgets(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="mx-name-"]'));
    return els.map((el) => ({
      tag: el.tagName.toLowerCase(),
      mxNames: el.className.match(/mx-name-\S+/g) || [],
      text: (el.textContent || "").trim().slice(0, 60),
      visible: !!(el.offsetWidth || el.offsetHeight),
    }));
  });
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const basePage = new BasePage(page);

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await basePage.mx("textBox1").fill(process.env.MENDIX_TEST_USERNAME);
  await basePage.mx("textBox2").fill(process.env.MENDIX_TEST_PASSWORD);
  await basePage.mx("actionButton1").click();
  await basePage.waitForMendixIdle();
  console.log(`Logged in. url=${page.url()}`);

  for (const mxName of clickSequence) {
    await basePage.mx(mxName).click();
    await basePage.waitForMendixIdle();
    console.log(`Clicked ${mxName}. url=${page.url()}`);
  }

  const widgets = await dumpWidgets(page);
  console.log(`\n${widgets.length} mx-name-* elements currently in the DOM:`);
  console.log(JSON.stringify(widgets, null, 2));

  const shotPath = "explorer/dump-widgets-final.png";
  await page.screenshot({ path: shotPath, fullPage: true });
  console.log(`\nScreenshot: ${shotPath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
