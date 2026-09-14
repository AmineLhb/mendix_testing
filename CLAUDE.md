# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Record-once, AI-enrich, regress-forever E2E testing for Mendix apps, built
on Playwright. Multi-project: each Mendix app under test lives in its own
`projects/<name>/` folder with its own tests, roles, and credentials, all
driven from the same tool. See [README.md](README.md) for the full
narrative and [TESTING_GUIDE.md](TESTING_GUIDE.md) for the day-to-day
command sequence.

## Commands

- `npm run ui` — local web UI (record/run/report/manage projects) at
  `http://localhost:4300`; a thin wrapper around the CLI commands below,
  not a separate implementation.
- `node scripts/scan-app.js <role> [--project <name>] [--max-pages N]` —
  Mendix App Scanner: logs in once, crawls same-origin nav-like widgets,
  saves `projects/<name>/explorer/app-scan/<role>.json` (also the UI's App
  Scan tab).
- `node scripts/run-benchmark.js` — walks `evaluation/` and scores whatever
  cases are populated there (currently 0 — scaffolding only, see
  `evaluation/README.md`).
- `node scripts/suggest-assertions.js <role> <flow-name>` — AI-suggested
  additional assertions for an existing test (review-only, never
  auto-inserted).
- `node scripts/generate-from-description.js <role> "<description>"` — turns
  plain English into a BDD plan, grounded only in widgets the App Scanner
  has actually found for that role (unresolved steps still need recording
  for real).
- `node scripts/pr-comment-summary.js [junit.xml path]` — markdown summary
  of a JUnit results file, used by the CI workflow's PR comment step.
- `npm run new-test -- <role> <flow-name>` — record a manual test pass and
  AI-enrich it into a maintainable Playwright test in one step (add
  `--project <name>` for a non-default project).
- `npm test` / `npm run test:ci` — run all tests for the active project
  (`MENDIX_PROJECT=<name>` env var selects the project; defaults to
  `OccupationalMedicine`).
- `npm run test:smoke` — just the `@smoke`-tagged login tests, fast.
- `npx playwright test <role>/` — run one role's tests only (the trailing
  `/` matters — Playwright's CLI arg is a substring match, so a bare role
  name like `admin` also matches `admin-fonctionnel`).
- `npx playwright test <role>/<flow>.spec.js` — run a single test file.
- `npm run report` — open the most recent run's HTML report for the
  active project.
- `npm run validate:generated` — check every project's generated tests
  for hardcoded secrets (also runs in pre-commit and CI).
- `npm run validate:env` — check every project for missing/incomplete
  `.env` vars, informational only.
- `npm run features:sync` — regenerate every `.feature` doc from its
  spec's `test.step()` labels (after hand-editing a spec directly).
- `npm run lint` — eslint.
- `node -e "import('./scripts/project.js').then(m => m.createProject('Name'))"`
  — create a new project.
- `node -e "import('./scripts/project.js').then(m => m.addProjectRole('Project', 'role'))"`
  — add a role to a project.
