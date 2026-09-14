/**
 * Playwright globalSetup — runs ONCE before a whole test run starts
 * (whether triggered via `npx playwright test`, `npm test`, or a UI-
 * spawned run job; all three go through this same playwright.config.js).
 *
 * Clears every active Mendix session via scripts/reset-mendix-sessions.js
 * BEFORE any test attempts to log in, so a stranded session from a
 * previous failed/interrupted run doesn't eat into the trial license's
 * seat cap for this run too (see README's "Known issue" section — this is
 * the automatic counterpart to the previously-manual-only reset-sessions
 * script/UI button).
 *
 * Deliberately silent/no-op (not a hard failure) when MENDIX_DB_* isn't
 * configured for the active project/environment — most projects won't
 * have this set up, and a test run shouldn't be blocked by an optional
 * capability being unavailable. Also silent/no-op (not a hard failure) on
 * a genuine connection error for the same reason: this is a best-effort
 * head start, not something a test run should hard-fail on just because
 * the DB happens to be unreachable this one time — the existing app-level
 * mitigations (workers: 1, retries: 1, every test's own logout()) still
 * apply regardless.
 */
import { spawnSync } from "node:child_process";
import { projectPaths } from "./project.js";

export default async function globalSetup() {
  const requiredVars = ["MENDIX_DB_HOST", "MENDIX_DB_NAME", "MENDIX_DB_USER", "MENDIX_DB_PASSWORD"];
  if (requiredVars.some((v) => !process.env[v])) {
    // Not configured for this project/environment — nothing to do, not an error.
    return;
  }

  const paths = projectPaths();
  console.log(`[global-setup] Clearing any stranded Mendix sessions in ${paths.name}'s database before this run starts...`);
  const result = spawnSync(
    "node",
    ["scripts/reset-mendix-sessions.js", "--all", "--yes", "--project", paths.name],
    { encoding: "utf-8", env: process.env }
  );
  if (result.status === 0) {
    console.log(result.stdout.trim().split("\n").slice(-3).join("\n"));
  } else {
    // Best-effort — see header comment. Print why, but let the run continue.
    console.log(`[global-setup] Session clear skipped (non-fatal): ${(result.stderr || result.stdout || "unknown error").trim().split("\n").slice(-2).join(" ")}`);
  }
}
