import path from "node:path";
import { defineConfig } from "@playwright/test";
import { loadProjectEnv, projectPaths } from "./scripts/project.js";

// Loads the repo root .env (tool-level, e.g. GROQ_API_KEY) then the active
// project's .env (app-level: BASE_URL + credentials) — see scripts/project.js.
// Active project defaults to DEFAULT_PROJECT unless MENDIX_PROJECT is set
// (the UI server sets it when spawning a run for whichever project you have
// open; set it yourself for a CLI run against a different project, e.g.
// `MENDIX_PROJECT=SomeOtherApp npm test`).
await loadProjectEnv();
const paths = projectPaths();

export default defineConfig({
  testDir: paths.generatedTests,
  outputDir: paths.testResults,
  timeout: 30000,
  // Verified 2026-09-04: running tests in parallel against a local Mendix Studio
  // Pro dev runtime causes real, non-flaky failures (concurrent logins time out
  // finding even the username field). A deployed Mendix Cloud environment may
  // tolerate concurrency better, but default to serial since that's unverified.
  workers: 1,
  // Retry locally too (not just CI): verified 2026-09-07 that even with every
  // test logging out, a local Studio Pro dev license can still race — the
  // seat from one test's logout isn't always released by the time the very
  // next test's login fires, which briefly shows as a generic "Unknown error
  // occurred" on the login form (see README "Known issue" section). That's
  // an environment timing quirk, not a real failure, and it clears itself a
  // few seconds later — so retrying once lets it self-heal instead of
  // requiring a manual app restart every time the suite grows by a test.
  retries: 1,
  // Always write the HTML report (not just in CI or with an explicit
  // --reporter=html flag) so that ANY run — including a role-by-role
  // `npx playwright test <role>` — is what `npm run report` shows
  // afterward, not just a full `npm test`. `list` keeps the familiar
  // terminal output unchanged. `open: "never"` stops a browser tab popping
  // up after every single run; open it on demand with `npm run report`.
  // Each run overwrites the previous report with just that run's results —
  // this is a "what did I just run" report, not a merged history. Scoped
  // under the project folder so different projects' reports don't clobber
  // each other.
  // junit alongside list+html: a portable, widely-ingested results format
  // (most CI dashboards / test-management tools — GitLab, Jenkins, whatever
  // "Digilab" turns out to be — read JUnit XML natively), so this project
  // doesn't need bespoke integration code per external tool.
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: paths.playwrightReport }],
    ["junit", { outputFile: path.join(paths.testResults, "junit.xml") }],
    // Prints a plain-English diagnosis under any failed test, using the same
    // Groq call as enrich.js — no-ops (prints nothing extra) if GROQ_API_KEY
    // isn't set or the call fails, so a missing key/outage never breaks the
    // actual test run. See scripts/ai-failure-reporter.js.
    ["./scripts/ai-failure-reporter.js"],
  ],
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8080",
    // Trace files (.zip) need a separate `npx playwright show-trace` viewer to
    // read — not useful as a plain report/log, and they add up fast. Screenshots
    // are lightweight and viewable directly, so keep those; the HTML report
    // (`npm run report`) is the actual report artifact.
    trace: "off",
    screenshot: "only-on-failure",
  },
});