- `npm run new-test -- <role> <flow-name> --stage` — same as above but
  writes to the pending-review queue instead of `generated-tests/`
  directly (what the UI's Record button always does).
- `npm run new-test -- <role> <flow-name> --extend` — continue an existing
  scenario that's grown new steps: runs the existing test's own steps to a
  logged-in starting point, then only the NEW part needs recording. Always
  stages. Mutually exclusive with `--update`.
- `node scripts/heal.js <role> <flow-name> <old-widget-name>` — propose a
  fix for one named broken locator (writes to the same pending queue).
- `node scripts/heal-scan.js <role> <flow-name>` — scan a whole test for
  every broken locator at once, not just one you already know about.
- `node scripts/auth-boundary-scan.js <lowerRole> <higherRole>` — checks
  whether any widget only ever seen in the higher role's App Scan is also
  visible while logged in as the lower role (needs an App Scan already run
  for both roles).
- `npm run reset-sessions` — read-only report on the Mendix app's own
  `system$session` table (row count, whether `system$user` looks matchable
  by username). `-- --all` clears every session; `-- --role <role>` clears
  just that role's. See "Direct DB session reset" below — needs
  `MENDIX_DB_*` vars filled in first, and the exact schema names are
  UNVERIFIED against any real database from inside this tool.

## Architecture

### Multi-project layout

Every Mendix app under test gets `projects/<name>/`: `.env` (`BASE_URL` +
role credentials, gitignored — the "Default" environment), `environments/<envName>.env`
(same format, gitignored, additional named environments), `roles.json`
(which roles this project has — a plain array, not a fixed global list),
`generated-tests/<role>/*.spec.js` + matching `.feature` docs, `explorer/`
(raw codegen recordings, gitignored) with `explorer/pending/<id>/` for
proposals awaiting review and `explorer/app-scan/<role>.json` for the App
Scanner's output (both gitignored), `playwright-report/` + `test-results/`
(regenerated, gitignored), `run-history.json` (last 20 UI-triggered jobs,
gitignored), `test-history.json` (last 20 runs per test, gitignored — see
"Test quality score, per-test history, flaky detection" below).

Repo-root `evaluation/` (`recordings/`, `expected-tests/`,
`expected-locators/`, `expected-assertions/`, `expected-bdd/`,
`failure-cases/`, `healing-cases/`) is dataset scaffolding for
`scripts/run-benchmark.js` — currently empty (0 cases), so the benchmark
honestly reports "0 cases in dataset" rather than a fabricated score. See
`evaluation/README.md` before populating it.
`scripts/project.js` is the module every other script goes through to
resolve paths/env for "the active project" (`MENDIX_PROJECT` env var, or
`DEFAULT_PROJECT` = `OccupationalMedicine`). Tool-level config not tied
to any one app — currently just `GROQ_API_KEY` — lives in the repo root
`.env` instead, loaded first so it's available regardless of which
project is active.

### The record → enrich → regress pipeline

1. **Record** (`scripts/record-and-enrich.js` drives `playwright codegen`):
   a human clicks through a flow manually in a real browser, logged in as
   a specific role. Raw output goes to
   `projects/<name>/explorer/raw-<role>-<flow>.spec.js` (gitignored — it
   contains literal typed credentials).
2. **Enrich** (`explorer/enrich.js`): replays the raw recording
   action-by-action in a real headless browser, snapshotting the live
   `mx-name-*` widget map after each step — Mendix's built-in stable CSS
   class per named widget is what makes this whole approach work. That
   ground-truth widget data plus the raw actions go to an LLM (Groq,
   `openai/gpt-oss-120b`) to rewrite the recording as a maintainable test:
   `BasePage.mx()` locators, `waitForMendixIdle()` instead of fixed
   sleeps, real assertions, credentials swapped for
   `process.env.<ROLE_VAR>`, and every action grouped into
   `test.step('Given/When/Then ...')` BDD blocks. A companion `.feature`
   file is mechanically derived from those step labels
   (`scripts/gherkin.js`) — the `.spec.js` is the single source of truth;
   never hand-edit a `.feature`, run `npm run features:sync` after
   editing steps instead.
3. **Regress**: every subsequent run (`npm test`, CI, the UI) just runs
   the generated Playwright tests normally.

The UI (and `--stage`) insert a review step between 2 and 3: the enriched
output goes to `projects/<name>/explorer/pending/<role>-<flow>/` instead
of `generated-tests/`, and only a human approving it in the UI moves it
across — see "AI-assisted maintenance" below.

### AI-assisted maintenance (pending review, failure analysis, self-healing)

Three more Groq call sites beyond initial generation, all built on the
same rule as the pipeline above: **never guess a locator, always ground
it in a real replay.**

- **Pending review** (`scripts/project.js`'s `writePending`/`readPending`/
  `approvePending`/`rejectPending`, `ui/server.js`'s `/api/projects/:name/pending*`
  routes): a proposal (`type: "new-test"` or `type: "fix"`) sits in
  `explorer/pending/<id>/` (`meta.json` + `spec.js` + optional
  `spec.feature`/`previous.spec.js`) until approved. `approvePending()`
  itself does the write; the server route runs
  `scripts/check-secrets.js`'s `checkTextForSecrets()` against the
  proposed text *first* and refuses to call it if that fails — the same
  check `scripts/validate-generated-tests.js` runs against files already
  on disk, factored out so both call sites can't drift apart.
- **AI failure analysis** (`scripts/ai-failure-reporter.js`): a custom
  Playwright reporter (wired into `playwright.config.js`'s `reporter`
  array) that calls Groq on any failed test's `onTestEnd` and prints a
  plain-English diagnosis. No-ops without `GROQ_API_KEY` or if the call
  fails — purely additive, never blocks the real test run.
- **Self-healing** (`scripts/heal.js` for one named widget,
  `scripts/heal-scan.js` to check every locator in a test at once): as of
  2026-09-11, both run the test's OWN generated code directly against the
  live app via `scripts/replay-widgets.js`'s `replaySpecAndSnapshotWidgets()`
  — not a separately-kept raw recording. A generated spec already knows how
  to get to the relevant page (it's a real, working Playwright test), so
  there's no reason a locator check should depend on a second file (the raw
  codegen recording) still being on disk. `replaySpecAndSnapshotWidgets()`
  stubs `test`/`test.describe`/`test.step` (captures instead of registering
  with Playwright's real runner — there isn't one here), uses the real
  `expect`, and dynamically resolves every other import (BasePage, a
  reusable `steps/*.js` module, or anything similar) relative to the spec
  file's own path, so it works against whatever shape a real spec actually
  has — a bare `test()`, or a `test.describe()` wrapping several. The model
  picks a replacement only from widgets actually present in that live
  replay, never an invented name. Writes a `type: "fix"` pending proposal;
  approving it patches the existing spec file's `mx('<old>')` calls in
  place (regex-scoped to the literal string argument only, preserving any
  chained `.filter()`). `explorer/enrich.js` still uses the older
  `replayAndSnapshotWidgets()` (raw-recording, action-by-action) since a
  brand-new recording has no existing generated test to run yet.

### Multiple environments

`projects/<name>/.env` is always "Default"; `projects/<name>/environments/<envName>.env`
(gitignored, same format) is an additional named environment (Dev/QA/Staging/...).
`loadProjectEnv(project, environment)` in `scripts/project.js` picks which file to
load based on the `environment` arg or `MENDIX_ENV` — `playwright.config.js` calls
it with no args, so `MENDIX_ENV` (set by the UI's run route, or by hand for the
CLI) is what actually selects it. Both `dotenv.config()` calls there use
`{ override: true }` — verified 2026-09-10 this matters: a stale value already in
`process.env` (e.g. a long-lived shell) otherwise silently wins over the file,
which is exactly what caused `GROQ_API_KEY` to keep resolving to a revoked key
earlier the same session. Every generated test must navigate with a RELATIVE
`page.goto('/')`, never the literal app URL — `explorer/enrich.js`'s system
prompt enforces this for new tests; it was a real pre-existing bug in the 7
hand-authored specs (fixed 2026-09-10) that silently defeated environment
switching since the hardcoded URL just happened to match the Default one.

### Reusable business steps

`steps/business-steps.js` holds action sequences (not `test.step()`-wrapped
themselves) shared across specs that would otherwise duplicate the exact same
flow — currently `submitLogin`/`submitLoginExpectingFailure`, extracted
verbatim from the 5 already-passing login specs, not invented. The CALLING
spec still writes its own `test.step('Given/When/Then ...', () =>
sharedStep(...))` — the BDD label has to stay physically present in the
`.spec.js` file itself, since `scripts/gherkin.js` scans literal `test.step(`
calls there to derive the `.feature` doc; hiding the label inside the shared
module would break that.

### Mendix App Scanner (`scripts/scan-app.js`)

V1, intentionally scoped down from a full Studio Pro project scanner (no
access to pages/microflows/entities at that level — only what a real browser
session sees). Logs in ONCE (not once per page — login volume is a real cost
against the trial license's seat cap, see below), snapshots the landing
page's widgets, then sequentially clicks navigation-like widgets
(`<a>` tags, or `role=menuitem`/`role=button` with `cursor: pointer`),
`page.goBack()`-ing between each. Stops early, rather than guessing, if a
`goBack()` doesn't actually return to the starting nav (some Mendix client
routing may not support real browser history). Output:
`projects/<name>/explorer/app-scan/<role>.json`.

### Extend/continue mode (`record-and-enrich.js --extend`)

For a scenario that's grown new steps at the end (Test Explorer's "Extend
(record more)" button, next to Update and Analyze). Playwright has no way
to literally resume a script mid-run, so this builds the realistic
reduced version of that idea instead of pretending a fuller one exists:

1. `scripts/replay-widgets.js`'s `runSpecUpToLogout()` runs the EXISTING
   test's own steps for real against the live app (same stub-`test`/
   dynamic-import machinery as `replaySpecAndSnapshotWidgets()`), stopping
   right before the step whose label matches `/log\s*s?\s*out/i` — every
   generated test wraps its closing `basePage.logout()` in a step matching
   that, per `enrich.js`'s own system prompt, so this is checking the exact
   convention that prompt already enforces, not inventing one. It then
   captures the live browser context's `storageState()` while still
   authenticated. Only supports a single-`test()` spec (not a
   `test.describe` with several scenarios) — extend/continue only makes
   sense for one linear flow; throws a clear message rather than guessing
   which scenario to continue. A failure replaying the existing test's own
   steps is NOT swallowed (unlike the scan/heal replay) — there's nothing
   valid to extend FROM if the existing test can't even get where it
   normally does, so this aborts and tells the human to fix it first.
