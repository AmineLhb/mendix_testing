/**
 * Phase B — Enrich.
 *
 * Takes a raw Playwright codegen recording (dumb clicks/fills, no
 * assertions) plus a live DOM snapshot of the app, and asks the model
 * to rewrite it as a maintainable test using:
 *   - mx-name-* locators (via BasePage.mx())
 *   - waitForMendixIdle() instead of fixed sleeps
 *   - real assertions inferred from what the recording actually did
 *
 * Usage:
 *   GROQ_API_KEY=gsk_... node explorer/enrich.js \
 *     explorer/raw-login-flow.spec.js \
 *     https://your-mendix-app-url \
 *     generated-tests/login-flow.spec.js
 *
 * Uses Groq's OpenAI-compatible API (https://api.groq.com/openai/v1).
 * Never hardcode the key in this file — always pass it via the
 * GROQ_API_KEY environment variable, and keep it out of anything
 * you commit to git (add a .env to .gitignore if you use one).
 */
import OpenAI from "openai";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Load local .env (if present) so developers can store GROQ_API_KEY locally.
if (fs.existsSync(path.resolve(process.cwd(), '.env'))) {
  // dynamic import to avoid requiring dotenv in environments where it's not used
  await import('dotenv').then((d) => d.config({ path: path.resolve(process.cwd(), '.env') }));
}

const argv = process.argv.slice(2);
const dryRunIdx = argv.indexOf('--dry-run');
const dryRun = dryRunIdx > -1;
if (dryRun) argv.splice(dryRunIdx, 1);
const [rawScriptPath, appUrl, outputPath] = argv;

if (!rawScriptPath || !appUrl || !outputPath) {
  console.error(
    "Usage: node explorer/enrich.js <raw-recording.spec.js> <app-url> <output.spec.js> [--dry-run]"
  );
  process.exit(1);
}

const rawScript = fs.readFileSync(rawScriptPath, "utf-8");

/**
 * A single static snapshot of mx-name-* widgets only ever sees whatever page
 * the recording's raw goto() lands on (almost always the login page) — any
 * widget used later in the flow (post-login, post-navigation, inside a
 * dialog) is invisible to that snapshot, so the model has to guess/hallucinate
 * those names. Instead, actually replay the recording action-by-action in a
 * real browser and snapshot the live widget map after each step, so every
 * page/dialog the flow visits is grounded in real data, not just the first one.
 *
 * This only works because raw Playwright codegen output is one `await page....`
 * statement per line — that's what we split on to get the ordered action list.
 */
