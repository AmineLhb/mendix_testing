/**
 * Multi-project support. Each Mendix app under test gets its own folder
 * under projects/<name>/ (generated-tests/, explorer/ for raw recordings,
 * .env for that app's BASE_URL + role credentials). Tool-level config that
 * isn't tied to any one app — currently just GROQ_API_KEY — lives in the
 * repo root .env instead, loaded first so it's available regardless of
 * which project is active.
 *
 * Every script that used to do a bare `dotenv.config()` against the root
 * .env should now call loadProjectEnv(name) instead, and every script that
 * used to hardcode "generated-tests"/"explorer" paths should resolve them
 * via projectPaths(name) instead — see explorer/enrich.js,
 * scripts/record-and-enrich.js, playwright.config.js for examples.
 */
import fs from "node:fs";
import path from "node:path";
import { isValidRoleName } from "./roles.js";

export const PROJECTS_ROOT = "projects";
export const DEFAULT_PROJECT = "OccupationalMedicine";
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function resolveProjectName(explicit) {
  return explicit || process.env.MENDIX_PROJECT || DEFAULT_PROJECT;
}

export function projectPaths(explicit) {
  const name = resolveProjectName(explicit);
  const root = path.join(PROJECTS_ROOT, name);
  return {
    name,
    root,
    env: path.join(root, ".env"),
    envExample: path.join(root, ".env.example"),
    generatedTests: path.join(root, "generated-tests"),
    explorer: path.join(root, "explorer"),
    playwrightReport: path.join(root, "playwright-report"),
    testResults: path.join(root, "test-results"),
    // Where test-history-reporter.js copies a failure screenshot the moment
    // it records it, since test-results/ (outputDir) is wiped clean by
    // Playwright at the start of every run — a screenshot referenced from
    // test-history.json (which persists indefinitely) would otherwise go
    // dead as soon as the next `npm test` runs.
    testHistoryArtifacts: path.join(root, "explorer", "test-history-artifacts"),
    roles: path.join(root, "roles.json"),
  };
}

export function projectExists(explicit) {
  return fs.existsSync(projectPaths(explicit).root);
}

export function isValidProjectName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Loads root .env (tool-level, e.g. GROQ_API_KEY) then the given project's
 * .env (app-level, e.g. BASE_URL/credentials) — root first so project .env
 * values win if a name ever collided, though today they don't overlap.
 *
 * `environment`, when given (or read from MENDIX_ENV if omitted), loads
 * projects/<name>/environments/<environment>.env INSTEAD of the project's
 * own top-level .env — see "Multiple environments" below. `override: true`
 * on both calls is deliberate: verified 2026-09-10 that a stale value
 * already sitting in process.env (e.g. a long-lived shell that predates a
 * key rotation) otherwise silently wins over whatever's actually committed
 * in the .env file, since dotenv's default is to never overwrite an
 * already-set variable — exactly the bug that caused GROQ_API_KEY to keep
 * resolving to a revoked key earlier this session. */
export async function loadProjectEnv(explicit, environment) {
  const dotenv = (await import("dotenv")).default;
  if (fs.existsSync(".env")) dotenv.config({ override: true });
  const envName = environment ?? process.env.MENDIX_ENV;
  const envPath = envName ? environmentEnvPath(explicit, envName) : projectPaths(explicit).env;
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: true });
}

// ---- Multiple environments (Dev/QA/Staging/... per project) ----
//
// A project's own projects/<name>/.env remains "the default environment" —
// nothing about it changes, and every existing project keeps working
// exactly as before with zero migration. A NAMED environment is an
// additional, opt-in projects/<name>/environments/<envName>.env file in the
// same BASE_URL+credentials format; selecting one at run time (MENDIX_ENV)
// swaps which file loadProjectEnv() reads, so the test source never
// changes — same principle as picking a project via MENDIX_PROJECT.

const ENV_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function isValidEnvironmentName(name) {
  return typeof name === "string" && ENV_NAME_RE.test(name);
}

function environmentsDir(explicit) {
  return path.join(projectPaths(explicit).root, "environments");
}

export function environmentEnvPath(explicit, envName) {
  return path.join(environmentsDir(explicit), `${envName}.env`);
}

/** Named environments only — the project's own top-level .env ("Default")
 * is implicit and always available, not listed here. */
export function listEnvironments(explicit) {
  const dir = environmentsDir(explicit);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".env"))
    .map((f) => f.replace(/\.env$/, ""))
    .sort((a, b) => a.localeCompare(b));
}