2. The captured storageState is written to a short-lived
   `explorer/extend-storage-<role>-<flow>.json` (gitignored, deleted again
   once used) and `playwright codegen` launches with `--load-storage`
   pointing at it — the recorder opens already logged in and already
   partway through the flow, so a human only records the NEW tail.
3. That tail is enriched via `explorer/enrich.js --extend-steps-only` — a
   mode that changes the output contract from "a whole standalone test
   file" to "just the new `test.step()` block(s) to append," and never
   emits its own `basePage.logout()` call. The model is never asked to
   reproduce the surrounding file; that's exactly the kind of large-scale
   regeneration that risks silently corrupting a test that was already
   passing, which cuts directly against "trustworthy, don't ruin my
   passing tests."
4. `record-and-enrich.js`'s `spliceExtendFragment()` then deterministically
   (no AI, plain text/regex) inserts that fragment into the EXISTING spec's
   text, right before its closing logout step, reindented to match. Verified
   directly (2026-09-11): an earlier version that called `.trim()` on the
   whole fragment before measuring indentation corrupted every line after
   the first (`.trim()` only strips the very start/end of the string, not
   each line) — fixed by trimming blank lines off the array ends instead of
   trimming the string, confirmed against a real spliced file with correct,
   consistent indentation and a passing `new Function(...)` syntax check.
