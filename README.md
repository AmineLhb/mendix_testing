# mendix-test-agent

[![Regression suite](https://github.com/AmineLhb/mendix_testing/actions/workflows/regression.yml/badge.svg)](https://github.com/AmineLhb/mendix_testing/actions/workflows/regression.yml)

Record-once, AI-enrich, regress-forever E2E testing for Mendix apps —
multi-project: test as many separate Mendix apps as you like from the same
tool, each with its own tests and credentials.

> Just want the commands to record and run a new test? See
> [TESTING_GUIDE.md](TESTING_GUIDE.md).

## UI

```bash
npm run ui
```

Opens a browser to `http://localhost:4300` — a project picker ("open a
recent project" or "test a new project") and, per project:

- **Record** a new test (opens a real Playwright browser for you to click
  through the flow manually) and **Run** tests (all roles, one role, one
  file, or by tag) — both stream live output to the page, with a
  **Cancel** button while a job is running and a desktop notification
  when it finishes if you've tabbed away.
- **"+ role"** next to Record's role picker — add a role on the fly
  (per-project, see [Environment variables](#environment-variables)) and
  select it immediately, instead of only being able to pick from a fixed
  list.
- **Pending review** — a recording never writes straight to
  `generated-tests/`. It lands here first as a before/after diff (raw
  recording vs. AI-enriched output) with Approve / Reject / Regenerate —
  see [Reviewing an AI-generated test before it counts](TESTING_GUIDE.md#reviewing-an-ai-generated-test-before-it-counts).
  A self-healing fix proposal (see below) shows up in the same queue.
- **Self-heal a broken locator** — when a widget gets renamed in Studio
  Pro, propose a fix grounded in a real replay of the app right now
  (never a guessed rename) — see
  [Self-healing a broken locator](TESTING_GUIDE.md#self-healing-a-broken-locator).
- **Report** — opens the HTML report for the last run.
- **Recent runs** — the last 20 record/run jobs for this project (pass/fail,
  what was run, when), persisted to
  `projects/<project>/run-history.json` so it survives closing the UI —
  a plain JSON file, no database to install or run.
- **View source** next to the file picker — shows a run's `.spec.js` next
  to its derived `.feature` doc side by side, without opening an editor.
- **Environment (.env)** — a collapsible section; expand it to edit
  `BASE_URL` and role credentials for the project directly in the page,
  saves straight to `projects/<project>/.env`.
- **Rename / Delete project** at the top of the dashboard (delete asks for
  confirmation first — it removes that project's folder entirely).

**While a job is running, Cancel is the only action available** — Run,
Record, Rename, Delete, and Save .env are all disabled, and navigating
back to the project list is blocked with a toast, until that job finishes
or you cancel it. This isn't just UI tidiness: starting a second job (a
run while a record is mid-flight, say) opens a second browser session,
and this Mendix app's trial license caps concurrent sessions (see [Known
issue](#known-issue-local-studio-pro-license-seat-limit) below) — a
second job makes that worse, not just confusing.

It's a thin wrapper: every button just runs the same CLI commands
documented below (or edits the same files a person would by hand) and
streams live output to the page — nothing about the underlying scripts
changes, so the CLI workflow below still works exactly as described if
you prefer it (or for CI, which always uses the CLI).

"Record" still opens a real Playwright browser window for you to click
through the flow manually — that part can't be embedded in the page, only
orchestrated. Click through it, close that window, and the UI picks up
from there (enriches the recording, shows you the result).

## Why this works for Mendix

Every widget named in Mendix Studio Pro gets a stable CSS class
`mx-name-<WidgetName>` in the rendered HTML — a built-in `data-testid`
system. Locators read straight from the DOM and stay valid across builds
as long as the widget's *name* doesn't change (unlike Mendix's
auto-generated `id` attributes, which do).

**Team convention:** widgets that tests interact with need meaningful
Studio Pro names (`btnSubmitOrder`, not `button3`).

## Projects

Each Mendix app under test gets its own folder:

```text
projects/<ProjectName>/
  .env                 # BASE_URL + role credentials for this app (gitignored)
  .env.example          # template — copy to .env and fill in
  roles.json             # which roles this project has (e.g. ["collaborateur", "medecin"])
  generated-tests/      # <role>/<flow-name>.spec.js, one folder per app role
  explorer/              # raw codegen recordings for this project (gitignored)
  playwright-report/    # HTML report for the last run (gitignored)
  run-history.json      # last 20 UI record/run jobs, for the "Recent runs" panel (gitignored)
```

`OccupationalMedicine` is the first project, containing all the tests
built so far (login for every role, create-visit, edit-visit). Tool-level
config that isn't tied to any one app — just `GROQ_API_KEY` — lives in the
repo root `.env` instead, shared across every project.

The active project defaults to `DEFAULT_PROJECT` in `scripts/project.js`
(currently `OccupationalMedicine`). Point any command at a different one
with `MENDIX_PROJECT`:

```bash
MENDIX_PROJECT=SomeOtherApp npm test
```

The UI sets this automatically per-button based on whichever project
you've opened — you only need it yourself for direct CLI use against a
non-default project.

**Create a new project:**

```bash
node -e "import('./scripts/project.js').then(m => m.createProject('YourAppName'))"
```

(or use the UI's "Test a new project" button, which does the same thing).
Scaffolds `projects/YourAppName/` with an empty `generated-tests/` and a
`.env`/`.env.example` for you to fill in `BASE_URL` and credentials.

## Testing against dev/UAT (not just localhost)

`BASE_URL` is just a URL — nothing here assumes `localhost`. Point a
project's `.env` at a deployed dev or UAT environment instead of a local
Studio Pro run and everything (recording, enrich, running, the UI) works
the same way, since Playwright drives a real browser against whatever
`BASE_URL` resolves to:

```dotenv
BASE_URL=https://your-app.dev.mendixcloud.com
```

Things worth knowing before doing that:

- **Network reachability.** The machine running `npm run ui`/tests needs
  to actually reach that URL — if the environment sits behind a VPN or
  internal network, connect to that first.
- **Credentials must exist on that environment.** Each role's
  `MENDIX_TEST_USERNAME_*`/`MENDIX_TEST_PASSWORD_*` needs a real account
  provisioned on the dev/UAT app, not just the local one.
- **A shared server means a shared seat/session cap.** The [trial license
  seat-cap issue](#known-issue-local-studio-pro-license-seat-limit)
  described below is specific to this project's current local Studio Pro
  instance, but if a dev/UAT environment is *also* trial-licensed (or just
  gets hit by other people/CI at the same time), the same class of problem
  can show up there too — logins failing because too many sessions are
  already open. Licensed (non-trial) environments generally don't have
  this problem.
- **Don't point CI at a shared dev/UAT environment without thinking it
  through.** `.github/workflows/regression.yml` currently expects
  `MENDIX_TEST_APP_URL` to be a stable, dedicated test target — pointing
  it at a UAT environment other people are actively using means CI runs
  can collide with manual testers (shared sessions, shared data).

## Workflow

Within a project, tests live under `generated-tests/<role>/`, one folder
per app role (for `OccupationalMedicine`: `collaborateur`, `medecin`,
`infirmier`, `admin-fonctionnel`, `admin` — see [Environment
variables](#environment-variables)). Playwright discovers `generated-tests/`
recursively, so any role folder is automatically part of `npm test`/CI —
no config changes needed when a new role gets its first test.

### Phases A+B — Record + Enrich (one command, per flow)

```bash
npm run new-test -- <role> <flow-name>
```

e.g. `npm run new-test -- medecin validate-visit` (add `--project <name>`
to target a non-default project). This opens Playwright's codegen
recorder against `BASE_URL` (log in as that role when it opens), then
sends the recording plus a live `mx-name-*` widget snapshot to Groq,
which rewrites it into a Page Object–based test with real assertions and
proper Mendix async waits — written straight to
`projects/<project>/generated-tests/<role>/<flow-name>.spec.js`, already
wired to use that role's own credential env vars (never the default
ones). See [TESTING_GUIDE.md](TESTING_GUIDE.md) for the full walkthrough,
including the manual step-by-step version of record/enrich if you want to
preview with `--dry-run` first.

Every test is also written with its actions grouped into
`test.step('Given/When/Then ...', ...)` blocks — Playwright's HTML report
renders these as an expandable, navigable step tree per test (screenshot
in [TESTING_GUIDE.md](TESTING_GUIDE.md#bdd-steps-and-the-feature-docs)).
A matching `<flow-name>.feature` file, in plain Gherkin, is written
alongside the `.spec.js` at the same time — mechanically derived from
those same step labels (`scripts/gherkin.js`), so the two can never drift
apart. The `.spec.js` is the source of truth; if you hand-edit its
`test.step()` labels later, run `npm run features:sync` to regenerate the
`.feature` doc to match (covers every project, not just the active one).

### Phase C — Regress (CI, forever)

`.github/workflows/regression.yml` runs everything under
`projects/OccupationalMedicine/generated-tests/` (all roles) on every
push/PR. See [Environment variables](#environment-variables) below for
the full list of GitHub Actions secrets it reads.

### Phase D — Optional: autonomous exploration

```bash
GROQ_API_KEY=gsk_... npm run explore -- https://your-mendix-app-url --steps 25
```

An LLM drives the browser looking for broken flows. Output goes to
`explorer/exploration-findings.json` — treat it as a bug list to triage,
**not** as part of the deterministic CI suite. Turn any real bug into a
proper recorded test via Phase A + B.

## Setup

```bash
npm install
npx playwright install --with-deps chromium
```

Copy `.env.example` to `.env` at the repo root and fill in `GROQ_API_KEY`
(needed for `enrich`/`explore`/the UI's record button). Then, per project,
copy `projects/<name>/.env.example` to `projects/<name>/.env` and fill in
`BASE_URL` + credentials for that app. Never commit either `.env` — see
`.gitignore`.

## Environment variables

Local runs read `.env` automatically — `playwright.config.js` loads the
repo root `.env` (tool-level: `GROQ_API_KEY`) then the active project's
`.env` (app-level: `BASE_URL` + credentials), via `scripts/project.js`'s
`loadProjectEnv()` — so any test file can just use `process.env.X`
directly, no per-file `dotenv.config()` needed. CI reads the same names
from GitHub Actions repository secrets instead (wired in
`.github/workflows/regression.yml`), scoped to the `OccupationalMedicine`
project.

Run `npm run validate:env` any time to check for missing/incomplete
`.env` vars across every project — it derives what *should* exist from
each project's `roles.json` (via `scripts/roles.js`'s naming convention,
the same thing `enrich.js` itself uses) rather than a separate
hand-maintained checklist, so it can't silently drift out of sync with
what a generated test actually expects. It's informational only (always
exits 0) — a role legitimately having no credentials yet is a normal
in-progress state, not a failure.

| Variable | Lives in | Role folder | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | repo root `.env` | n/a — used by `enrich`, `explore` | Never commit; rotate if it's ever pasted somewhere outside your own shell/`.env` |
| `BASE_URL` | `projects/<name>/.env` | n/a — used by all generated tests, `playwright.config.js` | CI secret is named `MENDIX_TEST_APP_URL` and gets mapped to `BASE_URL` in the workflow |
| `MENDIX_TEST_USERNAME` / `MENDIX_TEST_PASSWORD` | `projects/<name>/.env` | `generated-tests/collaborateur/` | The `collaborateur` role always uses these unsuffixed names — see below |
| `MENDIX_TEST_USERNAME_<ROLE>` / `MENDIX_TEST_PASSWORD_<ROLE>` | `projects/<name>/.env` | `generated-tests/<role>/` | One pair per role other than `collaborateur` — `<ROLE>` is the role name, uppercased with `-` → `_` (e.g. role `admin-fonctionnel` → `MENDIX_TEST_USERNAME_ADMIN_FONCTIONNEL`) |

**Which roles exist is per-project data**, not a fixed global list — each
project has its own `projects/<name>/roles.json` (an array of role names,
e.g. `["collaborateur", "medecin", "infirmier", "admin-fonctionnel",
"admin"]` for `OccupationalMedicine`). Add a role for a project via the
UI's "+ role" control on the Record card, or:

```bash
node -e "import('./scripts/project.js').then(m => m.addProjectRole('YourProject', 'supervisor'))"
```

then fill in that role's credential pair in `projects/YourProject/.env`
using the naming convention above. The role name you pass to `npm run
new-test -- <role> <flow-name>` picks both the output folder and which
credential pair the generated test reads — the naming convention itself
(role name → env var names) lives in `scripts/roles.js`, the single
source of truth for that mapping, shared by every project. See
[TESTING_GUIDE.md](TESTING_GUIDE.md#testing-other-roles).

## Test reports

Every test run writes an HTML report — not just `npm test`/`test:ci`, but
also a role-by-role run like `npx playwright test <role>` (useful given
the [license seat limit](#known-issue-local-studio-pro-license-seat-limit)
often means testing one role at a time rather than the whole suite):

```bash
npm run report     # opens the most recent run's HTML report in a browser
```

The terminal's `list` output (pass/fail per test, as you're used to) still
prints exactly as before — the HTML report is written alongside it, not
instead of it. Each run **overwrites** the previous report with just that
run's results — this shows "what did I just run," not a merged history
across separate runs. The report is written under
`projects/<project>/playwright-report/`, so different projects' reports
never clobber each other, and `npm run report` always opens the active
project's copy. It's uploaded as a CI artifact too — see
`.github/workflows/regression.yml`. `playwright-report/` itself is
gitignored locally.

On failure, Playwright also writes a screenshot to
`projects/<project>/test-results/<test name>/test-failed-1.png`
(gitignored) — a quick visual without opening the full report. Trace
files (`.zip`) are turned off (`trace: "off"` in `playwright.config.js`)
since they need a separate `npx playwright show-trace` viewer and aren't
useful as a plain report/log; turn them back on (`"retain-on-failure"`)
only if you need step-by-step replay for a specific hard-to-diagnose
failure.

A `junit.xml` is written alongside the HTML report (also gitignored, also
uploaded as a CI artifact) — the portable format most external test
dashboards/trackers ingest natively, so wiring this project into one
doesn't need bespoke integration code, just pointing that tool at the
artifact (or at the raw file for a local run).

## CI (GitHub Actions)

`.github/workflows/regression.yml` runs on every push to `main`, every
PR, and nightly at 03:00 UTC (the schedule trigger — delete it if
`BASE_URL` isn't pointed at a stable, non-trial-license environment; see
[Testing against dev/UAT](#testing-against-devuat-not-just-localhost)).
Each run:

- Validates generated tests for hardcoded secrets, then runs the suite
  against `OccupationalMedicine` using repository secrets (see
  [Environment variables](#environment-variables)).
- Uploads the HTML report and `junit.xml` as artifacts (14-day
  retention), and writes a link to the run into the job summary so it's
  one click from the Actions tab or a PR check, not a zip you have to
  hunt for.
- On failure, posts to a Slack incoming webhook — inert until a
  `SLACK_WEBHOOK_URL` repository secret is added (Slack → *Apps* →
  *Incoming Webhooks*); nothing in the workflow needs to change to turn
  it on.

`.github/dependabot.yml` opens weekly PRs for npm dependencies and the
GitHub Actions used in the workflow itself — mainly to catch
`@playwright/test` drifting out of step with the Playwright browser
binaries CI installs, a common source of failures that have nothing to
do with the app under test.

For faster PR feedback than the full suite, every login test is tagged
`@smoke` (`test.describe(..., { tag: '@smoke' }, ...)`) — run just those
with `npm run test:smoke`. The CI workflow itself still runs the full
suite on every push/PR/nightly; splitting *that* into a fast smoke gate
plus a fuller scheduled run is a real option but changes what blocks a
merge, so it's left as a deliberate choice to make later rather than
changed here.

**Verified 2026-09-09: `npm run test:smoke` is not immune to the [license
seat-cap issue](#known-issue-local-studio-pro-license-seat-limit)** — all
10 login tests across the 5 roles back to back hit it partway through
(2 failed with the same "current license does not allow more users to
sign in" error, confirmed via each failed test's `error-context.md`;
re-running the failed file alone immediately after passed cleanly). A
smoke run is actually *more* login-dense per minute than the full suite,
not less, since it's nothing but logins — don't assume "smoke" implies
"safe from the seat cap" on a trial license. Same workaround applies:
role-by-role (`npx playwright test <role>/login.spec.js --grep @smoke`)
rather than every role's smoke test in one command.

**Not wired up yet, and deliberately left as manual one-time steps
rather than guessed at:**

- **Branch protection on `main`** requiring the `e2e` job to pass before
  merge — a repository *setting* (Settings → Branches), not a file in
  this repo; enable it once you're confident the suite is stable enough
  to gate merges on.
- **Publishing the HTML report to GitHub Pages** per run (so it's a live
  link instead of a downloadable artifact) — needs Pages enabled once in
  repo Settings first (source: GitHub Actions); ask to have the deploy
  job added once that's done.
- **A status badge** at the top of this README already points at
  `github.com/AmineLhb/mendix_testing`'s workflow — update the
  owner/repo in the badge URL if this ever moves to a different remote.

## New safety & CI features

- Use `--dry-run` when calling the enrich step to preview generated tests without
  writing them. This helps avoid committing secrets introduced during recording.

  ```bash
  GROQ_API_KEY=gsk_... node explorer/enrich.js explorer/raw-<role>-<flow-name>.spec.js <app-url> projects/<project>/generated-tests/<role>/<flow-name>.spec.js --role <role> --project <project> --dry-run
  ```

  `--role` picks which credential env vars (see [Environment
  variables](#environment-variables)) the model is told to write into the
  test; defaults to `collaborateur` if omitted. `--project` picks which
  project's `.env` to load; defaults to `DEFAULT_PROJECT`.

- Validate generated tests for hardcoded credentials before committing or in CI:

  ```bash
  npm run validate:generated
  ```

  Checks every project under `projects/`, not just the active one.

- CI now includes a dry-run enrich job (runs when `GROQ_API_KEY` and
  `MENDIX_TEST_APP_URL` are set in repository secrets) and will fail PRs that
  produce unsafe generated tests. The regression job also runs the validator
  before executing Playwright tests.

- Pre-commit checks are already wired via Husky (`npm run prepare` sets it
  up, which `npm install` runs automatically). `.husky/pre-commit` runs the
  generated-test validator and lint-staged on every commit.

## AI-assisted maintenance

Beyond the initial record → enrich step, three more places use the same
Groq call, all built on one rule this project doesn't bend on: **a
locator is never guessed — it's always grounded in a real replay of the
live app.** Full detail on each is in TESTING_GUIDE.md.

- **[Reviewing an AI-generated test before it counts](TESTING_GUIDE.md#reviewing-an-ai-generated-test-before-it-counts)**
  — recording through the UI (or `new-test --stage` on the CLI) never
  writes straight to `generated-tests/`. It sits in
  `projects/<project>/explorer/pending/` as a before/after diff until a
  human approves it — and the secret-leak check runs *before* that write,
  not after, so a proposal that fails it never touches
  `generated-tests/` at all.
- **[AI failure analysis](TESTING_GUIDE.md#ai-failure-analysis)** — every
  failed test gets a plain-English "what happened / likely cause /
  recommended action" diagnosis printed alongside the real Playwright
  error, via a custom reporter (`scripts/ai-failure-reporter.js`). Purely
  additive — the actual error/screenshot/report are unchanged, and a
  missing key or Groq outage never breaks the test run itself.
- **[Self-healing a broken locator](TESTING_GUIDE.md#self-healing-a-broken-locator)**
  (`scripts/heal.js`) — when a widget gets renamed in Studio Pro, this
  replays the test's original raw recording against the app *right now*
  (the same replay mechanism `enrich.js` uses, shared via
  `scripts/replay-widgets.js`) and asks the model to pick a replacement
  only from widgets that are genuinely visible in that live snapshot,
  never an invented name. The proposed fix goes through the same
  pending-review queue as a new test — approving it patches the existing
  test in place.

## Verified against the real app

`pages/BasePage.js`'s `waitForMendixIdle()` was checked against
`OccupationalMedicine`'s actual Mendix app (10.24.2, custom Atlas-based
theme) using `explorer/inspect-loading-selector.js`. Findings, dated
2026-08-11:

- No full-page loading overlay is ever rendered by this app/theme — the
  default `LOADING_SELECTOR` guess doesn't match anything here.
- `page.waitForLoadState('networkidle')` resolves correctly and is the
  real signal `waitForMendixIdle()` relies on. The app's dev-only
  WebSocket (`ws://localhost:8080/mxdevtools/`) does not block it.

`pages/BasePage.js` is shared across every project (it's generic Mendix
tooling — `mx()`, `waitForMendixIdle()`, the `/xas/` API helpers all rely
only on conventions Mendix itself guarantees). The one exception is
`logout()`, which targets a specific button class
(`.mx-name-actionButton2.logout`) verified against
`OccupationalMedicine`'s DOM specifically — if a different project's app
uses a different logout button structure, re-verify `logout()` against it
(see `pages/BasePage.js`'s doc comment) before trusting it there. If you
point this scaffold at a different Mendix app/theme in general, also
re-run `explorer/inspect-loading-selector.js` against it before trusting
`LOADING_SELECTOR` — themes vary.

## Known issue: local Studio Pro license seat limit

Discovered 2026-09-04: a local Studio Pro dev runtime's license caps how
many users can be signed in concurrently. Every test that logs in ends
with `await basePage.logout()` (see `pages/BasePage.js`) specifically to
free its seat immediately instead of leaving the session to expire on
its own — without it, enough test runs in a row exhausts the seat limit
and every subsequent login fails with *"The current license does not
allow more users to sign in."* (a Mendix error dialog, not a Playwright
timeout, though it can *look* like one if the dialog render is what
times out).

`logout()` is confirmed working (verified 2026-09-04: a full 4-test run
passes cleanly end to end with no strict-mode locator errors).

Two distinct things can exhaust the seat cap, and it's important not to
confuse them:

1. **A failed run stranding a seat that no code path can free.**
   `logout()` only runs on each test's success path, so if a test fails
   anywhere *before* it gets there — including at the login step itself
   — that session is never released and compounds the problem for every
   run after it. A short wait does not help (confirmed: 20s made no
   difference); a stranded seat needs either a successful login+logout
   for that session, or an app restart. Watch for a lower-visibility
   symptom too: an inline "Unknown error occurred." on the login form
   (no navigation) instead of the usual modal — seen when a login
   attempt itself gets throttled/rejected rather than fully blocked.

2. **A completely separate browser tab/window with an active manual
   login to the app** (e.g. left over from recording a test with
   codegen, or a Studio Pro preview browser) — this is NOT freed by
   restarting the app in Studio Pro. Confirmed 2026-09-04: a full app
   restart alone did not clear the cap; closing an unrelated logged-in
   browser tab did. If tests hit the cap on the very first login
   attempt *immediately after a fresh restart*, suspect this before
   assuming the restart didn't take — check for any other browser
   window/tab signed into the app and close it.

`playwright.config.js` already sets `workers: 1` for cause (1) —
concurrent test workers each open their own session and hit the limit
faster. `retries: 1` (local and CI) absorbs the milder version of cause
(1) — a seat freed just slightly too late for the very next login — by
retrying once; confirmed 2026-09-07 to self-heal exactly that case.

**This is a trial (unlicensed) Mendix instance**, so its concurrent-seat
cap is low — confirmed 2026-09-07: running all 5 roles' tests back to
back in one `npm test` (12 tests, up to 24 login attempts counting
retries) exhausted it partway through even with every test logging out
correctly, while the exact same tests all pass individually or in
smaller batches. A single retry isn't enough headroom when a whole
multi-role run is packed back to back like that.

**Recommended workflow while on a trial license:** test role-by-role
instead of running the full suite:

```bash
npx playwright test <role>
```

and restart the app (or otherwise clear active sessions) between roles
if you hit the cap. Save the full `npm test` run for occasions where you
specifically need to confirm the whole suite together (e.g. right before
a release), not as the everyday iteration loop.
