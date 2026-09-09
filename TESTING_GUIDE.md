# Testing Guide — command sequence for a new manual test

This is the practical, copy-paste guide for the actual day-to-day loop:
record a manual test pass once, turn it into real test code, run that one
test, then run the full regression suite. For the "why" behind each piece,
see [README.md](README.md).

**Prefer clicking over typing?** `npm run ui` opens a browser UI with
buttons for all of this — project picker, record, run, cancel a running
job, add a role on the fly, a "recent runs" history, a source viewer for
any generated `.spec.js`/`.feature` pair, an in-page `.env` editor, and
rename/delete per project — see the "UI" section in
[README.md](README.md#ui). Everything below is the same workflow via the
CLI directly; useful when you want more control, or for CI, which always
uses the CLI.

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
| Check for missing/incomplete `.env` vars across all projects | `npm run validate:env` |
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
  blocked from médecin/admin-only pages/actions? Worth a test per role
  pair where access should be denied, not just where it should succeed.
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