5. The spliced full-file result becomes a `type: "extend"` pending
   proposal (same `writePending`/review-queue infrastructure as every
   other proposal type) — a human reviews the diff and approves it, same
   as anything else. Always stages, regardless of `--stage`; the merge
   step always needs review.

`--extend` and `--update` are mutually exclusive (extend continues an
existing test; update replaces it from scratch) — enforced with a clear
error rather than silently picking one.

### Authorization boundary scan (`scripts/auth-boundary-scan.js`)

Cross-role security check, surfaced in the Insights tab. Compares two
roles' already-captured `explorer/app-scan/<role>.json` (run the App
Scanner for both first — this script doesn't crawl itself) and flags any
widget that only ever appeared in the higher-privilege role's scan but is
actually visible in the DOM while logged in as the lower-privilege role —
grounded in a real browser session, same as everything else here, never a
guess. Deliberately does NOT probe URLs directly the way a typical web
pentest would: verified against this project's real app-scan data that
every page shares the identical URL (it's a pure client-side SPA with no
per-page routing), so a URL-based bypass check would be silently
meaningless here — widget visibility is the only honest signal a browser
session can give for this specific app shape.

Guards against a real false-positive trap found while building this: most
widgets in a Mendix app still carry Studio Pro's auto-generated default
name (`container10`, `text11`, `actionButton3`, ...), which collide across
completely unrelated pages constantly (`pages/BasePage.js`'s `logout()`
comment documents one such collision already). A first version of this
script that compared bare widget names alone reported 5 false "findings"
against the real project — every one was an unrelated default-named
widget that happened to share a name with something on an admin-only page.
Fixed by only trusting a default-named widget as a match when its visible
text ALSO matches; a default-named widget with no text at all is skipped
outright as unidentifiable rather than guessed about. A custom-named
widget (a human actually renamed it) is trusted on its own — an accidental
collision there is implausible.

