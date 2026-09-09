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
