# Testing Guide — command sequence for a new manual test

This is the practical, copy-paste guide for the actual day-to-day loop:
record a manual test pass once, turn it into real test code, run that one
test, then run the full regression suite. For the "why" behind each piece,
see [README.md](README.md).

Replace `<app-url>` below with the app you're testing (e.g.
`http://localhost:8080` for a local Studio Pro run, or your deployed test
environment URL). Replace `<flow-name>` with a short name for the flow
you're recording (e.g. `create-visit`, `edit-account`).

## 0. One-time per terminal session

Set your Groq API key so `enrich` can call the model (skip if it's already
set as a persistent environment variable):

```bash
# bash
export GROQ_API_KEY=gsk_...
```

```powershell
# PowerShell
$env:GROQ_API_KEY = "gsk_..."
```

## 1. Record your manual test

Do the manual test pass you'd normally do by hand — Playwright's recorder
opens a real browser and turns your clicks/fills into code as you go.

```bash
npm run record -- <app-url> --output explorer/raw-<flow-name>.spec.js
```

Click through the flow like you normally would to test it manually, then
**close the recorder window** when you're done. This writes the raw,
unpolished recording to `explorer/raw-<flow-name>.spec.js` (gitignored —
it contains whatever you typed, including passwords).

> If your flow needs to start already logged in (to keep the recording
> short and focused), see [Optional: recording from an already-logged-in
> state](#optional-recording-from-an-already-logged-in-state) below.

## 2. Turn the recording into real test code

```bash
npm run enrich -- explorer/raw-<flow-name>.spec.js <app-url> generated-tests/<flow-name>.spec.js
```

This sends the recording to the model along with a live map of the app's
real `mx-name-*` widgets, and writes a maintainable Page Object–based test
to `generated-tests/<flow-name>.spec.js`. **Read the output before trusting
it** — it's a strong first draft, not guaranteed correct; fix anything
that looks off before moving on.

### Enrich dry-run and validation (recommended)

Preview the enriched test before writing it with `--dry-run`:

```bash
GROQ_API_KEY=... node explorer/enrich.js explorer/raw-<flow-name>.spec.js <app-url> generated-tests/<flow-name>.spec.js --dry-run
```

If the preview looks good, run the same command without `--dry-run` to write
the generated file. Always run the validator before committing:

```bash
npm run validate:generated
```

The CI pipeline also runs the validator and an `enrich --dry-run` job when
the `GROQ_API_KEY` secret is configured for the repository.

## 3. Run just that one test

```bash
npx playwright test generated-tests/<flow-name>.spec.js
```

Set these env vars first if the test needs them (same syntax as step 0):

- `BASE_URL` — defaults to `http://localhost:8080` if unset (see
  [playwright.config.js](playwright.config.js))
- `MENDIX_TEST_USERNAME` / `MENDIX_TEST_PASSWORD` — whatever credentials
  the enriched test references

```bash
BASE_URL=<app-url> MENDIX_TEST_USERNAME=... MENDIX_TEST_PASSWORD=... npx playwright test generated-tests/<flow-name>.spec.js
```

## 4. Run the full regression suite

Once the new test passes on its own, run everything in `generated-tests/`
to make sure it plays well with the rest of the suite:

```bash
BASE_URL=<app-url> MENDIX_TEST_USERNAME=... MENDIX_TEST_PASSWORD=... npm test
```

This is the same command CI runs on every push/PR (see
[.github/workflows/regression.yml](.github/workflows/regression.yml)), so
if it's green locally it should be green there too.

## Quick reference

| Step | Command |
|---|---|
| Record | `npm run record -- <app-url> --output explorer/raw-<flow-name>.spec.js` |
| Enrich | `npm run enrich -- explorer/raw-<flow-name>.spec.js <app-url> generated-tests/<flow-name>.spec.js` |
| Run one test | `npx playwright test generated-tests/<flow-name>.spec.js` |
| Run all tests | `npm test` |

## Optional: recording from an already-logged-in state

If a flow only matters *after* login (e.g. "create a record"), you can
record login once, save the session, and start later recordings already
authenticated — keeps each recording short and focused, which the model
handles more reliably than one long combined flow.

```bash
# Record login once, saving the session:
npm run record -- <app-url> --output explorer/raw-login.spec.js --save-storage explorer/session.auth-state.json

# Later recordings start already logged in:
npm run record -- <app-url> --output explorer/raw-<flow-name>.spec.js --load-storage explorer/session.auth-state.json
```

`explorer/session.auth-state.json` is gitignored — it contains a live
session, never commit it. Sessions expire, so re-record login if a later
recording unexpectedly lands back on the login page.