A finding here means the widget is exposed in the UI, not a confirmed
exploit — Mendix commonly also enforces access server-side on the
microflow/entity itself, so this is a "go verify by hand" signal for a
human tester, exactly like every other AI/automation output in this
project, never something auto-filed as a bug.

### Insights: performance analytics, regression intelligence, coverage map, dependencies

All four are pure aggregations in `scripts/project.js` over data already
collected elsewhere — no separate measurement pass:

- `testPerformance()` — avg/P95/min/max per test from `test-history.json`'s
  real durations; flags a test whose latest run was >20% slower than its
  own average (only once it has more than one run to average against).
- `regressionIntelligence()` — groups `test-history.json` entries by the
  `runId` `scripts/test-history-reporter.js` stamps once per
  `onBegin()` (one per `npx playwright test` invocation), diffs the two
  most recent groups' pass/fail per test (new failures / recovered / still
  failing), and reports the real git commit at each run (best effort —
  `execSync('git rev-parse --short HEAD')`, null outside a git repo).
  Entries recorded before `runId` existed (2026-09-10) are excluded from
  grouping rather than guessed into one.
- `coverageMap()` — cross-references a role's `explorer/app-scan/<role>.json`
  against `mx(...)` calls actually found in that role's spec files — a real
  overlap count.
- `testDependencyGraph()` — reads `// depends-on: <role>/<file>.spec.js`
  magic comments (comma-separated) from spec files; detects broken
  references and cycles. Empty today — nothing declares one yet, same
  "honestly empty" pattern as `evaluation/`.

### AI-generated assertions and natural-language test plans

Both capped at "suggestion/plan, not auto-applied" — see each script's own
header comment for why:

- `scripts/suggest-assertions.js` — reviews an EXISTING test, suggests
  additional assertions referencing only widgets already used in that same
  file (never invents one). Output only, never patches the spec.
- `scripts/generate-from-description.js` — plain-English description →
  BDD Given/When/Then plan, each step tentatively mapped to a real widget
  from that role's most recent App Scan if one matches, else marked
  unresolved. Not executable code — turning it into a real test still means
  recording the flow (`npm run new-test`), same as everything else here.
  Server route passes the description via `MENDIX_NL_DESCRIPTION` env var,
  not a CLI arg — verified 2026-09-10 that `jobs.js`'s
  `spawn(cmd, args, { shell: true })` word-splits a multi-word array
  argument on Windows (silently truncating to its first word); an env var
  bypasses that shell re-parsing entirely.

### Secure secrets (masking)

The Settings tab's env editor parses `KEY=VALUE` lines client-side and
renders `password`/`secret`/`token`/`api_key`-matching keys as
`type="password"` by default, with one "Reveal" checkbox for all of them.
Purely a display concern (nothing server-side changes) — a raw-text
`<details>` fallback stays available for content the structured view can't
represent well. Verified round-trips byte-identical (comments/blank lines
preserved) via a real save with no edits.

### Visual regression (opt-in)

