import { chromium } from "@playwright/test";
import { BasePage } from "../pages/BasePage.js";
import fs from "node:fs";
import { loadProjectEnv } from "../scripts/project.js";

await loadProjectEnv();

const appUrl = process.env.BASE_URL || "http://localhost:8080";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const basePage = new BasePage(page);

  const captured = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/xas/")) return;
    let body = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        body = null;
      }
    }
    captured.push({ url: res.url(), status: res.status(), body });
  });

  try {
    await page.goto(appUrl);
    await basePage.waitForMendixIdle();
    await basePage.mx("textBox1").fill(process.env.MENDIX_TEST_USERNAME ?? "");
    await basePage.mx("textBox2").fill(process.env.MENDIX_TEST_PASSWORD ?? "");
    await basePage.mx("actionButton1").click();
    await basePage.waitForMendixIdle();

    await basePage.mx("actionButton14").click();
    await basePage.waitForMendixIdle();

    await basePage.mx("comboBox4").click();
    await basePage.waitForMendixIdle();
    await page.locator("#downshift-0-item-0 > .widget-combobox-caption-text").click();
    await basePage.waitForMendixIdle();

    await basePage.mx("textArea1").fill("api-response-inspection");
    await basePage.mx("actionButton1").filter({ hasText: "Valider" }).click();
    await basePage.waitForMendixIdle();
    await basePage.mx("actionButton3").filter({ hasText: "Valider" }).click();
    await basePage.waitForMendixIdle();
  } catch (err) {
    console.error("Flow errored partway through:", err.message);
    await page.screenshot({ path: "explorer/api-responses-error.png" }).catch(() => {});
  } finally {
    await browser.close();
    fs.writeFileSync("explorer/api-responses.debug.json", JSON.stringify(captured, null, 2));
    console.log(`Captured ${captured.length} /xas/ responses -> explorer/api-responses.debug.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
