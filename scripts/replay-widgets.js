/**
 * Two ways to get ground-truth "what mx-name-* widgets actually exist right
 * now" from a real browser, not a guess:
 *
 * - replayAndSnapshotWidgets(rawScript): replays a raw Playwright codegen
 *   recording action-by-action. Used by explorer/enrich.js to turn a fresh
 *   recording into a test — there's no existing test yet to run, only the
 *   raw recording.
 *
 * - replaySpecAndSnapshotWidgets(specText, {baseUrl}): runs an EXISTING
 *   generated test's own code directly, step by step. Used by
 *   scripts/heal-scan.js to check an existing test's locators against the
 *   live app — the enriched spec.js already knows exactly how to get to the
 *   relevant page (it's a real, working Playwright test), so there's no
 *   reason to depend on the raw recording still being on disk just to
 *   navigate there again.
 */
import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const snapshotWidgets = (page) =>
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

export async function replayAndSnapshotWidgets(rawScript) {
  const browser = await chromium.launch();
  const storageStateMatch = rawScript.match(/storageState:\s*['"]([^'"]+)['"]/);
  const context = await browser.newContext(
    storageStateMatch ? { storageState: storageStateMatch[1] } : {}
  );
  const page = await context.newPage();

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
      const current = await snapshotWidgets(page);
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

// Parses one `import <clause> from 'specifier';` clause into its default /
// namespace / named bindings — e.g. `test, { expect, devices as D }` ->
// { default: "test", namespace: null, named: [{imported:"expect",local:"expect"},{imported:"devices",local:"D"}] }.
function parseImportClause(clause) {
  clause = clause.trim();
  const nsMatch = clause.match(/^\*\s+as\s+(\w+)$/);
  if (nsMatch) return { default: null, namespace: nsMatch[1], named: [] };

  const braceMatch = clause.match(/\{([^}]*)\}/);
  const named = braceMatch
    ? braceMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((spec) => {
          const m = spec.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
          return m ? { imported: m[1], local: m[2] || m[1] } : null;
        })
        .filter(Boolean)
    : [];
  const defaultPart = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
  return { default: defaultPart || null, namespace: null, named };
}

/**
 * Runs an existing generated test's real code (not a naive line-by-line
 * replay — a generated spec has variables and closures shared ACROSS steps,
 * e.g. `let status, body;` set in one step and read in a later one, which a
 * per-line executor can't handle correctly) against the live app, and
 * reports which of its own test.step() blocks still succeed.
 *
 * Handles whatever real shape a generated OR hand-authored spec actually
 * has — a bare `test(...)`, a `test.describe(...)` wrapping several `test()`
 * calls, and imports from arbitrary local modules (pages/BasePage.js, a
 * reusable steps/*.js helper, or anything similar) — by resolving every
 * import for real:
 *   - `@playwright/test`'s `test`/`expect` are replaced with a stub `test`
 *     (captures test/describe/step calls instead of registering with
 *     Playwright's real test runner — there isn't one here) and the REAL
 *     `expect` (works standalone outside the runner).
 *   - Everything else is dynamically imported for real (its actual exports,
 *     not a guess at what they might be), resolved relative to the spec
 *     file's own location on disk.
 * The whole (import-stripped) file is then evaluated as one script so real
 * JS scoping/closures across steps and across an import boundary work
 * exactly like they do when the file is actually run as a test.
 *
 * The stub `test.step()` catches a failure INSIDE one step, snapshots the
 * DOM right there, and continues to the next step anyway — mirroring
 * replayAndSnapshotWidgets' per-line resilience, just at the step
 * granularity a real test actually has, so one broken locator early in the
 * flow doesn't prevent finding others further along. Multiple `test()`
 * calls (from a describe block) each get their own fresh browser context,
 * same isolation Playwright's real runner gives each test.
 */