`BasePage.expectVisualMatch(name)` wraps Playwright's own
`expect(page).toHaveScreenshot()` — baseline lands in
`generated-tests/<role>/<file>-snapshots/`, `maxDiffPixelRatio: 0.02` set
in `playwright.config.js`. No generated test calls this yet (opt-in);
verified live against static content (not the Mendix app) that baseline
creation, a matching re-run, and a real color-change all behave exactly as
Playwright's own docs describe.

### Accessibility checks (opt-in)

`BasePage.expectNoAccessibilityViolations()` wraps `@axe-core/playwright`'s
`AxeBuilder`, scanning the current page state against axe-core's own
default WCAG 2.0/2.1 A+AA tag set (override via `options.tags`). Same
opt-in shape as `expectVisualMatch()` — no generated test calls it yet,
inert until one does; call it after `waitForMendixIdle()` so it isn't
scanning mid-render markup. Throws with every violation's rule id, impact,
and a real CSS selector, not just pass/fail. Verified live against
`OccupationalMedicine` (2026-09-11, logged in as collaborateur): found 4
real violations (missing button labels, low color contrast, missing image
alt text, an aria-hidden element that's still focusable) — axe-core's own
DOM analysis is the ground truth, this project never guesses which
elements are inaccessible. One real gotcha hit while verifying: AxeBuilder
needs a `page` that came from an explicit `browser.newContext()` — a plain
`browser.newPage()` throws "Please use browser.newContext()". Not an issue
for any actual generated test, since Playwright's own `test(...)` fixture
already backs `page` with a context; only matters for an ad-hoc script
outside the normal test runner.

### Roles are per-project data, not a fixed list

`scripts/roles.js` only owns the *naming convention* — given a role name,
which env vars hold its credentials (`resolveRole()`: `collaborateur` →
unsuffixed `MENDIX_TEST_USERNAME`/`PASSWORD`; every other role →
`_<ROLE>`-suffixed) — as a pure function, not a lookup table. *Which*
roles exist for a given app is `projects/<name>/roles.json`, read/written
via `readProjectRoles()`/`addProjectRole()` in `scripts/project.js`. This
split is what lets different Mendix apps define completely different
roles without touching shared code.

### `pages/BasePage.js`

Shared across every project — only generic Mendix conventions, nothing
app-specific. Key methods: `mx(name)` (locator via `.mx-name-<name>`,
Mendix's built-in per-widget CSS class), `waitForMendixIdle()`,
`expectNoErrorMessage()`, `captureApiResponse()` / `expectApiSuccess()`
(asserts on the actual `/xas/` API response body rather than just the
DOM, and turns an HTTP 402 into a specific "license seat limit reached"
message instead of a generic timeout). `logout()` targets a selector
(`.mx-name-actionButton2.logout`) verified against `OccupationalMedicine`
specifically — re-verify it before trusting it against a different
project's app.

### The local UI (`ui/`)

`ui/server.js` (Express) is a thin wrapper, not a reimplementation —
every button spawns the same CLI commands (`ui/jobs.js` runs them as
child processes, streamed to the browser over SSE) or edits the same
files (`.env`, `roles.json`) a person would by hand. `ui/public/` is
vanilla HTML/CSS/JS, no build step. Per-project, the UI is seven tabs:
Tests (filterable by role/tag/status/search — client-side over the
already-loaded list, no round-trip per keystroke), Coverage, Runs
(scope + environment picker), Review (record, self-heal, suggest
assertions, generate-from-description, pending review), App Scan,
Insights (performance/regression intelligence/coverage map/dependencies),
Settings (env picker now manages Default plus any named environments,
masked secret fields). The log/terminal
panel and source viewer are pinned outside the tabs (section-level, not
tab-scoped) since actions from any tab can stream a job. While a job is
running, the UI locks competing actions (a second run, rename, delete,
switching project) — starting two jobs at once means two browser
sessions, and the seat cap below makes that actively harmful, not just
confusing.

### Test quality score, per-test history, flaky detection (Tests tab)

- **Quality score** (`scripts/confidence.js`'s `scoreTestQuality()`) —
  deterministic, no LLM call: inspects a spec file for locator stability
  (`mx()` vs. raw `page.locator()`), assertion coverage, fixed-wait usage
  (`waitForTimeout()` costs points), and BDD structure. Computed live for
  every row in the Tests tab and included in a pending proposal's
  `meta.json` (both `record-and-enrich.js --stage` and `heal.js` call it)
  so a reviewer sees it before approving. Also reports (but deliberately
  does NOT fold into `overall`, since it's a coverage-completeness signal
  rather than a maintainability one) `breakdown.negativePathCoverage` — a
  heuristic read on whether the test checks anything besides the happy
  path (error/invalid/unauthorized-style keywords and error-assertion
  calls, scored against the test's own step count). Shown as a small badge
  under the quality bar in the Tests tab; `0%` renders as "happy-path
  only."
- **Per-test history** (`scripts/test-history-reporter.js`, a Playwright
  reporter) appends one entry — status, duration, and the failure
  screenshot's path if any — to `projects/<name>/test-history.json` from
  inside the actual test process on every `onTestEnd`, keyed by
  `<role>/<file>`. `ui/server.js` serves those screenshots at
  `/artifacts/:project/*` (same static-mount pattern as `/report/:project`).
- **Flaky detection** (`computeFlaky()` in `scripts/project.js`) reads
  that history: a test is flaky only if its recent runs are a genuine mix
  of pass/fail (not simply always-failing), and only after at least 3
  runs. Surfaced per-row in the Tests tab and in the per-test history
  panel.
- **Coverage matrix** (`roleCoverageMatrix()` in `scripts/project.js`) —
  a flow × role grid built by scanning `generated-tests/` directly, no
  separate tracking.

### Automatic session clearing — once per run AND after every test

Two layers, both wrapping `reset-mendix-sessions.js --all --yes`, added
2026-09-11 after live testing showed the trial license's seat cap is tight
enough that even a single-worker run can exhaust it partway through (see
README's "Known issue" section — this predates today's changes, not
something introduced by them):

- **`playwright.config.js`'s `globalSetup`** (`scripts/global-setup.js`)
  clears everything ONCE before the run starts — catches whatever's
  stranded from a previous run/crash/manual browser tab.
- **`scripts/test-history-reporter.js`'s `onTestEnd`** (its
  `clearSessionsAfterTest()` helper) clears everything again after EVERY
  individual test attempt finishes (including each retry — `onTestEnd`
  fires per attempt, confirmed live: a retried test's own AI-analysis log
  line appears once per attempt too) — catches seat pressure that builds
  up DURING a long run, which the once-per-run clear can't.

Both fire regardless of entry point (`npx playwright test`, `npm test`, a
UI-spawned run job) since they're wired into shared config/reporter code,
not something each generated spec has to opt into. Both silently no-op
(not a hard failure) when `MENDIX_DB_*` isn't configured for the active
project/environment, and also silently no-op on a genuine connection
error — this is a best-effort mitigation, not something a test run should
hard-fail on; the existing app-level mitigations (`workers: 1`,
`retries: 1`, every test's own `logout()`) still apply regardless.
Verified 2026-09-11: both layers actually clear real session rows when DB
vars are set (confirmed via direct invocation, not just log output), and
both no-op cleanly without DB config.

### Direct DB session reset (`scripts/reset-mendix-sessions.js`, `scripts/db.js`)

A second, more direct way at the seat-cap problem below: instead of only
relying on every generated test's own `logout()` (app-level, can still
race or leave a stale session on a crash/interrupted run — see "Known
constraint" just below), connect straight to the Mendix app's own Postgres
database and clear session rows there. Requires `MENDIX_DB_HOST/PORT/NAME/
USER/PASSWORD` filled in for the active environment (`defaultEnvTemplate()`
now pre-fills the names with `MENDIX_DB_HOST=localhost`/`PORT=5432`
defaulted, `NAME`/`USER`/`PASSWORD` left blank) — for a local Studio Pro
run, the real host/port are in Studio Pro's App Settings > Configurations
> (active config) > Database, not something this tool can discover itself.

Built with the same "never guess, ground it in something real" discipline
as every other feature here, applied to a DB schema instead of a browser
DOM. Default action (no flags) is `list` — READ-ONLY, and deliberately
terse: just the current session count and whether `--role` is available;
full column-level detail moved behind `--describe` (2026-09-11) after
real use showed the original always-on schema dump was just noise for
everyday checking, not something a user needs to see on every click.

`--all` (deletes every session — fine for a local/trial DB with no other
real users, which is exactly the case this exists for) and `--role <role>`
both prompt for confirmation unless `--yes` is given, and both refuse to
guess and abort with a clear message rather than deleting the wrong thing
if the expected table/column isn't found — this already caught one real
mistake: `--role` originally assumed `system$session` had a direct
`userid` column linking it to `system$user` (a reasonable guess, wrong in
practice) and errored out safely instead of silently deleting nothing or
the wrong rows. Verified live (2026-09-11) that Mendix instead links them
through a separate `system$session_user` junction table
(`system$sessionid`/`system$userid` columns — standard convention for a
many-to-many association), fixed to join through that, and confirmed with
a synthetic session row that `--role` now deletes exactly the right one
(and only that one) with no orphaned junction row left behind.

### Known constraint: trial Mendix license seat cap

The local Studio Pro dev license caps concurrent signed-in sessions.
Every generated test ends with `basePage.logout()` specifically to free
its seat immediately. `playwright.config.js` sets `workers: 1` (parallel
logins cause real, non-flaky failures against this environment) and
`retries: 1` (absorbs a seat-release race). Testing role-by-role
(`npx playwright test <role>/`) rather than the whole suite at once is
the practical workaround until a non-trial license is available — see
README's "Known issue" section for full detail.

### Cross-browser coverage (opt-in, `MENDIX_TEST_BROWSERS`)

`playwright.config.js` only defines named `projects` (chromium/firefox/webkit,
via Playwright's own `devices` presets) when `MENDIX_TEST_BROWSERS` (comma-
separated) is set — unset by default, so behavior is completely unchanged
unless a caller opts in. Verified 2026-09-11: unset still lists the same 12
tests with no project prefix; `MENDIX_TEST_BROWSERS=chromium,firefox` lists
24 (each test under each named project), and `baseURL`/`screenshot`/etc.
from the top-level `use` block still apply per Playwright's normal
project/top-level `use` merge. Deliberately NOT the default — the local
trial Mendix license's concurrent-session seat cap (see "Known constraint"
below) means every browser project multiplies login volume by N against
that same cap, directly working against the `workers: 1`/`retries: 1`
mitigations already in place for a single browser. Turn it on once `BASE_URL`
points at a non-trial environment.

## CI (`.github/workflows/regression.yml`)

Runs on push to `main`, every PR, and nightly at 03:00 UTC (the schedule
is only meaningful once `BASE_URL` points at a stable, non-trial
environment). Validates generated tests for secrets, runs the suite
against `OccupationalMedicine` using repository secrets, uploads the HTML
report + `junit.xml` as artifacts, writes a job-summary link, posts/updates
a PR comment with a pass/fail summary (`scripts/pr-comment-summary.js` +
`actions/github-script`, `pull_request` events only — a hidden HTML
comment marker is how it finds its own prior comment to edit instead of
piling up a new one per push; needs the job's `pull-requests: write`
permission, already set), and notifies a Slack webhook on failure (inert
until a `SLACK_WEBHOOK_URL` secret is added). Verified: the workflow YAML
parses correctly (`js-yaml`) and `pr-comment-summary.js` produces correct
markdown against a real `junit.xml`; the PR-comment step itself couldn't be
exercised against a real PR from this environment. `.github/dependabot.yml`
keeps npm deps and Actions versions current — mainly to catch
`@playwright/test` drifting out of step with the Playwright browser
binaries CI installs.
