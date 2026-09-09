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
 * values win if a name ever collided, though today they don't overlap. */
export async function loadProjectEnv(explicit) {
  const dotenv = (await import("dotenv")).default;
  if (fs.existsSync(".env")) dotenv.config();
  const { env } = projectPaths(explicit);
  if (fs.existsSync(env)) dotenv.config({ path: env });
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