export function readEnvironmentContent(explicit, envName) {
  const file = environmentEnvPath(explicit, envName);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

export function writeEnvironment(explicit, envName, content) {
  if (!isValidEnvironmentName(envName)) {
    throw new Error("Environment name must start with a letter and contain only letters, digits, hyphens, and underscores.");
  }
  fs.mkdirSync(environmentsDir(explicit), { recursive: true });
  fs.writeFileSync(environmentEnvPath(explicit, envName), content);
}

export function deleteEnvironment(explicit, envName) {
  if (!isValidEnvironmentName(envName)) throw new Error(`Invalid environment name "${envName}".`);
  const file = environmentEnvPath(explicit, envName);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const TEMPLATE_ENV_EXAMPLE = `BASE_URL=
MENDIX_TEST_USERNAME=
MENDIX_TEST_PASSWORD=
`;

export function createProject(name) {
  if (!NAME_RE.test(name)) {
    throw new Error("Project name may only contain letters, numbers, hyphens, and underscores.");
  }
  const paths = projectPaths(name);
  if (fs.existsSync(paths.root)) {
    throw new Error(`Project "${name}" already exists.`);
  }
  fs.mkdirSync(paths.generatedTests, { recursive: true });
  fs.mkdirSync(paths.explorer, { recursive: true });
  fs.writeFileSync(paths.envExample, TEMPLATE_ENV_EXAMPLE);
  fs.writeFileSync(paths.env, TEMPLATE_ENV_EXAMPLE);
  // Every app has at least one regular-user role; "collaborateur" is the
  // one name resolveRole() (scripts/roles.js) special-cases to the
  // unsuffixed MENDIX_TEST_USERNAME/PASSWORD vars already in the template
  // above, so seeding it here keeps the two in sync out of the box. Add
  // more roles later via the UI's "+ role" control or addProjectRole().
  fs.writeFileSync(paths.roles, JSON.stringify(["collaborateur"], null, 2));
  return paths;
}

// ---- Per-project roles ----
//
// Which roles exist is app-specific (a different Mendix app can have a
// completely different set), so the list itself lives here as project
// data rather than the old global scripts/roles.js dict. What scripts/
// roles.js still owns is the naming *convention* — given a role name,
// which env vars hold its credentials — which is a pure function of the
// name and doesn't need per-project storage.

export function readProjectRoles(explicit) {
  const { roles } = projectPaths(explicit);
  if (!fs.existsSync(roles)) return [];
  try {
    return JSON.parse(fs.readFileSync(roles, "utf-8"));
  } catch {
    return [];
  }
}

/** Minimal starter template for a brand-new named environment: BASE_URL,
 * the one default (unsuffixed) MENDIX_TEST_USERNAME/PASSWORD pair, and DB
 * connection vars for scripts/reset-mendix-sessions.js (see its own header
 * for what those are for) — NOT one username/password pair per role. An
 * earlier version of this filled in every role this project has defined
 * (readProjectRoles/resolveRole), but that produces a wall of ~10+ blank
 * fields for a project with several roles, most of which a given
 * environment may not even need yet; per explicit direction (2026-09-11),
 * this now only pre-fills the one pair every project has by convention
 * (resolveRole's "collaborateur" special case is the unsuffixed
 * MENDIX_TEST_USERNAME/PASSWORD name regardless of what the role is
 * actually called) — add a role-specific suffixed pair by hand only once
 * that role's tests actually need this environment. */
export function defaultEnvTemplate() {
  return [
    "BASE_URL=",
    "MENDIX_TEST_USERNAME=",
    "MENDIX_TEST_PASSWORD=",
    "",
    "# Direct DB connection — used by scripts/reset-mendix-sessions.js to clear",
    "# stuck Mendix sessions between role runs (see its header comment). Only",
    "# needed if you use that script; leave blank otherwise.",
    "MENDIX_DB_HOST=localhost",
    "MENDIX_DB_PORT=5432",
    "MENDIX_DB_NAME=",
    "MENDIX_DB_USER=",
    "MENDIX_DB_PASSWORD=",
  ].join("\n") + "\n";
}

function writeProjectRoles(explicit, list) {
  fs.writeFileSync(projectPaths(explicit).roles, JSON.stringify(list, null, 2));
}

export function addProjectRole(explicit, role) {
  if (!isValidRoleName(role)) {
    throw new Error("Role name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.");
  }
  const list = readProjectRoles(explicit);
  if (list.includes(role)) {
    throw new Error(`Role "${role}" already exists in this project.`);
  }
  list.push(role);
  writeProjectRoles(explicit, list);
  return list;
}

export function removeProjectRole(explicit, role) {
  const list = readProjectRoles(explicit).filter((r) => r !== role);
  writeProjectRoles(explicit, list);
  return list;
}

/** Counts .spec.js files per role folder for a project's generated-tests/,
 * for UI display — e.g. { collaborateur: 3, medecin: 1 }. */
export function projectRoleCounts(explicit) {
  const { generatedTests } = projectPaths(explicit);
  if (!fs.existsSync(generatedTests)) return {};
  const counts = {};
  for (const entry of fs.readdirSync(generatedTests, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const roleDir = path.join(generatedTests, entry.name);
    counts[entry.name] = fs
      .readdirSync(roleDir)
      .filter((f) => f.endsWith(".spec.js")).length;
  }
  return counts;
}

// ---- Tags ----
//
// Playwright tags (test.describe/test's { tag: '@x' } option) aren't
// tracked anywhere separately — they live directly in each spec file, same
// as everything else about a generated test. This just scans for them so
// the UI can offer "run by tag" against whatever tags actually exist,
// rather than a hardcoded list that could drift from the real specs.

// Scoped to actual `tag: ...` expressions (Playwright's test.describe/test
// tag option), not just any "@word" in the file — a naive whole-file scan
// also matches things like `from '@playwright/test'`, which isn't a tag.
const TAG_EXPR_RE = /\btags?:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g;
const TAG_WORD_RE = /@[a-zA-Z][\w-]*/g;

export function projectTags(explicit) {
  const { generatedTests } = projectPaths(explicit);
  if (!fs.existsSync(generatedTests)) return [];
  const tags = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".spec.js")) {
        const text = fs.readFileSync(full, "utf-8");
        for (const exprMatch of text.matchAll(TAG_EXPR_RE)) {
          for (const wordMatch of exprMatch[1].matchAll(TAG_WORD_RE)) tags.add(wordMatch[0]);
        }
      }
    }
  };
  walk(generatedTests);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

