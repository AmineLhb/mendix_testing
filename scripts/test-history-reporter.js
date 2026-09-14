/**
 * Custom Playwright reporter: records one history entry per test per run
 * into projects/<name>/test-history.json (see project.js's
 * appendTestHistory/readTestHistory/computeFlaky), and captures the path of
 * any failure screenshot Playwright wrote for that result (playwright.config.js
 * sets `screenshot: "only-on-failure"`, so this is naturally empty on a pass).
 *
 * Also runs the AI failure analysis for a failed test (same call
 * ai-failure-reporter.js used to make separately) and persists it onto the
 * history entry — merged into this one reporter rather than kept as two,
 * specifically so there's exactly one Groq call per failure (not two) and no
 * dependency on Playwright's cross-reporter onTestEnd ordering to hand data
 * from one reporter to another.
 *
 * Every entry from the same `npx playwright test` invocation shares a
 * `runId` (set once in onBegin) and the git commit at that point (best
 * effort — falls back to null outside a git repo or if git isn't on PATH) —
 * see project.js's regressionIntelligence(), which groups entries by runId
 * to diff "this run" against "the previous run" (new failures / recovered /
 * still failing).
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { projectPaths, resolveProjectName, appendTestHistory } from "./project.js";
import { analyzeFailure, formatAnalysis } from "./ai-failure-reporter.js";
import { isBlankScreenshot } from "./png-is-blank.js";

// Per-test session clearing (2026-09-11) — the trial Mendix license's seat
// cap is tight enough that even a single-worker, role-scoped run can
// exhaust it partway through (see README's "Known issue" section); the
// one-time clear in scripts/global-setup.js only handles what's stranded
// BEFORE a run starts, not pressure that builds up DURING a long one. This
// clears every session after each individual test attempt finishes, same
// "never guess the schema, --all is safe on a local/trial DB, silently
// no-op without DB config" rules as global-setup.js and
// reset-mendix-sessions.js itself — just reusing the same CLI script
// rather than duplicating its logic.
const SESSION_CLEAR_VARS = ["MENDIX_DB_HOST", "MENDIX_DB_NAME", "MENDIX_DB_USER", "MENDIX_DB_PASSWORD"];
function clearSessionsAfterTest(projectName, testId) {
  if (SESSION_CLEAR_VARS.some((v) => !process.env[v])) return; // not configured — silent no-op, see header
  const result = spawnSync(
    "node",
    ["scripts/reset-mendix-sessions.js", "--all", "--yes", "--project", projectName],
    { encoding: "utf-8", env: process.env }
  );
  if (result.status === 0) {
    // Previously silent on success — invisible in the run log, which is
    // exactly why this needed pointing out (2026-09-11): print the same
    // "Deleted N session row(s)" line global-setup.js already shows once
    // at the top, here after EVERY test, so it's actually visible that
    // this runs per-test, not just once per run.
    const lastLine = result.stdout.trim().split("\n").filter(Boolean).slice(-1)[0];
    console.log(`[session-clear after ${testId}] ${lastLine || "done"}`);
  } else {
    // Best-effort — never fail the actual test run over this.
    console.log(`[session-clear after ${testId}] skipped (non-fatal): ${(result.stderr || result.stdout || "unknown error").trim().split("\n").slice(-1)[0]}`);
  }
}

function currentGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

export default class TestHistoryReporter {
  onBegin() {
    this.runId = `${Date.now()}-${process.pid}`;
    this.commit = currentGitCommit();
  }

  async onTestEnd(test, result) {
    const projectName = resolveProjectName();
    const { generatedTests, testResults, testHistoryArtifacts } = projectPaths(projectName);

    // generated-tests/<role>/<file>.spec.js -> testId "<role>/<file>.spec.js",
    // stable across runs since it's derived from the spec's own location.
    const relFromTests = path.relative(generatedTests, test.location.file);
    const role = relFromTests.split(path.sep)[0];
    const file = path.basename(test.location.file);
    const testId = `${role}/${file}`;

    const screenshot = result.attachments.find((a) => a.name === "screenshot" && a.path);
    // Copy out of test-results/ (Playwright's outputDir, wiped at the start
    // of the NEXT run) into testHistoryArtifacts/<runId>/... right now, while
    // the file still exists, so the link this entry gets in test-history.json
    // stays valid indefinitely instead of dying the next time someone runs
    // the suite. Namespaced by runId since two runs can produce a
    // same-named screenshot for the same retry of the same test.
    let artifactPath = null;
    if (screenshot) {
      try {
        const bytes = fs.readFileSync(screenshot.path);
        // A flat single-color screenshot means the page never actually
        // rendered before the failure (connection refused, timeout before
        // first paint) — there's nothing in it to look at, so don't keep it
        // around as a Screenshot link that just opens a blank image.
        if (!isBlankScreenshot(bytes)) {
          const relFromResults = path.relative(testResults, screenshot.path).split(path.sep).join("/");
          const destRel = path.posix.join(this.runId, relFromResults);
          const destAbs = path.join(testHistoryArtifacts, ...destRel.split("/"));
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.writeFileSync(destAbs, bytes);
          artifactPath = destRel;
        }
      } catch {
        artifactPath = null; // couldn't read/copy — no screenshot is better than a link that's dead on arrival
      }
    }

    let aiAnalysis = null;
    if (result.status === "failed" || result.status === "timedOut") {
      const errorMessage = result.errors.map((e) => e.message || String(e)).join("\n");
      if (errorMessage && process.env.GROQ_API_KEY) {
        aiAnalysis = await analyzeFailure({
          testTitle: test.titlePath().slice(1).join(" › "),
          filePath: test.location.file,
          errorMessage,
        });
        const formatted = formatAnalysis(aiAnalysis);
        if (formatted) console.log(formatted);
      }
    }

    appendTestHistory(projectName, testId, {
      status: result.status,
      duration: result.duration,
      finishedAt: Date.now(),
      title: test.title,
      artifactPath,
      runId: this.runId,
      commit: this.commit,
      aiAnalysis,
    });

    // Clear sessions right after this test (attempt) finishes — see the
    // clearSessionsAfterTest() header comment above for why this exists
    // alongside global-setup.js's once-per-run clear.
    clearSessionsAfterTest(projectName, testId);
  }
}