export async function replaySpecAndSnapshotWidgets(specText, { baseUrl, specPath } = {}) {
  const browser = await chromium.launch();
  const steps = [];
  const seen = new Set();
  const registeredTests = [];
  let currentPage = null;

  const stubTest = (name, fn) => {
    if (typeof fn === "function") registeredTests.push({ name, fn });
  };
  stubTest.describe = (a, b, c) => {
    // Overloads Playwright itself supports: describe(fn), describe(name, fn),
    // describe(name, options, fn) — the body runs synchronously either way,
    // same as the real thing, since it just calls test()/test.step() itself.
    const fn = typeof c === "function" ? c : typeof b === "function" ? b : typeof a === "function" ? a : null;
    if (fn) fn();
  };
  stubTest.describe.only = stubTest.describe;
  stubTest.describe.skip = () => {}; // a skipped block's tests are intentionally not run
  stubTest.only = stubTest;
  stubTest.skip = () => {}; // a skipped test is intentionally not run — nothing to check
  stubTest.beforeEach = () => {}; // no per-test setup hook here — documented limitation, not silently wrong: a spec relying on one will just run its steps without it
  stubTest.afterEach = () => {};
  stubTest.step = async (label, fn) => {
    let error = null;
    try {
      await fn();
    } catch (err) {
      error = String(err?.message || err);
    }
    if (currentPage) {
      await currentPage.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      const current = await snapshotWidgets(currentPage).catch(() => []);
      const newWidgets = current.filter((w) => !seen.has(widgetKey(w)));
      newWidgets.forEach((w) => seen.add(widgetKey(w)));
      steps.push({ step: label, ok: !error, replayError: error, newlyVisibleWidgets: newWidgets });
    }
    // Deliberately NOT rethrown — a step failing (a locator that no longer
    // resolves) shouldn't stop the rest of the test from being checked too.
  };

  const importRe = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
  const paramNames = [];
  const paramValues = [];
  let m;
  while ((m = importRe.exec(specText))) {
    const [, clause, specifier] = m;
    if (specifier === "@playwright/test") {
      for (const { imported, local } of parseImportClause(clause).named) {
        if (imported === "test") {
          paramNames.push(local);
          paramValues.push(stubTest);
        } else if (imported === "expect") {
          paramNames.push(local);
          paramValues.push(expect);
        }
      }
      continue;
    }
    if (!specPath) continue; // can't resolve a relative import without knowing where the spec file lives
    const resolvedUrl = pathToFileURL(path.resolve(path.dirname(specPath), specifier)).href;
    const mod = await import(resolvedUrl);
    const { default: def, namespace, named } = parseImportClause(clause);
    if (def) {
      paramNames.push(def);
      paramValues.push(mod.default);
    }
    if (namespace) {
      paramNames.push(namespace);
      paramValues.push(mod);
    }
    for (const { imported, local } of named) {
      paramNames.push(local);
      paramValues.push(mod[imported]);
    }
  }
  paramNames.push("process");
  paramValues.push(process);

  const body = specText.replace(/^import .*$/gm, "").trim();
  try {
    const runFile = new Function(...paramNames, `return (async () => { ${body} })();`);
    await runFile(...paramValues); // registers test(s) via the stub — doesn't run them yet

    for (const { fn } of registeredTests) {
      const context = await browser.newContext(baseUrl ? { baseURL: baseUrl } : {});
      currentPage = await context.newPage();
      await fn({ page: currentPage }).catch((err) => {
        // Top-level error only (anything inside a test.step() was already
        // caught and recorded above without stopping the run).
        steps.push({ step: "(outside any test.step)", ok: false, replayError: String(err?.message || err), newlyVisibleWidgets: [] });
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return steps;
}

/**
 * Extend/continue mode's grounding step: runs an EXISTING generated test's
 * own steps for real (same import/stub machinery as
 * replaySpecAndSnapshotWidgets above), stopping right before its final
 * logout step, then captures the live browser context's storageState()
 * while the session is still authenticated — so a human recording the NEXT
 * part of a scenario that's grown bigger doesn't have to re-click through
 * login and every earlier step by hand, `playwright codegen --load-storage`
 * can just resume from exactly where this left off.
 *
 * Deliberately narrower than replaySpecAndSnapshotWidgets: extend/continue
 * only makes sense for a single linear flow, so this only looks at the
 * FIRST registered test in the file (a `test.describe` with several tests,
 * like a login spec's success/failure pair, isn't "one scenario" to
 * continue — that's a real, stated limitation, not a silent guess). Unlike
 * the scan replay, a failure here is NOT swallowed and continued past: if
 * the existing test can't even get to where it normally stops, there's
 * nothing valid to extend FROM, so this throws and lets the caller tell the
 * human to fix the existing test first (Update or Analyze & heal).
 *
 * The "final logout step" is found by label match (`/log\s*s?\s*out/i`) —
 * every generated test wraps its closing `basePage.logout()` in a
 * `test.step('And the user logs out', ...)` per enrich.js's own system
 * prompt, so this is checking the exact convention that prompt enforces,
 * not guessing at one. A file with no matching step (e.g. a negative test
 * that never successfully logs in) runs to the end instead.
 */
export async function runSpecUpToLogout(specText, { baseUrl, specPath } = {}) {
  const browser = await chromium.launch();
  const ranStepLabels = [];
  let stoppedBeforeLogout = false;
  const registeredTests = [];

  const stubTest = (name, fn) => {
    if (typeof fn === "function") registeredTests.push({ name, fn });
  };
  stubTest.describe = (a, b, c) => {
    const fn = typeof c === "function" ? c : typeof b === "function" ? b : typeof a === "function" ? a : null;
    if (fn) fn();
  };
  stubTest.describe.only = stubTest.describe;
  stubTest.describe.skip = () => {};
  stubTest.only = stubTest;
  stubTest.skip = () => {};
  stubTest.beforeEach = () => {};
  stubTest.afterEach = () => {};
  stubTest.step = async (label, fn) => {
    if (stoppedBeforeLogout) return; // already past the stop point — don't run anything after it
    if (/log\s*s?\s*out/i.test(label)) {
      stoppedBeforeLogout = true;
      return;
    }
    await fn(); // real error here is NOT caught — see header comment, this should throw
    ranStepLabels.push(label);
  };

  const importRe = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
  const paramNames = [];
  const paramValues = [];
  let m;
  while ((m = importRe.exec(specText))) {
    const [, clause, specifier] = m;
    if (specifier === "@playwright/test") {
      for (const { imported, local } of parseImportClause(clause).named) {
        if (imported === "test") {
          paramNames.push(local);
          paramValues.push(stubTest);
        } else if (imported === "expect") {
          paramNames.push(local);
          paramValues.push(expect);
        }
      }
      continue;
    }
    if (!specPath) continue;
    const resolvedUrl = pathToFileURL(path.resolve(path.dirname(specPath), specifier)).href;
    const mod = await import(resolvedUrl);
    const { default: def, namespace, named } = parseImportClause(clause);
    if (def) {
      paramNames.push(def);
      paramValues.push(mod.default);
    }
    if (namespace) {
      paramNames.push(namespace);
      paramValues.push(mod);
    }
    for (const { imported, local } of named) {
      paramNames.push(local);
      paramValues.push(mod[imported]);
    }
  }
  paramNames.push("process");
  paramValues.push(process);

  const body = specText.replace(/^import .*$/gm, "").trim();
  try {
    const runFile = new Function(...paramNames, `return (async () => { ${body} })();`);
    await runFile(...paramValues); // registers test(s) via the stub — doesn't run them yet

    if (!registeredTests.length) {
      throw new Error("No test(...) call found in this spec — nothing to run.");
    }
    if (registeredTests.length > 1) {
      throw new Error(
        `This file registers ${registeredTests.length} separate test() calls (likely a test.describe with more than one scenario) — Extend only supports a single-flow spec. Continue from the flow's own file directly, or split it first.`
      );
    }

    const context = await browser.newContext(baseUrl ? { baseURL: baseUrl } : {});
    const page = await context.newPage();
    await registeredTests[0].fn({ page }); // real error propagates — see header comment

    const storageState = await context.storageState();
    return { storageState, stoppedBeforeLogout, ranStepLabels };
  } finally {
    await browser.close();
  }
}
