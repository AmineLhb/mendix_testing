/**
 * Replays a raw Playwright codegen recording action-by-action in a real
 * browser, snapshotting the live mx-name-* widget map after each step —
 * ground truth for what's actually in the DOM at that point in the flow,
 * not a static single-page guess.
 *
 * Shared by explorer/enrich.js (turns a fresh recording into a test) and
 * scripts/heal.js (re-replays an EXISTING test's original recording
 * against the current app to find what a broken locator's widget was
 * renamed to — same ground-truth-from-real-DOM principle, just triggered
 * by a failure instead of a new recording).
 *
 * Only works because raw Playwright codegen output is one `await page....`
 * statement per line — that's what we split on to get the ordered action list.
 */
import { chromium } from "@playwright/test";

export async function replayAndSnapshotWidgets(rawScript) {
  const browser = await chromium.launch();
  const storageStateMatch = rawScript.match(/storageState:\s*['"]([^'"]+)['"]/);
  const context = await browser.newContext(
    storageStateMatch ? { storageState: storageStateMatch[1] } : {}
  );
  const page = await context.newPage();

  const snapshotWidgets = () =>
    page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[class*="mx-name-"]'));
      return els.slice(0, 200).map((el) => ({
        tag: el.tagName.toLowerCase(),
        // Store bare widget names (prefix stripped) — these are handed to the model
        // as the exact argument for basePage.mx(name), which already prepends
        // "mx-name-" itself. Keeping the raw "mx-name-X" string here caused the
        // model to sometimes pass it straight through, producing a doubled
        // ".mx-name-mx-name-X" selector that matches nothing.
        mxNames: (el.className.match(/mx-name-\S+/g) || []).map((n) => n.replace(/^mx-name-/, "")),
        text: (el.textContent || "").trim().slice(0, 40),
      }));
    });
  const widgetKey = (w) => `${w.tag}|${w.mxNames.join(",")}|${w.text}`;

  const actionLines = rawScript
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("await page."));

  const steps = [];
  let seen = new Set();
  for (const line of actionLines) {
    try {
      const runLine = new Function("page", `return (async () => { ${line} })();`);
      await runLine(page);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      const current = await snapshotWidgets();
      // Only send widgets not already reported in an earlier step — most steps
      // don't change the page, and repeating the full widget list every step
      // blows through the model's per-request token budget for no benefit.
      const newWidgets = current.filter((w) => !seen.has(widgetKey(w)));
      newWidgets.forEach((w) => seen.add(widgetKey(w)));
      steps.push({ action: line, newlyVisibleWidgets: newWidgets });
    } catch (err) {
      steps.push({ action: line, replayError: String(err), newlyVisibleWidgets: [] });
    }
  }

  await browser.close();
  return steps;
}
