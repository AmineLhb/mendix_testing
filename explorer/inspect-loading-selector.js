/**
 * One-off diagnostic: opens the Mendix app in a headed browser and watches
 * for DOM elements that appear/disappear while you manually trigger a
 * microflow (click a save/submit button, navigate a page, etc).
 *
 * Reports any added/removed elements whose class or attributes look like a
 * loading indicator, so we can confirm/correct BasePage.js's
 * LOADING_SELECTOR against the real app instead of guessing.
 *
 * Usage: node explorer/inspect-loading-selector.js http://localhost:8080 [seconds]
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:8080";
const seconds = parseInt(process.argv[3] || "45", 10);

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) console.log(`[NAV] ${frame.url()}`);
  });
  page.on("console", (msg) => console.log(`[CONSOLE:${msg.type()}] ${msg.text()}`));
  page.on("request", (req) => {
    if (req.method() === "POST") console.log(`[REQUEST] POST ${req.url()}`);
  });
  page.on("websocket", (ws) => {
    console.log(`[WEBSOCKET-OPEN] ${ws.url()}`);
    ws.on("close", () => console.log(`[WEBSOCKET-CLOSE] ${ws.url()}`));
  });

  await page.goto(url, { waitUntil: "networkidle" });
  console.log(`[NAV] initial load: ${page.url()}`);

  // On localhost the server responds fast enough that Mendix may never
  // render a loading overlay at all. Add artificial network latency via
  // CDP so any server round-trip (microflow call) takes long enough for
  // us to actually observe the indicator appearing.
  const client = await page.context().newCDPSession(page);
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 2500,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  console.log("Throttled network with ~2.5s added latency per request.");

  await page.exposeFunction("__reportMutation", (type, info) => {
    console.log(`[${type}]`, JSON.stringify(info));
  });

  await page.evaluate(() => {
    const describe = (el, extra) => ({
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      className: el.className ? String(el.className) : "",
      id: el.id || "",
      style: el.getAttribute ? el.getAttribute("style") || "" : "",
      text: (el.textContent || "").trim().slice(0, 40),
      ...extra,
    });
    // Cast a wide net: report every added/removed node (any class), and
    // every class/style attribute change on any element that carries an
    // "mx-" class (Mendix's own framework/widget elements) — this is where
    // a loading overlay toggled via style or a visibility-utility class
    // change would show up, which a narrow name-based filter would miss.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) window.__reportMutation("ADDED", describe(n));
        });
        m.removedNodes.forEach((n) => {
          if (n.nodeType === 1) window.__reportMutation("REMOVED", describe(n));
        });
        if (m.type === "attributes") {
          const cls = m.target.className ? String(m.target.className) : "";
          if (/mx-/.test(cls)) {
            window.__reportMutation(`ATTR:${m.attributeName}-CHANGED`, describe(m.target));
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.__loadingObserver = observer;
  });

  console.log(`\nWatching DOM for ${seconds}s. In the opened browser window, click a`);
  console.log(`button/action that triggers a microflow (ideally a slow one — save,`);
  console.log(`submit, a page navigation with a data call) so we can see the loading`);
  console.log(`indicator appear and disappear.\n`);

  const shotDir = "explorer/debug-shots";
  fs.mkdirSync(shotDir, { recursive: true });
  const ticks = Math.ceil(seconds / 5);
  for (let i = 0; i < ticks; i++) {
    await page.waitForTimeout(5000);
    const shotPath = `${shotDir}/tick-${String(i).padStart(2, "0")}.png`;
    await page.screenshot({ path: shotPath }).catch((e) => console.log(`[SCREENSHOT-ERR] ${e.message}`));
    console.log(`[TICK ${i}] url=${page.url()} screenshot=${shotPath}`);
  }

  console.log("\nChecking whether waitForLoadState('networkidle') actually resolves...");
  const t0 = Date.now();
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
    console.log(`[NETWORKIDLE] resolved after ~${Date.now() - t0}ms`);
  } catch {
    console.log(`[NETWORKIDLE] TIMED OUT after ~${Date.now() - t0}ms (never went idle)`);
  }

  console.log("\nDone watching. Close the browser window or press Ctrl+C to exit.");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
