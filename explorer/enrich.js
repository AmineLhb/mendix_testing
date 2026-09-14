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
// --extend-steps-only: used by Extend/continue mode (record-and-enrich.js
// --extend) for a raw recording that's just the NEW tail of an existing
// scenario, captured starting from a storageState snapshot (already
// logged in, already partway through the flow) rather than from scratch.
// Changes the output contract from "a whole standalone test file" to "just
// the new test.step() block(s) to append" — record-and-enrich.js splices
// those deterministically into the existing spec itself; the model is
// never asked to reproduce the surrounding file, which is exactly the kind
// of large-scale text regeneration that risks silently corrupting a test
// that was already passing.
const extendStepsOnlyIdx = argv.indexOf('--extend-steps-only');
const extendStepsOnly = extendStepsOnlyIdx > -1;
if (extendStepsOnly) argv.splice(extendStepsOnlyIdx, 1);
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
- For a delete/remove action (the recording clicks a delete-type button and the
  target row disappears from a list), don't just assert the row is gone — verify the
  delete actually happened, three ways: (1) capture the list's row locator's
  \`.count()\` BEFORE the delete click and again AFTER, then
  \`expect(countAfter).toBe(countBefore - 1)\` — never hardcode an assumed absolute
  count, always compare against the real before-count; (2) assert the specific
  deleted row's identifying locator (disambiguated with \`.filter({ hasText: '...' })\`
  the same way ambiguous widgets are handled elsewhere) is gone via
  \`await expect(...).toHaveCount(0)\`; (3) wrap the delete click itself with
  \`basePage.captureApiResponse(() => ..., { matchBody: ... })\` and call
  \`basePage.expectApiSuccess({ status, body })\` so a delete that fails server-side
  but still updates the list optimistically in the UI doesn't pass by accident.
- For a file/document upload action (a \`setInputFiles\` call, or a click on a widget
  that is clearly a file/document picker), wrap the triggering action with
  \`basePage.captureApiResponse\` and call \`basePage.expectApiSuccess({ status, body })\`
  to confirm the upload succeeded server-side — a success toast alone doesn't prove
  the file was actually persisted. If the response body contains the created/updated
  object, use \`basePage.findApiObject(body, '<ObjectType>')\` (best guess at the
  Mendix entity name from context) and assert on a field that indicates the file is
  really attached, rather than stopping at the UI toast.
- For a workflow-transition action (a button whose visible text is a verb like
  Validate/Submit/Approve/Return/Reject/Recall/Cancel — common in Mendix approval
  workflows), assert on the resulting status text/badge becoming visible with the
  expected value after the transition, using the widget from the following step's
  newlyVisibleWidgets exactly like any other post-action assertion — a workflow
  status change is ground truth from replay, not a guess, so treat it the same way.
- These three patterns are instances of one rule: for any action with a real server
  round trip worth confirming (create, update, delete, upload, a workflow-status
  change), prefer combining a DOM assertion with an API-response check via
  captureApiResponse + expectApiSuccess + findApiObject over a single toBeVisible() —
  always using only the real BasePage/Locator/expect APIs already listed above, never
  an invented method, and only when the recording's own actions actually exercise
  that kind of round trip (don't add an upload/delete/workflow check to a step that
  wasn't one).
- The raw recording may contain literal credentials (usernames, emails, passwords)
  typed during manual recording. Never hardcode these in the output. This test is for
  the "${role}" role, so replace any password/secret value with
  process.env.${passwordVar}, and any username or email used to log in with
  process.env.${usernameVar} — use exactly those two env var names, not the default
  MENDIX_TEST_USERNAME/MENDIX_TEST_PASSWORD ones, unless they're the same (default
  role). Fall back to an empty string if the env var is unset
  (e.g. \`process.env.${passwordVar} ?? ""\`).
- The raw recording's initial \`page.goto('${appUrl}...')\` (or any goto to that same
  origin) must become a RELATIVE \`page.goto('/')\` (or the relative path only, e.g.
  \`page.goto('/p/somepage')\`) in the output, never the absolute URL. Playwright's
  configured \`baseURL\` (this project's BASE_URL env var) already resolves relative
  gotos — hardcoding the absolute app URL would make the test always hit that one
  literal address even when run against a different environment (see "Multiple
  environments" in the docs), defeating the whole point of BASE_URL being
  configurable per environment.
- Pay attention to navigation: if a click causes the app to move to a different page
  (a login button, a save button that returns to a list, etc.), any widget from the
  page you were just on no longer exists afterward. Never assert on a pre-navigation
  widget after the click that navigates away from it — assert on it BEFORE that click,
  or assert on widgets from the NEW page after it. When unsure whether a click
  navigates, prefer asserting on something you know is on the resulting page.
${
  extendStepsOnly
    ? `- Do NOT add a \`basePage.logout()\` call anywhere in your output — see EXTEND MODE
  below, the scenario this gets appended to already has its own closing logout step.`
    : `- If the recording logs in, end the test with \`await basePage.logout();\` (a real
  BasePage method — clicks the icon-only logout button and confirms the login form
  reappears). This project's local Mendix license caps concurrent signed-in sessions;
  without an explicit logout each test's session sits active until it times out on
  its own, and enough test runs in a row exhausts the seat limit. Skip this only for
  a test that never successfully logs in (e.g. a wrong-credentials negative test).`
}
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
${
  extendStepsOnly
    ? `- EXTEND MODE — this is NOT a full test. This raw recording is only the NEW tail of an
  already-existing, already-passing scenario: it starts from a storageState snapshot
  (already logged in, already partway through the flow), not from a blank page.
  Output ONLY one or more \`await test.step('Given/When/Then ...', async () => { ... });\`
  block(s) covering the actions above, in order — NOT a \`test(...)\` wrapper, NOT any
  \`import\` lines, NOT a \`basePage.logout()\` call (the existing scenario this gets
  appended to already ends with its own logout step — do not add a second one). Assume
  \`page\` and \`basePage\` are already in scope exactly as an existing test.step() body
  would see them. If a value needs to flow from one of your new steps to another
  (e.g. an API response's status/body), declare it with \`let\` INSIDE the first step
  that needs it and read it from a step you also wrote — do not assume any variable
  from the ORIGINAL scenario's earlier steps is still in scope, since this fragment is
  spliced in textually and can't see those steps' local variables.
  Output ONLY the new test.step() block(s), no explanation, no markdown fences, no
  surrounding test()/describe() wrapper.`
    : `- Output ONLY the final .spec.js file contents, no explanation, no markdown fences.
  The output must be syntactically valid JavaScript — double-check every line calls a
  real method that exists on Locator, Page, or BasePage before emitting it.`
}`;

  const userMsg = `Raw Playwright recording, replayed step by step. Each entry is the
action that was executed, followed by the real mx-name-* widgets visible in the DOM
immediately after that action ran (this is ground truth from an actual browser replay,
not a guess — use it to pick correct widget names for the step that comes right after
each one, since that's usually the page/dialog the next action interacts with):

${JSON.stringify(replaySteps, null, 2)}

App URL: ${appUrl}

${
  extendStepsOnly
    ? "Write the new test.step() block(s) now, covering every action above in order — nothing else."
    : "Write the enriched test file now, covering every action above in order."
}`;

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

  if (extendStepsOnly) {
    // Just the new step fragment — no whole-file .feature derivation makes
    // sense here (see this file's --extend-steps-only comment); the caller
    // (record-and-enrich.js --extend) splices this text into the existing
    // spec and re-derives the .feature from THAT once it's a real file.
    if (dryRun) {
      console.log("Dry-run mode: new step fragment validated (no write).\nPreview:\n");
      console.log(text.slice(0, 2000));
      process.exit(foundEmails.length ? 2 : 0);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text);
    console.log(`Wrote new step fragment to ${outputPath}`);
    return;
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
