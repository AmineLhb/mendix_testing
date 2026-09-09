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

## Architecture

### Multi-project layout

Every Mendix app under test gets `projects/<name>/`: `.env` (`BASE_URL` +
role credentials, gitignored), `roles.json` (which roles this project
has — a plain array, not a fixed global list), `generated-tests/<role>/*.spec.js`
+ matching `.feature` docs, `explorer/` (raw codegen recordings,
gitignored), `playwright-report/` + `test-results/` (regenerated,
gitignored), `run-history.json` (last 20 UI-triggered jobs, gitignored).
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
vanilla HTML/CSS/JS, no build step. While a job is running, the UI locks
competing actions (a second run, rename, delete, switching project) —
starting two jobs at once means two browser sessions, and the seat cap
below makes that actively harmful, not just confusing.

### Known constraint: trial Mendix license seat cap

The local Studio Pro dev license caps concurrent signed-in sessions.
Every generated test ends with `basePage.logout()` specifically to free
its seat immediately. `playwright.config.js` sets `workers: 1` (parallel
logins cause real, non-flaky failures against this environment) and
`retries: 1` (absorbs a seat-release race). Testing role-by-role
(`npx playwright test <role>/`) rather than the whole suite at once is
the practical workaround until a non-trial license is available — see
README's "Known issue" section for full detail.

## CI (`.github/workflows/regression.yml`)

Runs on push to `main`, every PR, and nightly at 03:00 UTC (the schedule
is only meaningful once `BASE_URL` points at a stable, non-trial
environment). Validates generated tests for secrets, runs the suite
against `OccupationalMedicine` using repository secrets, uploads the HTML
report + `junit.xml` as artifacts, writes a job-summary link, and
notifies a Slack webhook on failure (inert until a `SLACK_WEBHOOK_URL`
secret is added). `.github/dependabot.yml` keeps npm deps and Actions
versions current — mainly to catch `@playwright/test` drifting out of
step with the Playwright browser binaries CI installs.