// ---- Pending proposals (human review before a test is written for real) ----
//
// Two kinds of change go through here rather than straight to
// generated-tests/: a brand-new AI-generated test ("new-test", written by
// scripts/record-and-enrich.js when called with --stage) and a proposed
// locator fix for an existing test ("fix", written by scripts/heal.js).
// Both are just a proposed spec.js sitting in
// projects/<name>/explorer/pending/<id>/ until a human approves it via the
// UI — nothing lands in generated-tests/, and nothing runs as part of the
// regression suite, until that happens.

function pendingRoot(explicit) {
  return path.join(projectPaths(explicit).explorer, "pending");
}

const PENDING_ID_RE = /^[a-z0-9-]+$/;

export function listPending(explicit) {
  const root = pendingRoot(explicit);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const metaPath = path.join(root, e.name, "meta.json");
      if (!fs.existsSync(metaPath)) return null;
      try {
        return { id: e.name, ...JSON.parse(fs.readFileSync(metaPath, "utf-8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Writes (or overwrites) one pending proposal. `previousText` is the
 * "before" side for a diff — for a brand-new test that's usually left
 * unset (the raw recording already on disk serves that purpose, see
 * readPending below); for a fix it's the current generated-tests content. */
export function writePending(explicit, id, { type, role, flowName, specText, featureText, previousText, ...extra }) {
  if (!PENDING_ID_RE.test(id)) throw new Error(`Invalid pending id "${id}".`);
  const dir = path.join(pendingRoot(explicit), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spec.js"), specText);
  if (featureText) fs.writeFileSync(path.join(dir, "spec.feature"), featureText);
  if (previousText != null) fs.writeFileSync(path.join(dir, "previous.spec.js"), previousText);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ type, role, flowName, createdAt: Date.now(), ...extra }, null, 2)
  );
  return dir;
}

/** Full detail for one pending item, including both sides of the diff:
 * `before` is the raw recording for a new-test proposal, or the current
 * generated-tests content for a fix proposal; `proposed` is what would be
 * written if approved. */
export function readPending(explicit, id) {
  if (!PENDING_ID_RE.test(id)) return null;
  const dir = path.join(pendingRoot(explicit), id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const proposed = fs.readFileSync(path.join(dir, "spec.js"), "utf-8");
  const featurePath = path.join(dir, "spec.feature");
  const feature = fs.existsSync(featurePath) ? fs.readFileSync(featurePath, "utf-8") : null;

  let before = null;
  const previousPath = path.join(dir, "previous.spec.js");
  if (fs.existsSync(previousPath)) {
    before = fs.readFileSync(previousPath, "utf-8");
  } else if (meta.type === "new-test") {
    const rawPath = path.join(projectPaths(explicit).explorer, `raw-${meta.role}-${meta.flowName}.spec.js`);
    before = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf-8") : null;
  }

  return { id, meta, before, proposed, feature, dir };
}

/** Moves a pending proposal into generated-tests/ for real. Returns the
 * file paths written, so the caller can roll back if post-write validation
 * (the hardcoded-secret check) fails. Does NOT run that validation itself —
 * see ui/server.js's approve route, which runs it and rolls back on
 * failure; kept separate so this function has no child-process dependency. */
export function approvePending(explicit, id) {
  const item = readPending(explicit, id);
  if (!item) throw new Error(`Pending item "${id}" not found.`);

  const { generatedTests } = projectPaths(explicit);
  const outDir = path.join(generatedTests, item.meta.role);
  fs.mkdirSync(outDir, { recursive: true });

  const specPath = path.join(outDir, `${item.meta.flowName}.spec.js`);
  fs.writeFileSync(specPath, item.proposed);

  let featurePath = null;
  if (item.feature) {
    featurePath = path.join(outDir, `${item.meta.flowName}.feature`);
    fs.writeFileSync(featurePath, item.feature);
  }

  fs.rmSync(item.dir, { recursive: true, force: true });
  return { specPath, featurePath };
}

export function rejectPending(explicit, id) {
  if (!PENDING_ID_RE.test(id)) throw new Error(`Invalid pending id "${id}".`);
  fs.rmSync(path.join(pendingRoot(explicit), id), { recursive: true, force: true });
}

// ---- Per-test list, tags, and role coverage (Test Explorer / Coverage tab) ----
//
// Unlike run-history.json (one row per UI-triggered job, e.g. "ran all of
// medecin/"), this operates at individual-test granularity, derived by
// scanning generated-tests/ directly — so it can never drift from what
// tests actually exist on disk.

export function listAllTests(explicit) {
  const roles = readProjectRoles(explicit);
  const { generatedTests } = projectPaths(explicit);
  const tests = [];
  for (const role of roles) {
    const roleDir = path.join(generatedTests, role);
    if (!fs.existsSync(roleDir)) continue;
    for (const file of fs.readdirSync(roleDir)) {
      if (!file.endsWith(".spec.js")) continue;
      const flowName = file.replace(/\.spec\.js$/, "");
      const specText = fs.readFileSync(path.join(roleDir, file), "utf-8");
      const tags = new Set();
      for (const exprMatch of specText.matchAll(TAG_EXPR_RE)) {
        for (const wordMatch of exprMatch[1].matchAll(TAG_WORD_RE)) tags.add(wordMatch[0]);
      }
      tests.push({ role, file, flowName, tags: [...tags].sort((a, b) => a.localeCompare(b)) });
    }
  }
  return tests.sort((a, b) => a.role.localeCompare(b.role) || a.flowName.localeCompare(b.flowName));
}

/** Flow x role grid: which roles actually have a test for a given flow name.
 * A flow present under only some roles is exactly the coverage gap this is
 * meant to surface (see README's Role Coverage Matrix section). */
export function roleCoverageMatrix(explicit) {
  const roles = readProjectRoles(explicit);
  const flows = new Set();
  const matrix = {};
  for (const { role, flowName } of listAllTests(explicit)) {
    flows.add(flowName);
    matrix[flowName] ??= {};
    matrix[flowName][role] = true;
  }
  return { roles, flows: [...flows].sort((a, b) => a.localeCompare(b)), matrix };
}

// ---- Per-test run history (test-history-reporter.js appends here from
// inside the actual Playwright process, once per test per run) ----
//
// Keyed by "<role>/<file>" — stable across runs since it's derived from the
// spec file's own location, not anything that changes run to run. Each
// entry also carries any failure attachments (screenshots) Playwright wrote
// for that specific result, so the UI can link straight to them.

const TEST_HISTORY_FILE = "test-history.json";
const TEST_HISTORY_LIMIT = 20;

export function testHistoryPath(explicit) {
  return path.join(projectPaths(explicit).root, TEST_HISTORY_FILE);
}

export function readTestHistory(explicit) {
  const file = testHistoryPath(explicit);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function appendTestHistory(explicit, testId, entry) {
  const file = testHistoryPath(explicit);
  const all = readTestHistory(explicit);
  const list = [entry, ...(all[testId] || [])].slice(0, TEST_HISTORY_LIMIT);
  all[testId] = list;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/** A test only counts as flaky if its recent history is a genuine MIX of
 * pass and fail — a test that's simply broken (always failing) isn't flaky,
 * it's just broken, and shouldn't be filed under the same label. Needs at
 * least 3 data points before saying anything, so one bad run right after a
 * test is first recorded doesn't get flagged. */
export function computeFlaky(entries) {
  if (!entries || entries.length < 3) return { flaky: false, failureRate: 0 };
  const failures = entries.filter((e) => e.status === "failed" || e.status === "timedOut").length;
  const failureRate = Math.round((failures / entries.length) * 100);
  const flaky = failures > 0 && failures < entries.length;
  return { flaky, failureRate };
}

// ---- Test performance analytics ----
//
// Entirely derived from test-history.json — the same real durations already
// collected for the Tests tab, just aggregated. No separate measurement
// pass, no synthetic benchmark.

export function testPerformance(explicit) {
  const history = readTestHistory(explicit);
  const result = {};
  for (const [testId, entries] of Object.entries(history)) {
    const durations = entries.map((e) => e.duration).filter((d) => typeof d === "number");
    if (!durations.length) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const latest = entries[0]?.duration;
    // "Slower than average" only means something once there's more than one
    // data point to average against — a test's very first run can't be a
    // regression relative to itself.
    const regression = entries.length > 1 && typeof latest === "number" && avg > 0 && latest > avg * 1.2;
    result[testId] = {
      avg: Math.round(avg),
      p95: Math.round(p95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      latest,
      regression,
      runCount: entries.length,
    };
  }
  return result;
}

// ---- Scheduled regression intelligence ----
//
// Groups test-history.json entries by the runId test-history-reporter.js
// stamps once per `npx playwright test` invocation (onBegin), then diffs the
// two most recent runs' pass/fail status per test. Real data only — no
// invented "likely affected area" or commit correlation beyond the actual
// git commit hash captured at run time (or null outside a git repo).

export function latestRunGroups(explicit, limit = 2) {
  const history = readTestHistory(explicit);
  const byRun = {};
  for (const [testId, entries] of Object.entries(history)) {
    for (const e of entries) {
      if (!e.runId) continue; // entries from before runId existed — excluded rather than guessed into a group
      byRun[e.runId] ??= { runId: e.runId, commit: e.commit ?? null, finishedAt: 0, results: {} };
      byRun[e.runId].results[testId] = e.status;
      byRun[e.runId].finishedAt = Math.max(byRun[e.runId].finishedAt, e.finishedAt ?? 0);
    }
  }
  return Object.values(byRun)
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, limit);
}

export function regressionIntelligence(explicit) {
  const [latest, previous] = latestRunGroups(explicit, 2);
  if (!latest) return null;

  const isFail = (s) => s === "failed" || s === "timedOut";
  const newFailures = [];
  const recovered = [];
  const stillFailing = [];
  const flaky = [];
  const allTestIds = new Set([...Object.keys(latest.results), ...Object.keys(previous?.results ?? {})]);

  for (const id of allTestIds) {
    const cur = latest.results[id];
    const prev = previous?.results[id];
    if (isFail(cur)) {
      if (prev === undefined || prev === "passed") newFailures.push(id);
      else if (isFail(prev)) stillFailing.push(id);
    } else if (cur === "passed" && isFail(prev)) {
      recovered.push(id);
    }
    if (computeFlaky(historyEntriesFor(explicit, id)).flaky) flaky.push(id);
  }

  return {
    latest: { runId: latest.runId, commit: latest.commit, finishedAt: latest.finishedAt },
    previous: previous ? { runId: previous.runId, commit: previous.commit, finishedAt: previous.finishedAt } : null,
    newFailures,
    recovered,
    stillFailing,
    flaky: [...new Set(flaky)],
  };
}

function historyEntriesFor(explicit, testId) {
  return readTestHistory(explicit)[testId] || [];
}

// ---- Mendix Application Intelligence & Coverage Map ----
//
// Cross-references a role's real App Scanner output (explorer/app-scan/<role>.json)
// against the mx() widget names its generated tests actually reference — a
// real overlap count, not an estimate. Only meaningful for a role that's
// been scanned; a role with tests but no scan yet is reported as such
// rather than silently omitted.

const MX_CALL_RE = /\.mx\(\s*['"`]([^'"`]+)['"`]/g;

export function coverageMap(explicit) {
  const roles = readProjectRoles(explicit);
  const { generatedTests, explorer } = projectPaths(explicit);

  return {
    roles: roles.map((role) => {
      const testedWidgets = new Set();
      const roleDir = path.join(generatedTests, role);
      if (fs.existsSync(roleDir)) {
        for (const file of fs.readdirSync(roleDir)) {
          if (!file.endsWith(".spec.js")) continue;
          const text = fs.readFileSync(path.join(roleDir, file), "utf-8");
          for (const m of text.matchAll(MX_CALL_RE)) testedWidgets.add(m[1]);
        }
      }

      const scanPath = path.join(explorer, "app-scan", `${role}.json`);
      if (!fs.existsSync(scanPath)) {
        return { role, scanned: false, testedWidgetCount: testedWidgets.size };
      }

      const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8"));
      const scannedWidgets = new Set();
      for (const p of scan.pages) for (const w of p.widgets) for (const n of w.mxNames) scannedWidgets.add(n);
      const covered = [...scannedWidgets].filter((w) => testedWidgets.has(w));

      return {
        role,
        scanned: true,
        scannedAt: scan.scannedAt,
        pageCount: scan.pages.length,
        scannedWidgetCount: scannedWidgets.size,
        testedWidgetCount: testedWidgets.size,
        coveredWidgetCount: covered.length,
        coveragePct: scannedWidgets.size ? Math.round((covered.length / scannedWidgets.size) * 100) : null,
      };
    }),
  };
}

// ---- Test dependency visualization ----
//
// There's no implicit dependency between generated tests today (each logs
// in and out independently, by design — see the seat-cap discipline
// elsewhere in this file). This is infrastructure for the case where one
// genuinely exists (e.g. a flow that only makes sense after another flow's
// data exists): a spec declares it with a magic comment,
// `// depends-on: <role>/<file>.spec.js` (comma-separated for more than
// one), and this reads whatever's actually declared — nothing is inferred
// or guessed. Empty today because nothing declares one yet, same as
// evaluation/ being empty until real cases are added.

const DEPENDS_ON_RE = /\/\/\s*depends-on:\s*([^\n]+)/g;

function detectCycles(nodes, edges) {
  const adj = {};
  for (const n of nodes) adj[n] = [];
  for (const e of edges) if (adj[e.from]) adj[e.from].push(e.to);
  const visited = new Set();
  const cycles = [];
  const dfs = (node, stack) => {
    const cycleStart = stack.indexOf(node);
    if (cycleStart > -1) {
      cycles.push([...stack.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    for (const next of adj[node] || []) dfs(next, [...stack, node]);
  };
  for (const n of nodes) dfs(n, []);
  return cycles;
}

export function testDependencyGraph(explicit) {
  const tests = listAllTests(explicit);
  const { generatedTests } = projectPaths(explicit);
  const nodes = tests.map((t) => `${t.role}/${t.file}`);
  const nodeSet = new Set(nodes);
  const edges = [];

  for (const t of tests) {
    const text = fs.readFileSync(path.join(generatedTests, t.role, t.file), "utf-8");
    for (const m of text.matchAll(DEPENDS_ON_RE)) {
      for (const dep of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        edges.push({ from: `${t.role}/${t.file}`, to: dep });
      }
    }
  }

  return {
    nodes,
    edges,
    brokenEdges: edges.filter((e) => !nodeSet.has(e.to)),
    cycles: detectCycles(nodes, edges),
  };
}

// ---- Run history (record + run jobs started from the UI) ----
//
// Kept as a small JSON file per project, not in ui/jobs.js's in-memory job
// map — that map is deliberately volatile (a server restart should drop
// stale child-process references), but "what did I last run and did it
// pass" is exactly the kind of thing worth surviving a restart.

const HISTORY_FILE = "run-history.json";
const HISTORY_LIMIT = 20;

export function historyPath(explicit) {
  return path.join(projectPaths(explicit).root, HISTORY_FILE);
}

export function readHistory(explicit) {
  const file = historyPath(explicit);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

export function appendHistory(explicit, entry) {
  const file = historyPath(explicit);
  const history = [entry, ...readHistory(explicit)].slice(0, HISTORY_LIMIT);
  fs.writeFileSync(file, JSON.stringify(history, null, 2));
}
