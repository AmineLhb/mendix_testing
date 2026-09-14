# Evaluation dataset (scaffolding)

Empty by design — this is structure, not data. Nothing here is populated
yet because there is no fleet of recorded flows to populate it from: this
project currently has 7 real generated tests against one Mendix app.
`scripts/run-benchmark.js` reflects that honestly (reports "0 cases in
dataset", not a fabricated pass rate) rather than inventing numbers against
a dataset that doesn't exist.

## Layout

| Folder | Holds |
|---|---|
| `recordings/` | Raw Playwright codegen output (`raw-*.spec.js`) used as benchmark input — same format as `projects/<name>/explorer/raw-*.spec.js`. |
| `expected-tests/` | The enriched `.spec.js` a recording *should* produce — hand-verified once, then used to check future enrich/model changes against. |
| `expected-locators/` | For a given recording, the `mx-name-*` widgets a correct enrichment must use — catches a regression where the model starts inventing or dropping locators. |
| `expected-assertions/` | Minimum assertion set a correct enrichment must include. |
| `expected-bdd/` | Expected `test.step()` label structure (Given/When/Then/And, in order). |
| `failure-cases/` | A real captured Playwright error + the expected AI Failure Analysis classification (locator/timeout/assertion/auth/network/app/infra/environment — see the KPI doc's own category list) — used to check `scripts/ai-failure-reporter.js`'s classification accuracy. |
| `healing-cases/` | A "before" spec with a known-broken locator + the current live widget list + the expected replacement — used to check `scripts/heal.js`'s precision. |

## Populating a case

Each case is a small directory with an `input` (recording/spec/error) and an
`expected` file describing the correct output — not prescribed further here
since no case exists yet to establish the concrete shape from. Add the first
real case (from an actual recording against `OccupationalMedicine` or a
future project) rather than inventing a schema speculatively.

## Running the benchmark

```bash
node scripts/run-benchmark.js
```

Walks every populated case and reports pass/fail per category, plus an
overall score — honestly, meaning it reports **0 cases found** right now.
See `scripts/run-benchmark.js`'s own header for the release rule this is
meant to eventually enforce (no prompt/model change ships if the overall
score drops more than 2%, per the KPI doc's §15 "Release rule").