async function replayAndSnapshotWidgets(rawScript, appUrl) {
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
        mxNames: el.className.match(/mx-name-\S+/g) || [],
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

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("Set GROQ_API_KEY in your environment first.");
    process.exit(1);
  }

  const replaySteps = await replayAndSnapshotWidgets(rawScript, appUrl);
  if (process.env.ENRICH_DEBUG) {
    fs.writeFileSync("explorer/last-replay-steps.debug.json", JSON.stringify(replaySteps, null, 2));
    console.log("Wrote replay steps to explorer/last-replay-steps.debug.json (ENRICH_DEBUG=1)");
  }

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const system = `You convert raw Playwright codegen recordings of a Mendix web app into
clean, maintainable Playwright tests. Rules:
- Preserve every interaction from the raw recording, in order. Do not omit, merge, or
  collapse any click/fill/select step, even if two steps look similar — a combobox
  selection and a text field fill are both required steps, never drop either.
- Use the shared BasePage class (already exists at pages/BasePage.js, import it via
  \`import { BasePage } from "../pages/BasePage.js";\` — the .js extension is REQUIRED,
  this project uses native ESM and the import fails without it) and its mx(widgetName)
  helper for every locator instead of raw CSS/XPath from the recording.
- You are given the raw recording as a sequence of steps, each with the mx-name-*
  widgets that newly appeared in the DOM after actually replaying that exact step in a
  real browser ("newlyVisibleWidgets" — a widget only appears the FIRST step it becomes
  visible; if it's still relevant later, reuse the name you already saw, don't expect it
  to repeat). For each action, find its widget in the newlyVisibleWidgets of that same
  step or the closest preceding step — this is ground truth from real replay, not a
  guess. Do not invent widget names that never appeared in any step, and do not reuse
  the same widget name for two different elements just because they look similar (e.g.
  a login button and an "add" button are different widgets from different steps — match
  each one to where it actually first appeared, not by guessing or copying a name used
  earlier in the flow).
- Widget names are CASE-SENSITIVE (they're literal CSS class names, e.g. mx-name-VisitHelper
  is not the same as mx-name-visitHelper). Copy each name from newlyVisibleWidgets
  EXACTLY as written — do not lowercase, capitalize, or camelCase-normalize it.
- Mendix's default (unrenamed) widget names are only unique per page, not across the
  whole app — the SAME name (e.g. actionButton1) can legitimately belong to two totally
  different elements at two different steps, and if a dialog/modal renders on top of its
  parent page without unmounting it, BOTH elements can be in the DOM at once. Whenever a
  widget name reappears in newlyVisibleWidgets at a later step with different text/tag
  than its first appearance, treat it as ambiguous: disambiguate by chaining
  \`.filter({ hasText: '...' })\` (using that step's own text field) onto the mx() call,
  e.g. \`basePage.mx('actionButton1').filter({ hasText: 'Valider' })\`, instead of using
  the bare mx() call, so the locator can't accidentally match the earlier element too.
- After every action that likely triggers a server round-trip (button click, save,
  navigation), call await basePage.waitForMendixIdle() before the next step.
- Add a basePage.expectNoErrorMessage() check after key steps.
- Infer and add at least one meaningful assertion per logical step (visible text,
  field value, row count, URL) based on what the recording did — don't just replay
  clicks with zero verification. Assertions MUST use real Playwright APIs only:
  \`await expect(basePage.mx('name')).toBeVisible()\`, \`.toContainText('...')\`,
  \`.toHaveValue('...')\`, or \`await expect(page).toHaveURL(/.../ )\`. Never invent
  methods (no .shouldHaveValue, no calling basePage as a function like basePage(x)) —
  BasePage.mx() returns a Playwright Locator, so assertions go through
  \`expect(locator)\`, imported from "@playwright/test", not through basePage directly.
- The raw recording may contain literal credentials (usernames, emails, passwords)
  typed during manual recording. Never hardcode these in the output. Replace any
  password/secret value with process.env.MENDIX_TEST_PASSWORD, and any username or
  email used to log in with process.env.MENDIX_TEST_USERNAME. Fall back to an empty
  string if the env var is unset (e.g. \`process.env.MENDIX_TEST_PASSWORD ?? ""\`).
- Pay attention to navigation: if a click causes the app to move to a different page
  (a login button, a save button that returns to a list, etc.), any widget from the
  page you were just on no longer exists afterward. Never assert on a pre-navigation
  widget after the click that navigates away from it — assert on it BEFORE that click,
  or assert on widgets from the NEW page after it. When unsure whether a click
  navigates, prefer asserting on something you know is on the resulting page.
- Output ONLY the final .spec.js file contents, no explanation, no markdown fences.
  The output must be syntactically valid JavaScript — double-check every line calls a
  real method that exists on Locator, Page, or BasePage before emitting it.`;

  const userMsg = `Raw Playwright recording, replayed step by step. Each entry is the
action that was executed, followed by the real mx-name-* widgets visible in the DOM
immediately after that action ran (this is ground truth from an actual browser replay,
not a guess — use it to pick correct widget names for the step that comes right after
each one, since that's usually the page/dialog the next action interacts with):

${JSON.stringify(replaySteps, null, 2)}

App URL: ${appUrl}

Write the enriched test file now, covering every action above in order.`;

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 4000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
  });

  const text = (response.choices[0].message.content || "")
    .replace(/^```(js|javascript)?\n?/, "")
    .replace(/```$/, "");

  // Post-generation validation: fail if the model left literal email addresses
  // in the generated test instead of using process.env.MENDIX_TEST_USERNAME.
  const emailRegex = /['"`]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})['"`]/g;
  const foundEmails = Array.from(text.matchAll(emailRegex), (m) => m[1]);
  if (foundEmails.length) {
    console.error("Enriched output contains hardcoded email(s):", foundEmails);
    if (!dryRun) {
      console.error("Refusing to write enriched test. Ensure the model uses process.env.MENDIX_TEST_USERNAME and rerun the enrich step.");
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log("Dry-run mode: generated test validated (no write).\nPreview:\n");
    console.log(text.slice(0, 2000));
    process.exit(foundEmails.length ? 2 : 0);
  }

  fs.mkdirSync(outputPath.split("/").slice(0, -1).join("/"), { recursive: true });
  fs.writeFileSync(outputPath, text);
  console.log(`Wrote enriched test to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
