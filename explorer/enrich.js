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
 *     projects/OccupationalMedicine/generated-tests/collaborateur/login-flow.spec.js \
 *     --role collaborateur
 *
 * Uses Groq's OpenAI-compatible API (https://api.groq.com/openai/v1).
 * Never hardcode the key in this file — always pass it via the
 * GROQ_API_KEY environment variable, and keep it out of anything
 * you commit to git (add a .env to .gitignore if you use one).
 */
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { deriveFeatureText, featurePathFor } from "../scripts/gherkin.js";
import { loadProjectEnv } from "../scripts/project.js";
import { replayAndSnapshotWidgets } from "../scripts/replay-widgets.js";

const argv = process.argv.slice(2);
const dryRunIdx = argv.indexOf('--dry-run');
const dryRun = dryRunIdx > -1;
if (dryRun) argv.splice(dryRunIdx, 1);
const roleIdx = argv.indexOf('--role');
const role = roleIdx > -1 ? argv[roleIdx + 1] : 'collaborateur';
if (roleIdx > -1) argv.splice(roleIdx, 2);
const projectIdx = argv.indexOf('--project');
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);
const [rawScriptPath, appUrl, outputPath] = argv;

// Root .env (GROQ_API_KEY) then the project's .env — see scripts/project.js.
// Only GROQ_API_KEY is actually needed here, but loading both keeps the
// pattern consistent with every other script that touches project state.
await loadProjectEnv(projectName);

if (!rawScriptPath || !appUrl || !outputPath) {
  console.error(
    "Usage: node explorer/enrich.js <raw-recording.spec.js> <app-url> <output.spec.js> [--role <role>] [--project <name>] [--dry-run]"
  );
  process.exit(1);
}

const { resolveRole } = await import('../scripts/roles.js');
const { usernameVar, passwordVar } = resolveRole(role);

// Import specifier for BasePage, computed relative to wherever the output file
// actually lands — generated-tests/<role>/<flow>.spec.js is one directory
// deeper than the old flat generated-tests/<flow>.spec.js, so a hardcoded
// "../pages/BasePage.js" would resolve to the wrong place once role folders
// are involved. Always forward-slash: Node's ESM resolver rejects backslashes
// in relative specifiers, but path.join produces them on Windows.
const basePageImportPath = path
  .relative(path.dirname(outputPath), path.join('pages', 'BasePage.js'))
  .split(path.sep)
  .join('/');
const basePageImportSpecifier = basePageImportPath.startsWith('.')
  ? basePageImportPath
  : `./${basePageImportPath}`;

const rawScript = fs.readFileSync(rawScriptPath, "utf-8");

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("Set GROQ_API_KEY in your environment first.");
    process.exit(1);
  }

  const replaySteps = await replayAndSnapshotWidgets(rawScript);
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
- Widget names in newlyVisibleWidgets are given BARE (e.g. "textBox1"), never with the
  "mx-name-" prefix. basePage.mx(name) already adds that prefix internally — call it as
  \`basePage.mx('textBox1')\`, NEVER \`basePage.mx('mx-name-textBox1')\` (that produces a
  doubled ".mx-name-mx-name-textBox1" selector that matches nothing).
- Use the shared BasePage class (already exists at pages/BasePage.js, import it via
  \`import { BasePage } from "${basePageImportSpecifier}";\` — that exact specifier,
  computed for where this output file actually lives; the .js extension is REQUIRED,
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
  typed during manual recording. Never hardcode these in the output. This test is for
  the "${role}" role, so replace any password/secret value with
  process.env.${passwordVar}, and any username or email used to log in with
  process.env.${usernameVar} — use exactly those two env var names, not the default
  MENDIX_TEST_USERNAME/MENDIX_TEST_PASSWORD ones, unless they're the same (default
  role). Fall back to an empty string if the env var is unset
  (e.g. \`process.env.${passwordVar} ?? ""\`).
- Pay attention to navigation: if a click causes the app to move to a different page
  (a login button, a save button that returns to a list, etc.), any widget from the
  page you were just on no longer exists afterward. Never assert on a pre-navigation
  widget after the click that navigates away from it — assert on it BEFORE that click,
  or assert on widgets from the NEW page after it. When unsure whether a click
  navigates, prefer asserting on something you know is on the resulting page.
- If the recording logs in, end the test with \`await basePage.logout();\` (a real
  BasePage method — clicks the icon-only logout button and confirms the login form
  reappears). This project's local Mendix license caps concurrent signed-in sessions;
  without an explicit logout each test's session sits active until it times out on
  its own, and enough test runs in a row exhausts the seat limit. Skip this only for
  a test that never successfully logs in (e.g. a wrong-credentials negative test).
- Wrap every logical group of actions inside each test in
  \`await test.step('Given/When/Then <plain-English description>', async () => { ... });\`,
  following BDD/Gherkin phrasing — this is what turns Playwright's own HTML report into
  a navigable step-by-step BDD view, and a companion .feature file is later auto-derived
  from these exact labels, so they must read as real Gherkin steps, not code comments:
  - \`Given ...\` for the starting state/preconditions (e.g. "Given the user is on the
    login page").
  - \`When ...\` for the action(s) that drive the scenario (e.g. "When they submit valid
    credentials"). Group a few closely-related raw actions (fill username, fill
    password, click submit) into ONE When step rather than one step per keystroke.
  - \`Then ...\` for the expected outcome / assertions (e.g. "Then they land on the visit
    list page"). Assertions belong inside the step whose outcome they're checking, not
    dangling outside all steps.
  - Use \`And ...\` for an additional step of the same kind as the one before it (e.g. a
    second When, or a cleanup action like logout at the end: "And the user logs out").
  - Every test needs at least one Given, one When, and one Then step — do not leave any
    action outside of a test.step() wrapper. Nest the original awaited calls inside each
    step's callback exactly as you would have written them un-wrapped; wrapping must not
    change what the test does, only how it's grouped for reporting.
  - Write these as a real tester would narrate the scenario out loud — third person,
    present tense, no implementation detail like widget names or CSS selectors in the
    label text itself (that stays in the code inside the step).
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
    model: "openai/gpt-oss-120b",
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
      console.error(`Refusing to write enriched test. Ensure the model uses process.env.${usernameVar} and rerun the enrich step.`);
      process.exit(1);
    }
  }

  const fallbackTitle = path.basename(outputPath, ".spec.js");
  const featureText = deriveFeatureText(text, fallbackTitle);
  const featurePath = featurePathFor(outputPath);

  if (dryRun) {
    console.log("Dry-run mode: generated test validated (no write).\nPreview:\n");
    console.log(text.slice(0, 2000));
    console.log(`\n--- Derived ${featurePath} preview ---\n`);
    console.log(featureText ?? "(no test.step() calls found — no .feature would be written)");
    process.exit(foundEmails.length ? 2 : 0);
  }

  // path.dirname (not manual "/" splitting) so this works with the
  // backslash-separated paths path.join() produces on Windows.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text);
  console.log(`Wrote enriched test to ${outputPath}`);

  // Derived from the spec's own test.step() labels — see scripts/gherkin.js.
  // If the model didn't use test.step() for some reason, skip silently rather
  // than writing an empty/useless .feature file.
  if (featureText) {
    fs.writeFileSync(featurePath, featureText);
    console.log(`Wrote BDD feature doc to ${featurePath}`);
  } else {
    console.warn(`No test.step() calls found in the generated test — skipped writing ${featurePath}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
