# Testing Guide — command sequence for a new manual test

This is the practical, copy-paste guide for the actual day-to-day loop:
record a manual test pass once, turn it into real test code, run that one
test, then run the full regression suite. For the "why" behind each piece,
see [README.md](README.md).

**Prefer clicking over typing?** `npm run ui` opens a browser UI, organized
into seven tabs per project: **Tests** (every generated test with its
quality score, latest pass/fail, and flaky flag — see [Test explorer,
quality score, and flaky
detection](#test-explorer-quality-score-and-flaky-detection) below),
**Coverage** (role × flow matrix), **Runs** (run by role/file/tag, recent
runs, the report link), **Review** (record a new test, fix an existing one,
and the pending-approval queue — see [Fixing an existing
test](#fixing-an-existing-test-update-analyze-extend) below), **App Scan**
(crawl the app as a given role), **Insights** (performance trends,
regression intelligence, the coverage map, and the [authorization boundary
scan](#authorization-boundary-scan)), and **Settings** (`.env` editor,
[Mendix sessions](#resetting-stuck-mendix-sessions), rename/delete).
See the "UI" section in [README.md](README.md#ui).
Recording through the UI always goes through the [pending-review
queue](#reviewing-an-ai-generated-test-before-it-counts) below rather
than writing straight to `generated-tests/`. Everything below is the
same workflow via the CLI directly; useful when you want more control,
or for CI, which always uses the CLI.

Tests are organized per project, per app role:
`projects/<project>/generated-tests/<role>/<flow-name>.spec.js`. Replace
`<project>` below with the app you're testing — `OccupationalMedicine` is
the first one and the default (`scripts/project.js`'s `DEFAULT_PROJECT`),
so you can omit `--project <project>`/`MENDIX_PROJECT` entirely when
working on it. Replace `<role>` with one of `collaborateur`
(default/regular user), `medecin`, `infirmier`, `admin-fonctionnel`, or
`admin` — the exact list lives in `scripts/roles.js`. Replace `<app-url>`
with the app you're testing (e.g. `http://localhost:8080` for a local
Studio Pro run, or your deployed test environment URL). Replace
`<flow-name>` with a short name for the flow you're recording (e.g.
`create-visit`, `validate-visit`).

## 0. One-time setup

Copy `.env.example` to `.env` at the **repo root** and fill in
`GROQ_API_KEY` (tool-level, shared across every project). Then copy
`projects/<project>/.env.example` to `projects/<project>/.env` and fill
in `BASE_URL` + credentials for whichever roles you have accounts for
(see [README.md#environment-variables](README.md#environment-variables)).
Everything below reads from both `.env` files automatically —
`playwright.config.js` and `enrich`/`explore`/`dump-widgets.js` all load
the root one then the active project's one (`scripts/project.js`'s
`loadProjectEnv()`). No need to re-export anything per terminal session
once both are filled in.

If `enrich` ever fails with `model_not_found` (a 404 naming a model),
Groq has retired/renamed the model this project points at. Check
`https://api.groq.com/openai/v1/models` (with your key) for current
options and update the `model:` line in `explorer/enrich.js` and
`explorer/autonomous-agent.js`.

If it fails with `401 Invalid API Key` instead, the key itself is the
problem (expired/revoked/never valid) — rotate it in the Groq console and
update the root `.env`. This affects every AI-dependent feature at once
(`enrich`, `explore`, the AI failure reporter, self-healing), not just
whichever command you happened to run first.

## 1. Record + enrich in one command (recommended)

For the common case — you just want to test a page for a given role and
have it join the regression suite — one command does the whole
record → enrich → validate loop:

```bash
npm run new-test -- <role> <flow-name>
```

e.g. `npm run new-test -- medecin validate-visit` (add
`--project <project>` to target a project other than the default). This:

1. Launches Playwright's recorder against `BASE_URL` from the active
   project's `.env` (no need to pass a URL) — a real browser opens. **Log
   in as the role you passed** (its credentials are for you to type
   manually during recording, exactly like a real manual test pass),
   click through the flow, then **close the recorder window** when
   you're done.
2. Sends the raw recording to the model (Groq) along with a live map of
   the app's real `mx-name-*` widgets, and writes a maintainable Page
   Object–based test straight to
   `projects/<project>/generated-tests/<role>/<flow-name>.spec.js` —
   already wired to read that role's own credential env vars (e.g.
   `MENDIX_TEST_USERNAME_MEDECIN`), never the default ones, so you don't
   have to hand-edit credentials after generation.
3. Runs the secret-leak validator on it.

The moment that finishes, the new test is a normal file under
`generated-tests/<role>/` — running tests for that project picks it up
automatically next time (Playwright discovers `generated-tests/`
recursively, so new role folders need no config change). **Read the
generated file before trusting it** — it's a strong first draft, not
guaranteed correct; fix anything that looks off, then commit it like any
other source file. Since each role likely sees a different post-login
page, double-check the "we're past login" assertion targets something
real on *that* role's landing page.

If the output file already exists, you'll be asked to confirm before
it's overwritten (pass `--force` to skip the prompt). To point at a
different environment than `BASE_URL`, or to pass extra `playwright
codegen` flags:

```bash
npm run new-test -- <role> <flow-name> <app-url> --load-storage explorer/session.auth-state.json
```

The rest of this section (steps 1b-4 below) breaks down what that one
command does — useful if you want to preview the enriched output with
`--dry-run` before writing it, or if the combined command fails partway
and you need to resume from wherever it stopped.

This CLI form writes straight to `generated-tests/` (after the confirm
prompt above). The UI's Record button does the same record → enrich
pipeline but with `--stage` instead, which changes step 2: nothing is
written to `generated-tests/` at all — see the next section.

## Reviewing an AI-generated test before it counts

Pass `--stage` to `new-test`/`record-and-enrich.js` (what the UI's Record
button always does) and the enriched output lands in
`projects/<project>/explorer/pending/<role>-<flow-name>/` instead of
`generated-tests/` — nothing is picked up by the regression suite, and
the secret-leak validator doesn't even run yet, until a human approves
it:

```bash
npm run new-test -- <role> <flow-name> --stage
```

In the UI, any pending item shows up in the **Pending review** panel on
the project dashboard — a before/after diff (the raw recording vs. the
AI-enriched output) plus three actions:

- **Approve** — runs the secret-leak check (`scripts/check-secrets.js`)
  against the proposed content *before* writing anything; only on a clean
  check does it move into `generated-tests/<role>/<flow-name>.spec.js`
  (+ the `.feature` doc) for real. A proposal that fails the check is
  refused and stays in the queue — nothing partial ever lands in
  `generated-tests/`.
- **Reject** — discards the proposal. The raw recording is left alone
  (still on disk, gitignored) in case you want to try `--stage` again by
  hand later.
- **Regenerate** — re-runs the enrich step against the *same* raw
  recording without re-recording, useful if the first AI pass looked off
  and you just want another attempt.

The same review queue is also where a [fix, update, or extend proposal](#fixing-an-existing-test-update-analyze-extend)
proposal shows up — approving one patches the existing test in place
instead of creating a new file.

## 1b. Record your manual test (manual, step-by-step)

Do the manual test pass you'd normally do by hand — Playwright's recorder
opens a real browser and turns your clicks/fills into code as you go.

```bash
npm run record -- <app-url> --output projects/<project>/explorer/raw-<role>-<flow-name>.spec.js
```

Log in as `<role>`, then click through the flow like you normally would
to test it manually, then **close the recorder window** when you're
done. This writes the raw, unpolished recording to that file (gitignored
— it contains whatever you typed, including passwords).

> If your flow needs to start already logged in (to keep the recording
> short and focused), see [Optional: recording from an already-logged-in
> state](#optional-recording-from-an-already-logged-in-state) below.

## 2. Turn the recording into real test code

```bash
npm run enrich -- projects/<project>/explorer/raw-<role>-<flow-name>.spec.js <app-url> projects/<project>/generated-tests/<role>/<flow-name>.spec.js --role <role> --project <project>
```

This sends the recording to the model along with a live map of the app's
real `mx-name-*` widgets, and writes a maintainable Page Object–based
test to the given output path, using `--role` to pick which credential
env vars it writes into the test (defaults to `collaborateur` if
omitted — always pass it explicitly for a non-default role) and
`--project` to pick which project's `.env` to load (defaults to
`DEFAULT_PROJECT`). **Read the output before trusting it** — it's a
strong first draft, not guaranteed correct; fix anything that looks off
before moving on.

### Enrich dry-run and validation (recommended)

Preview the enriched test before writing it with `--dry-run`:

```bash
GROQ_API_KEY=... node explorer/enrich.js projects/<project>/explorer/raw-<role>-<flow-name>.spec.js <app-url> projects/<project>/generated-tests/<role>/<flow-name>.spec.js --role <role> --project <project> --dry-run
```

If the preview looks good, run the same command without `--dry-run` to write
the generated file. Always run the validator before committing:

```bash
npm run validate:generated
```

Checks every project under `projects/`, not just the one you're working
on. The CI pipeline also runs the validator and an `enrich --dry-run` job
when the `GROQ_API_KEY` secret is configured for the repository.

## BDD steps and the .feature docs

Every generated test groups its actions into
`await test.step('Given/When/Then <description>', async () => { ... });`
blocks — real BDD/Gherkin phrasing, not just code comments. Run any test
(even a single role via `npx playwright test <role>` — every run writes
the HTML report now, see [below](#4-run-the-full-regression-suite)), then
`npm run report` and click into any test: Playwright renders these as an
expandable, navigable step tree, each one timed and pass/fail-colored on
its own, e.g. for
`projects/OccupationalMedicine/generated-tests/collaborateur/create-visit.spec.js`:

```text
Test Steps
  ✓ Given the user is on the login page          6.2s
  ✓ When they log in with valid credentials       835ms
  ✓ Then they land on the visit list page         892ms
  ✓ When they open the add-visit form              1.0s
  ✓ And they select the visit type                 485ms
  ✓ And they fill in the reason for the visit      240ms
  ✓ When they submit and confirm the visit         541ms
  ✓ Then the visit is created with the correct details  318ms
  ✓ And the app returns to the visit list page       7ms
  ✓ And the user logs out                          1.3s
```

Alongside each `<flow-name>.spec.js`, a matching `<flow-name>.feature`
file is written at the same time — plain Gherkin text, mechanically
derived from those exact `test.step()` labels (`scripts/gherkin.js`
does the deriving; `npm run new-test` / `explorer/enrich.js` calls it
automatically for every newly generated test). It's a companion doc, not
a second thing to maintain: the `.spec.js` is the single source of truth,
so **never hand-edit a `.feature` file** — edit the `test.step()` labels
in the `.spec.js` instead, then run:

```bash
npm run features:sync
```

to regenerate every `.feature` doc across every project under `projects/`
from the current spec content. This also means the two can never
silently drift apart — whatever the report shows is exactly what the
`.feature` doc says, always.

When writing (or fixing) `test.step()` labels yourself — for a
hand-authored test, or editing an enriched one — keep them:

- Third person, present tense, no implementation detail (no widget names
  or selectors in the label text — that stays in the code inside the step).
- `Given` for starting state/preconditions, `When` for the action(s)
  driving the scenario, `Then` for the expected outcome/assertions,
  `And` for an additional step of the same kind as the one before it.
- Grouped sensibly — one step per *logical* action (e.g. "fill username,
  fill password, click submit" as a single `When they log in`), not one
  step per raw Playwright call.

## Test data hygiene

Some flows create real records in the app under test with no automated
cleanup — `create-visit.spec.js` is the current example: every run adds a
new Visit, forever, with no delete step. This is a known limitation, not
an oversight: writing an actual delete step needs the same grounding as
every other interaction in this project — a real recorded flow against
the real app's actual widgets — and no "delete a visit" flow has been
recorded yet, so there's nothing to enrich into a cleanup step. Fabricating
one from guessed widget names would violate the whole point of this
tool (every locator here is verified against a real replay, never
invented) and would likely just fail or silently do the wrong thing.

Until that flow gets recorded, the convention for any test that creates
data it can't clean up:

- **Mark the data so it's identifiable.** `create-visit.spec.js` fills
  the reason/description field with a marker like
  `` `e2e-test ${new Date().toISOString()}` `` instead of a plain literal
  like `'test'` — so test-created rows are greppable/bulk-cleanable later
  (by a human, or by a future maintenance script) instead of
  indistinguishable from real data entered by an actual user.
- **When you do get a chance to record a delete flow** (as whichever
  role can delete a visit), wire it into a proper cleanup step —
  ideally a `test.afterEach`/`test.afterAll` hook in the same spec, using
  the same marker to find what to delete, rather than a separate
  disconnected script that can drift out of sync with what the test
  actually creates.
- If a flow's created data doesn't matter (e.g. it's naturally bounded,
  or the app resets it some other way), this doesn't apply — use
  judgment, this is about flows that create genuinely unbounded data.

## 3. Run just that one test

```bash
npx playwright test <role>/<flow-name>.spec.js
```

(runs against the active/default project — pass `MENDIX_PROJECT=<project>`
before the command for a different one). Reads `BASE_URL`/credentials
straight from that project's `.env` (see [0. One-time
setup](#0-one-time-setup)) — no need to pass them inline. Override inline
only for a one-off, e.g. pointing at a different environment:

```bash
BASE_URL=<other-app-url> npx playwright test <role>/<flow-name>.spec.js
```

Or run every test for one role at once:

```bash
npx playwright test <role>/
```

(the trailing `/` matters — Playwright's test-path argument is a
substring match, and without it `admin` would also match
`admin-fonctionnel`'s tests).

## 4. Run the full regression suite

Once the new test passes on its own, run everything for the active
project (every role) to make sure it plays well with the rest of the
suite:

```bash
npm test
```

This is the same command CI runs on every push/PR against
`OccupationalMedicine` (see
[.github/workflows/regression.yml](.github/workflows/regression.yml)), so
if it's green locally it should be green there too.

Every run — `npm test`, a single role, even one file — writes an HTML
report alongside the terminal output, so `npm run report` always shows
whatever you just ran (each run overwrites the previous report; it's not
a merged history across runs):

```bash
npm run report    # opens the active project's most recent HTML report
```

This is especially useful given the [license seat
limit](README.md#known-issue-local-studio-pro-license-seat-limit) often
means testing role-by-role instead of the whole suite at once — you still
get a report for whichever role you just ran.

## AI failure analysis

Every failed test automatically gets a plain-English diagnosis printed
alongside the usual Playwright error (`scripts/ai-failure-reporter.js`, a
custom Playwright reporter wired into `playwright.config.js`) — no
separate command, it's just part of `npm test`/`npx playwright test`/CI
output:

```text
AI Failure Analysis
What happened
  The test tried to fill in the email field but it never appeared.

Likely cause
  The widget this locator targets may have been renamed or removed in
  Studio Pro since this test was last enriched.

Recommended action
  Re-record this step, or use self-healing (see below) if you know the
  widget's old name.

Confidence: 78%
```

It's a value-add on top of the real error, never a replacement — the
actual Playwright error/screenshot/HTML report are unchanged. Silently
prints nothing extra if `GROQ_API_KEY` isn't set or the Groq call fails,
so a missing key or an outage never breaks the actual test run.

## Fixing an existing test: Update / Analyze / Extend

The UI's Review tab has one card — **"Fix an existing test"** — for every
way an existing test can need attention, and the CLI has a matching
command for each. All three are grounded the same way as everything else
in this project: **never a guessed locator, always a real replay of the
app right now.** None of them require the test's original raw recording
to still exist — they replay the test's own current code, which already
knows how to get where it needs to go (`scripts/replay-widgets.js`'s
`replaySpecAndSnapshotWidgets()`/`runSpecUpToLogout()`, shared by all
three modes plus `enrich.js`'s replay engine for brand-new recordings).

**Update (re-record)** — the scenario itself changed, so record it again
from scratch:

```bash
npm run new-test -- <role> <flow-name> --update
```

Opens the recorder like a brand-new recording, but the result diffs
against the *current* `generated-tests/` content (not a raw recording) so
the reviewer sees old code vs. new code. Also refreshes
`raw-<role>-<flow-name>.spec.js` as a side effect.

**Analyze & heal locators** — one or more locators in an otherwise-fine
test stopped resolving (a widget got renamed in Studio Pro):

```bash
node scripts/heal-scan.js <role> <flow-name> --project <project>
```

Runs the test's own steps against the app right now, collects every
`mx-name-*` widget that's actually visible at each point, and checks
every `mx('...')` the test references against that real list. A broken
locator only gets a proposed replacement when the model finds a confident
match among the *currently visible* widgets (`CONFIDENCE_THRESHOLD` in
`scripts/heal-scan.js`, currently 50) — anything below that is reported as
unresolved rather than guessed, so a low-confidence "fix" can't silently
turn a passing test into a wrong one.

**Extend (record more)** — the scenario grew new steps at the end:

```bash
npm run new-test -- <role> <flow-name> --extend
```

Runs the test's own existing steps to reach a logged-in starting point
(stopping right before its closing "log out" step), then opens the
recorder already there — record only the *new* part and close the window.
The new step(s) are enriched separately and spliced deterministically
(no AI involved in the splice itself) into the existing spec, right
before its closing logout step — the model is never asked to reproduce
the whole file, which is exactly the kind of large-scale regeneration
that risks silently corrupting a test that was already passing. Only
supports a single-scenario spec (one `test()`, not a `test.describe` with
several) — continue from that flow's own file directly if it's part of a
`describe` block.

All three write to the same [pending review
queue](#reviewing-an-ai-generated-test-before-it-counts) as a brand-new
test — nothing is ever applied automatically; approving a proposal
patches (Analyze, Extend) or replaces (Update) the existing
`generated-tests/<role>/<flow-name>.spec.js`.

## Multiple environments

A project's own `projects/<project>/.env` is always the **Default**
environment. Add a named one (QA, Staging, whatever) from the UI's
Settings tab (**+ environment**) — pre-filled with `BASE_URL`, the default
`MENDIX_TEST_USERNAME`/`PASSWORD` pair, and the `MENDIX_DB_*` fields (see
[Resetting stuck Mendix sessions](#resetting-stuck-mendix-sessions)); add
a role-specific suffixed pair by hand once that role's tests actually need
this environment. Saved to
`projects/<project>/environments/<envName>.env` (gitignored, same as
`.env`). Pick which one to run against from the Runs tab's **Environment**
selector, or on the CLI:

```bash
MENDIX_ENV=QA MENDIX_PROJECT=<project> npm test
```

The test source never changes between environments — every generated test
navigates with a relative `page.goto('/')`, which Playwright resolves
against whichever `BASE_URL` got loaded. (If you have hand-authored specs
predating 2026-09-10 with a hardcoded `page.goto('http://...')`, switch
those to `page.goto('/')` too — a literal URL always wins over
whichever environment you picked, silently.)

## Resetting stuck Mendix sessions

Besides waiting for a stranded session to time out or restarting the app
in Studio Pro (see the [seat-limit known
issue](README.md#known-issue-local-studio-pro-license-seat-limit)), you can
connect directly to the app's own database and clear session rows there —
much faster, and can target just one role without touching anyone else's
session:

```bash
npm run reset-sessions                          # read-only — what's there right now
npm run reset-sessions -- --describe             # same, plus the full column-level detail
npm run reset-sessions -- --all --yes            # clear every session
npm run reset-sessions -- --role medecin --yes   # clear just medecin's session
```

Or from the UI: Settings tab > **Mendix sessions** — **Check now** is the
read-only report, **Clear this role's session** / **Clear ALL sessions**
do the same as `--role`/`--all` above (with a confirmation modal first).
Needs `MENDIX_DB_HOST/PORT/NAME/USER/PASSWORD` filled in for the active
environment first (a brand-new environment's template now includes these,
`HOST`/`PORT` pre-filled with the usual local defaults — the real values
for a local Studio Pro run are in Studio Pro's App Settings >
Configurations > (active config) > Database; the "Built-in database"
option is an embedded, single-process HSQLDB that no external tool
(including this one) can reach while the app is running — this only
works once the app is pointed at a real PostgreSQL, local or otherwise).
Run the plain read-only check first before either delete mode.

**This also runs automatically**, not just as a manual command, whenever
`MENDIX_DB_*` is configured for the active project/environment:

- **Once, before a run starts** (`playwright.config.js`'s `globalSetup`,
  `scripts/global-setup.js`) — clears whatever's stranded from a previous
  run/crash/manual browser tab.
- **After every individual test attempt** (`scripts/test-history-reporter.js`'s
  `onTestEnd`, including each retry) — clears seat pressure that builds up
  *during* a long run, which the once-per-run clear alone can't catch;
  prints `[session-clear after <role>/<file>] ...` so it's visible in the
  run log, not silent.

Both layers silently no-op (not a hard failure) when `MENDIX_DB_*` isn't
configured — this is a best-effort mitigation on top of the app-level ones
(`workers: 1`, `retries: 1`, every test's own `logout()`), not something a
run should ever hard-fail over.

## Visual regression (opt-in)

`basePage.expectVisualMatch(name)` wraps Playwright's own
`toHaveScreenshot()` — the first call for a given `name` writes a baseline
PNG next to the spec (`generated-tests/<role>/<file>-snapshots/`), every
call after that fails if the render differs by more than 2%
(`playwright.config.js`'s `maxDiffPixelRatio`). No generated test calls it
automatically; add it to a `test.step` when you want a layout/style
regression check, right after `waitForMendixIdle()` so it isn't racing an
in-flight microflow call. Accept an intentional UI change with
`npx playwright test --update-snapshots`.

## Accessibility checks (opt-in)

`basePage.expectNoAccessibilityViolations()` wraps `@axe-core/playwright`,
scanning the current page state against axe-core's own default WCAG
2.0/2.1 A+AA rule set. Same opt-in shape as visual regression above — no
generated test calls it automatically, it's there to add to a `test.step`
when you want it:

```js
await basePage.waitForMendixIdle();
await basePage.expectNoAccessibilityViolations();
```

Throws with every violation's rule id, impact, and a real CSS selector —
not just pass/fail — so a failure is immediately actionable. Override the
rule set via `await basePage.expectNoAccessibilityViolations({ tags: [...] })`
if a project needs something other than WCAG A+AA.

## Cross-browser coverage (opt-in)

Runs are Chromium-only by default — deliberately, since the trial Mendix
license's seat cap means every extra browser project multiplies login
volume against that same cap. Turn on Firefox/WebKit alongside it via
`MENDIX_TEST_BROWSERS` (comma-separated):

```bash
MENDIX_TEST_BROWSERS=chromium,firefox npx playwright test admin/
```

Not recommended against a trial-licensed local instance for the reason
above; safe once `BASE_URL` points at a non-trial environment.

## Authorization boundary scan

In the **Insights** tab, alongside performance/regression/coverage data.
Compares two roles' already-captured [App Scans](#mendix-app-scanner) and
flags any widget that only ever showed up in the higher-privilege role's
scan but is also visible while logged in as the lower-privilege role —
grounded in a real browser session, same as everything else here, never a
guess. Run the App Scanner for both roles first.

```bash
node scripts/auth-boundary-scan.js <lowerRole> <higherRole> --project <project>
```

Guards against a real false-positive trap: most widgets in a Mendix app
still carry Studio Pro's auto-generated default name (`container10`,
`actionButton3`, ...), which collide across completely unrelated pages
all the time. A default-named widget only counts as a match when its
visible *text* also matches — a default-named widget with no text at all
is skipped outright as unreliable to compare, rather than guessed about.

A finding means the widget is exposed in the DOM, not a confirmed
exploit — Mendix commonly also enforces access server-side on the
microflow/entity itself, so treat a finding as something to verify by
hand, not an automatically-confirmed vulnerability.

## Mendix App Scanner

```bash
node scripts/scan-app.js <role> [--project <project>] [--max-pages N]
```

or the UI's **App Scan** tab. Logs in as `<role>` once, then explores
same-origin navigation-like widgets reachable from the landing page
(real `<a>` tags, or anything with `role=menuitem`/`role=button` and a
pointer cursor), snapshotting every real `mx-name-*` widget found on each
distinct page — up to `--max-pages` (default 15). Saves
`projects/<project>/explorer/app-scan/<role>.json`.

Deliberately ONE login for the whole scan (returns to the starting nav via
the browser's own back-navigation between clicks) rather than one per page
— this project already treats login volume as a real cost against the
trial license's seat cap (see [Known
issue](README.md#known-issue-local-studio-pro-license-seat-limit)), and a
scanner that logged in per page would make that worse. The tradeoff: if a
given Mendix app's client routing doesn't support real back-navigation,
the crawl notices (the starting nav is gone after going back) and stops
early rather than continuing on a guess. Not a Studio Pro project scanner
— it has no access to your app's pages/microflows/entities at the project
level, only what an actual logged-in browser session can see.

## Reusable business steps

`steps/business-steps.js` holds an action sequence shared by multiple
specs instead of duplicated in each — right now, the login flow every
role's `login.spec.js` used to write out by hand. Import and call it from
inside your own `test.step()`:

```js
import { submitLogin } from '../../../../steps/business-steps.js';

await test.step('Given I am authenticated as <role>', async () => {
  ({ status, body } = await submitLogin(basePage, { username, password }));
});
```

Keep the BDD label directly in the `.spec.js` file (don't move the
`test.step()` wrapper itself into the shared module) — `scripts/gherkin.js`
scans literal `test.step(` calls in the spec to derive the `.feature` doc,
and a label hidden inside an imported function won't be found.

## Test explorer, quality score, and flaky detection

The UI's **Tests** tab lists every generated test in the project — role,
flow, tags, an AI quality score, and its most recent result — derived
entirely from what's actually on disk plus what actually ran, never a
separate thing to keep in sync:

- **Quality score** (`scripts/confidence.js`'s `scoreTestQuality()`) is
  deterministic, not an LLM call — it inspects the spec file itself for
  locator stability (`mx()` calls vs. raw `page.locator()`), assertion
  coverage, fixed-wait usage (`waitForTimeout()` costs points;
  `waitForMendixIdle()` doesn't), and BDD structure (do `test.step()`
  labels actually start with Given/When/Then). Shown for every test in the
  Tests tab, and for a pending proposal (new test or self-healing fix)
  before you approve it.
- **Per-test history** (`scripts/test-history-reporter.js`, a Playwright
  reporter wired into `playwright.config.js`) appends one entry — status,
  duration, and a link to the failure screenshot Playwright already
  captures (`screenshot: "only-on-failure"`) — to
  `projects/<project>/test-history.json` after every test, every run.
  Click **History** on any row in the Tests tab to see the last 20 runs
  and open a failure screenshot directly.
- **Flaky detection** is read directly off that history: a test whose
  recent runs are a genuine *mix* of pass and fail (not simply always
  failing) is flagged with its failure rate. Needs at least 3 runs before
  it says anything. A flaky login test is usually the known [license
  seat-cap race](README.md#known-issue-local-studio-pro-license-seat-limit),
  not a real bug — the flag is there to make that visible over time, not
  to imply every flaky result is a code problem.
- **Coverage tab** is a flow × role grid built from `generated-tests/`
  directly — which roles actually have a test for a given flow, so a gap
  like "only collaborateur has create-visit coverage" is visible at a
  glance instead of needing to browse folders.

## Quick reference

| Step | Command |
|---|---|
| Record + enrich + validate (one command) | `npm run new-test -- <role> <flow-name>` |
| Record only | `npm run record -- <app-url> --output projects/<project>/explorer/raw-<role>-<flow-name>.spec.js` |
| Enrich only | `npm run enrich -- projects/<project>/explorer/raw-<role>-<flow-name>.spec.js <app-url> projects/<project>/generated-tests/<role>/<flow-name>.spec.js --role <role>` |
| Run one test | `npx playwright test <role>/<flow-name>.spec.js` |
| Run one role's tests | `npx playwright test <role>/` |
| Run all tests (active project) | `npm test` |
| View the HTML report for whatever you just ran | `npm run report` |
| Regenerate .feature docs from hand-edited test.step() labels | `npm run features:sync` |
| Target a non-default project | prefix any command with `MENDIX_PROJECT=<project>`, or pass `--project <project>` to `new-test`/`enrich` |
| Create a new project | Use the UI's "Test a new project" button, or `node -e "import('./scripts/project.js').then(m => m.createProject('Name'))"` |
| Add a role to a project | Use the UI's "+ role" control, or `node -e "import('./scripts/project.js').then(m => m.addProjectRole('Project', 'role'))"` |
| Run only the fast smoke tests (logins, tagged `@smoke`) | `npm run test:smoke` |
| Run tests by any tag | `npx playwright test --grep @tagname` (or the UI's "By tag" run scope) |
| Record without writing to `generated-tests/` yet (needs review) | `npm run new-test -- <role> <flow-name> --stage` (what the UI's Record button always does) |
| Re-record an existing test from scratch | `npm run new-test -- <role> <flow-name> --update` (or the UI's "Update (re-record)") |
| Scan a whole test for every broken locator, propose confident fixes | `node scripts/heal-scan.js <role> <flow-name>` (or the UI's "Analyze & heal locators") |
| Continue a scenario that grew new steps | `npm run new-test -- <role> <flow-name> --extend` (or the UI's "Extend (record more)") |
| Check for missing/incomplete `.env` vars across all projects | `npm run validate:env` |
| Run against a named environment instead of Default | `MENDIX_ENV=<name>` prefix (or the UI's Environment selector) |
| Scan the app for reachable pages/widgets | `node scripts/scan-app.js <role> [--max-pages N]` (or the UI's App Scan tab) |
| Check for cross-role authorization gaps | `node scripts/auth-boundary-scan.js <lowerRole> <higherRole>` (or the Insights tab) |
| Check / clear stuck Mendix sessions | `npm run reset-sessions [-- --all --yes \| --role <role> --yes]` (or Settings tab > Mendix sessions) |
| Run the evaluation benchmark | `npm run benchmark` (currently 0 cases — scaffolding only) |
| Open the UI | `npm run ui` |

## Optional: recording from an already-logged-in state

If a flow only matters *after* login (e.g. "create a record"), you can
record login once, save the session, and start later recordings already
authenticated — keeps each recording short and focused, which the model
handles more reliably than one long combined flow.

```bash
# Record login once, saving the session:
npm run record -- <app-url> --output projects/<project>/explorer/raw-<role>-login.spec.js --save-storage explorer/session.auth-state.json

# Later recordings start already logged in:
npm run record -- <app-url> --output projects/<project>/explorer/raw-<role>-<flow-name>.spec.js --load-storage explorer/session.auth-state.json
```

`explorer/session.auth-state.json` is gitignored — it contains a live
session, never commit it. Sessions expire, so re-record login if a later
recording unexpectedly lands back on the login page. It's also tied to
one role at a time — re-record it when you switch which role you're
recording as.

## Testing other roles

`projects/OccupationalMedicine/generated-tests/collaborateur/` holds the
default-role tests (login/create-visit/edit-visit), reading
`MENDIX_TEST_USERNAME`/`MENDIX_TEST_PASSWORD`. The app also has médecin,
infirmier, admin fonctionnel, and admin roles — each gets its own env var
pair (see [README.md](README.md#environment-variables)):
`MENDIX_TEST_USERNAME_MEDECIN`, `MENDIX_TEST_USERNAME_INFIRMIER`,
`MENDIX_TEST_USERNAME_ADMIN_FONCTIONNEL`, `MENDIX_TEST_USERNAME_ADMIN`
(and matching `_PASSWORD_*` variants).

These 5 are specific to `OccupationalMedicine` — roles are per-project
data (`projects/<project>/roles.json`), not a fixed global list, so a
different project can have an entirely different set. See [Adding a role
to a project](#adding-a-role-to-a-project) below if the role you need
doesn't exist yet for the project you're working on.

To build a test for another (already-existing) role:

1. Fill in that role's credentials in `projects/<project>/.env` (ask
   whoever manages test accounts if you don't have them).
2. Run `npm run new-test -- <role> <flow-name>` (or steps 1b-2 above)
   while logged in as that role during the recording step — the role
   argument takes care of the output folder and the credential env vars
   for you; you don't need to hand-edit anything after generation.
3. Since each role likely sees a different post-login page, double-check
   the "we're past login" assertion (e.g.
   `expect(basePage.mx('actionButton14'))` in the collaborateur tests)
   targets something real on *that* role's landing page — the model
   infers this from the recording, so it's usually right, but verify it.

## Adding a role to a project

A role has to be added to the project before `new-test`/the UI's Record
button will accept it — this is what actually creates the "slot" (output
folder + which credential env vars the model writes into the generated
test).

**Via the UI:** open the project, click **"+ role"** next to Record's
role picker, type the new role's name, and it's immediately selectable —
no server restart, no file to hand-edit.

**Via the CLI:**

```bash
node -e "import('./scripts/project.js').then(m => m.addProjectRole('YourProject', 'supervisor'))"
```

Both just append to `projects/YourProject/roles.json`. Role names must
start with a lowercase letter and contain only lowercase letters, digits,
and hyphens (e.g. `supervisor`, `read-only-auditor`). After adding one,
fill in its credentials in `projects/YourProject/.env` — see the naming
convention in [README.md#environment-variables](README.md#environment-variables)
(every role except `collaborateur` gets a `_<ROLE>` suffix on both env
var names).

## Testing a different app

To test a Mendix app other than `OccupationalMedicine`:

1. Create a new project — via the UI's "Test a new project" button, or
   `node -e "import('./scripts/project.js').then(m => m.createProject('Name'))"`.
   Scaffolds `projects/Name/generated-tests/` and `.env`/`.env.example`.
2. Fill in `BASE_URL` and credentials in `projects/Name/.env`.
3. Use any command above with `--project Name` (for `new-test`/`enrich`)
   or `MENDIX_PROJECT=Name` (for `playwright test`/`npm test`/`npm run
   report`) — or just open it from the UI, which sets this for you
   automatically.
4. Before trusting `pages/BasePage.js`'s `logout()` for the new app,
   verify its logout button actually matches
   `.mx-name-actionButton2.logout` — that selector was verified against
   `OccupationalMedicine` specifically (see README's "Verified against
   the real app" section) and a different app's DOM may differ.

## Ideas for more coverage

Current state (check with `find projects/<project>/generated-tests -name
"*.spec.js"`): every role has a login test, but only `collaborateur` has
anything past login (`create-visit`, `edit-visit`). Worth recording next,
roughly in priority order:

- **Each role's actual job, not just their login.** `medecin`,
  `infirmier`, `admin-fonctionnel`, and `admin` only have a login test
  each right now — record the flow each role actually exists to do (e.g.
  a médecin validating/reviewing a visit, an infirmier recording care
  notes, admin-fonctionnel managing accounts/config).
- **Cross-role workflow chains.** The real business process likely spans
  roles — e.g. collaborateur creates a visit → infirmier or médecin acts
  on it → admin-fonctionnel reviews it. A single test can't span roles
  (each test logs in as one), but a *sequence* of tests exercising the
  same record across roles catches handoff bugs a single-role test can't.
- **Negative/invalid-login tests per role** — wrong password, unknown
  username — confirm the app rejects cleanly rather than just testing the
  happy path (a good candidate for `--dry-run` first, and note the
  "skip logout for a test that never logs in" rule already documented in
  `explorer/enrich.js`'s system prompt).
- **Authorization boundaries.** Does a `collaborateur` get properly
  blocked from médecin/admin-only pages/actions? The [authorization
  boundary scan](#authorization-boundary-scan) gives an automated first
  pass at this (widget-level exposure, once an App Scan exists for both
  roles) — worth following up any finding with a real test per role pair
  where access should be denied, not just where it should succeed.
- **Field validation.** Required-field errors, invalid date ranges, and
  other form-level validation on the visit creation/edit forms — currently
  only the happy path is covered.
- **List/search behavior** on any page showing a list of visits/records —
  filtering, sorting, pagination if the list can grow large.
- **Full visit lifecycle in one scenario** — create → edit →
  validate/close (or whatever the app's actual end state is) — rather
  than create and edit as two separate, disconnected tests.

None of this changes how you record — `npm run new-test -- <role>
<flow-name>` (or the UI's Record button) is exactly the same command for
any of the above, it's just a matter of which role and flow to click
through next.
