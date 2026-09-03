# mendix-test-agent

Record-once, AI-enrich, regress-forever E2E testing for Mendix apps.

> Just want the commands to record and run a new test? See
> [TESTING_GUIDE.md](TESTING_GUIDE.md).

## Why this works for Mendix

Every widget named in Mendix Studio Pro gets a stable CSS class
`mx-name-<WidgetName>` in the rendered HTML — a built-in `data-testid`
system. Locators read straight from the DOM and stay valid across builds
as long as the widget's *name* doesn't change (unlike Mendix's
auto-generated `id` attributes, which do).

**Team convention:** widgets that tests interact with need meaningful
Studio Pro names (`btnSubmitOrder`, not `button3`).

## Workflow

### Phase A — Record (human, once per flow)

```bash
npm run record -- https://your-mendix-app-url --output explorer/raw-login-flow.spec.js
```

Click through the flow you want covered. Playwright's codegen recorder
writes out the raw actions.

### Phase B — Enrich (AI, once per recording)

```bash
GROQ_API_KEY=gsk_... npm run enrich -- \
  explorer/raw-login-flow.spec.js \
  https://your-mendix-app-url \
  generated-tests/login-flow.spec.js
```

Sends the raw recording plus a live `mx-name-*` widget snapshot to
Groq, which rewrites it into a Page Object–based test with real
assertions and proper Mendix async waits.

### Phase C — Regress (CI, forever)

`.github/workflows/regression.yml` runs everything in `generated-tests/`
on every push/PR. Requires two GitHub Actions secrets:

- `MENDIX_TEST_APP_URL` — base URL of the environment to test
- `MENDIX_TEST_USERNAME` — test account username/email used by generated specs
- `MENDIX_TEST_PASSWORD` — test account password used by generated specs

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

Set `GROQ_API_KEY` in your local environment before running `enrich`
or `explore`. Never commit it — see `.gitignore`.

## New safety & CI features

- Use `--dry-run` when calling the enrich step to preview generated tests without
  writing them. This helps avoid committing secrets introduced during recording.

  ```bash
  GROQ_API_KEY=gsk_... node explorer/enrich.js explorer/raw-<flow-name>.spec.js <app-url> generated-tests/<flow-name>.spec.js --dry-run
  ```

- Validate generated tests for hardcoded credentials before committing or in CI:

  ```bash
  npm run validate:generated
  ```

- CI now includes a dry-run enrich job (runs when `GROQ_API_KEY` and
  `MENDIX_TEST_APP_URL` are set in repository secrets) and will fail PRs that
  produce unsafe generated tests. The regression job also runs the validator
  before executing Playwright tests.

- To enable local pre-commit checks, run:

  ```bash
  git config core.hooksPath .githooks
  npm run prepare
  ```

  This repo includes a `.husky/pre-commit` hook and a `.githooks/pre-commit`
  template that run the generated-test validator and lint-staged.

## Verified against the real app

`pages/BasePage.js`'s `waitForMendixIdle()` was checked against this
project's actual Mendix app (10.24.2, custom Atlas-based theme) using
`explorer/inspect-loading-selector.js`. Findings, dated 2026-08-11:

- No full-page loading overlay is ever rendered by this app/theme — the
  default `LOADING_SELECTOR` guess doesn't match anything here.
- `page.waitForLoadState('networkidle')` resolves correctly and is the
  real signal `waitForMendixIdle()` relies on. The app's dev-only
  WebSocket (`ws://localhost:8080/mxdevtools/`) does not block it.

If you point this scaffold at a different Mendix app/theme, re-run
`explorer/inspect-loading-selector.js` against it before trusting
`LOADING_SELECTOR` — themes vary.
