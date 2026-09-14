/**
 * Local UI for the record -> enrich -> regress workflow: a project picker
 * (open a recent project or scaffold a new one) plus, per project, buttons
 * for recording a new test, running tests (all / one role / one file), and
 * opening the HTML report — all of it just orchestrating the same CLI
 * scripts documented in TESTING_GUIDE.md, not a reimplementation of them.
 *
 * Usage: npm run ui
 */
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  listProjects,
  projectPaths,
  projectExists,
  createProject,
  projectRoleCounts,
  isValidProjectName,
  readProjectRoles,
  addProjectRole,
  removeProjectRole,
  projectTags,
  listPending,
  readPending,
  approvePending,
  rejectPending,
  readHistory,
  appendHistory,
  listAllTests,
  roleCoverageMatrix,
  readTestHistory,
  computeFlaky,
  listEnvironments,
  readEnvironmentContent,
  writeEnvironment,
  deleteEnvironment,
  isValidEnvironmentName,
  testPerformance,
  regressionIntelligence,
  coverageMap,
  testDependencyGraph,
  defaultEnvTemplate,
  DEFAULT_PROJECT,
} from "../scripts/project.js";
import { randomUUID } from "node:crypto";
import { checkTextForSecrets } from "../scripts/check-secrets.js";
import { scoreTestQuality } from "../scripts/confidence.js";
import { startJob, getJob, cancelJob, pruneOldJobs } from "./jobs.js";

// Tags come from the UI as free text (the "By tag" run option), so unlike
// role/file params — which are checked against a known list — this has to
// be validated by shape alone before it's ever used as a CLI arg.
const TAG_RE = /^@[a-zA-Z][\w-]*$/;

// Flow names are already restricted to this pattern at record time
// (scripts/record-and-enrich.js), so a spec file's basename can never
// contain "..", "/", or anything else that could escape generated-tests/.
const SPEC_FILE_RE = /^[a-z0-9-]+\.spec\.js$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Attaches a listener to a just-started job that appends one row to that
// project's run-history.json once the job finishes — reusing jobs.js's own
// "done" signal (a null line) rather than duplicating exit-tracking here.
function recordHistoryOnFinish(jobId, meta) {
  const job = getJob(jobId);
  if (!job) return;
  const startedAt = Date.now();
  const listener = (text) => {
    if (text !== null) return;
    job.listeners.delete(listener);
    appendHistory(meta.project, {
      ...meta,
      exitCode: job.exitCode,
      startedAt,
      finishedAt: job.finishedAt ?? Date.now(),
    });
  };
  job.listeners.add(listener);
}

// ---- Projects ----

app.get("/api/projects", (req, res) => {
  const projects = listProjects().map((name) => ({ name, roles: projectRoleCounts(name) }));
  res.json({ projects, defaultProject: DEFAULT_PROJECT });
});

app.post("/api/projects", (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Project name is required." });
  try {
    createProject(name);
    res.json({ ok: true, name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/projects/:name", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ name, roles: projectRoleCounts(name) });
});

app.delete("/api/projects/:name", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  fs.rmSync(projectPaths(name).root, { recursive: true, force: true });
  res.json({ ok: true });
});

app.post("/api/projects/:name/rename", (req, res) => {
  const { name } = req.params;
  const newName = (req.body?.newName || "").trim();
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!isValidProjectName(newName)) {
    return res.status(400).json({ error: "Project name may only contain letters, numbers, hyphens, and underscores." });
  }
  const target = projectPaths(newName);
  if (fs.existsSync(target.root)) return res.status(400).json({ error: `Project "${newName}" already exists.` });
  fs.renameSync(projectPaths(name).root, target.root);
  res.json({ ok: true, name: newName });
});

// Roles are per-project now (projects/<name>/roles.json) — a different
// Mendix app can have an entirely different set. scripts/roles.js still owns
// the naming *convention* (role name -> credential env var names), but which
// roles exist at all is project data, read/written here.

app.get("/api/projects/:name/roles", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ roles: readProjectRoles(name) });
});

app.post("/api/projects/:name/roles", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const role = (req.body?.role || "").trim();
  try {
    const roles = addProjectRole(name, role);
    res.json({ ok: true, roles });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/projects/:name/roles/:role", (req, res) => {
  const { name, role } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ ok: true, roles: removeProjectRole(name, role) });
});

app.get("/api/projects/:name/roles/:role/files", (req, res) => {
  const { name, role } = req.params;
  if (!readProjectRoles(name).includes(role)) return res.json({ files: [] });
  const { generatedTests } = projectPaths(name);
  const roleDir = path.join(generatedTests, role);
  if (!fs.existsSync(roleDir)) return res.json({ files: [] });
  const files = fs.readdirSync(roleDir).filter((f) => f.endsWith(".spec.js"));
  res.json({ files });
});

// ---- Spec + companion .feature source viewer ----

app.get("/api/projects/:name/roles/:role/files/:file/source", (req, res) => {
  const { name, role, file } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!SPEC_FILE_RE.test(file)) return res.status(400).json({ error: "Invalid file name." });

  const { generatedTests } = projectPaths(name);
  const specPath = path.join(generatedTests, role, file);
  if (!fs.existsSync(specPath)) return res.status(404).json({ error: "Spec not found." });

  const featurePath = specPath.replace(/\.spec\.js$/, ".feature");
  res.json({
    spec: fs.readFileSync(specPath, "utf-8"),
    feature: fs.existsSync(featurePath) ? fs.readFileSync(featurePath, "utf-8") : null,
  });
});

// Removes a generated test (and its companion .feature, if any) from
// generated-tests/ — the raw recording and past test-history entries are
// left alone, same as approving a "fix" never touches those either.
app.delete("/api/projects/:name/roles/:role/files/:file", (req, res) => {
  const { name, role, file } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!SPEC_FILE_RE.test(file)) return res.status(400).json({ error: "Invalid file name." });

  const { generatedTests } = projectPaths(name);
  const specPath = path.join(generatedTests, role, file);
  if (!fs.existsSync(specPath)) return res.status(404).json({ error: "Spec not found." });

  fs.rmSync(specPath);
  const featurePath = specPath.replace(/\.spec\.js$/, ".feature");
  if (fs.existsSync(featurePath)) fs.rmSync(featurePath);
  res.json({ ok: true });
});

// ---- Project .env editor ----
//
// Raw-text editor, not a structured form: the key set varies per project
// (BASE_URL plus one username/password pair per role that project actually
// uses), and this is the same file record-and-enrich/playwright.config.js
// read directly, so there's no risk of the UI's idea of the schema drifting
// from theirs. Values round-trip in plaintext, same as opening the file in
// an editor would — this is a local tool, not a hosted multi-tenant one.

app.get("/api/projects/:name/env", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const { env } = projectPaths(name);
  res.json({ content: fs.existsSync(env) ? fs.readFileSync(env, "utf-8") : "" });
});

app.post("/api/projects/:name/env", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "content must be a string." });
  fs.writeFileSync(projectPaths(name).env, content);
  res.json({ ok: true });
});

// ---- Multiple environments (Dev/QA/Staging/... per project) ----
//
// A project's own .env is always "Default" and isn't listed here — these
// routes only manage the additional NAMED environments (environments/<name>.env).

app.get("/api/projects/:name/environments", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ environments: listEnvironments(name) });
});

// Starting content for a brand-new named environment: BASE_URL, the default
// MENDIX_TEST_USERNAME/PASSWORD pair, and MENDIX_DB_* vars — see
// scripts/project.js's defaultEnvTemplate() for exactly what and why.
app.get("/api/projects/:name/env-template", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ content: defaultEnvTemplate(name) });
});

// ---- Mendix session reset (direct DB access) — see scripts/reset-mendix-
// sessions.js's own header for what this does and doesn't guess about the
// schema. --yes always passed here since a streamed job has no stdin for
// the CLI's own interactive confirmation prompt — the UI's confirmAction()
// modal is what actually gates this before the request is even sent.

app.post("/api/projects/:name/sessions/check", (req, res) => {
  const { name } = req.params;
  const { environment } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  const args = ["scripts/reset-mendix-sessions.js", "--project", name];
  if (environment) args.push("--environment", environment);
  const jobId = startJob("node", args, { env: process.env });
  res.json({ jobId });
});

app.post("/api/projects/:name/sessions/reset", (req, res) => {
  const { name } = req.params;
  const { all, role, environment } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  if (!all && !role) return res.status(400).json({ error: "Specify all or a role." });
  if (all && role) return res.status(400).json({ error: "all and role are mutually exclusive." });
  if (role && !readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });

  const args = ["scripts/reset-mendix-sessions.js", "--project", name, "--yes"];
  if (all) args.push("--all");
  else args.push("--role", role);
  if (environment) args.push("--environment", environment);
  const jobId = startJob("node", args, { env: process.env });
  res.json({ jobId });
});

app.get("/api/projects/:name/environments/:env", (req, res) => {
  const { name, env } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const content = readEnvironmentContent(name, env);
  if (content === null) return res.status(404).json({ error: "Environment not found." });
  res.json({ content });
});

app.post("/api/projects/:name/environments/:env", (req, res) => {
  const { name, env } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "content must be a string." });
  try {
    writeEnvironment(name, env, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/projects/:name/environments/:env", (req, res) => {
  const { name, env } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  try {
    deleteEnvironment(name, env);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/projects/:name/tags", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ tags: projectTags(name) });
});

// ---- Test explorer / coverage / per-test history ----
//
// All derived from generated-tests/ (what actually exists) plus
// test-history.json (what test-history-reporter.js recorded from actual
// runs) — never a separate source of truth that could drift from either.

app.get("/api/projects/:name/tests", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const { generatedTests } = projectPaths(name);
  const history = readTestHistory(name);
  const tests = listAllTests(name).map((t) => {
    const testId = `${t.role}/${t.file}`;
    const entries = history[testId] || [];
    const specText = fs.readFileSync(path.join(generatedTests, t.role, t.file), "utf-8");
    return {
      ...t,
      quality: scoreTestQuality(specText),
      latest: entries[0] || null,
      runCount: entries.length,
      ...computeFlaky(entries),
    };
  });
  res.json({ tests });
});

app.get("/api/projects/:name/coverage", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json(roleCoverageMatrix(name));
});

// ---- Insights: performance analytics, regression intelligence, coverage map ----
//
// All three are pure aggregations over data already collected elsewhere
// (test-history.json, explorer/app-scan/) — no new measurement pass.

app.get("/api/projects/:name/performance", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ performance: testPerformance(name) });
});

app.get("/api/projects/:name/regression-intelligence", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json(regressionIntelligence(name) ?? { latest: null });
});

app.get("/api/projects/:name/coverage-map", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json(coverageMap(name));
});

app.get("/api/projects/:name/dependencies", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json(testDependencyGraph(name));
});

// ---- AI-generated assertion suggestions (review-only, never auto-applied) ----

const FLOW_NAME_RE = /^[a-z0-9-]+$/;

app.post("/api/projects/:name/suggest-assertions", (req, res) => {
  const { name } = req.params;
  const { role, flowName } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!flowName || !FLOW_NAME_RE.test(flowName)) return res.status(400).json({ error: "Invalid flow name." });

  const jobId = startJob("node", ["scripts/suggest-assertions.js", role, flowName, "--project", name], {
    env: process.env,
  });
  res.json({ jobId });
});

app.get("/api/projects/:name/suggest-assertions/:role/:flowName", (req, res) => {
  const { name, role, flowName } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!FLOW_NAME_RE.test(flowName)) return res.status(400).json({ error: "Invalid flow name." });
  const { explorer } = projectPaths(name);
  const filePath = path.join(explorer, "assertion-suggestions", `${role}-${flowName}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "No suggestions yet for this test." });
  res.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
});

// ---- Natural-language test plan (BDD plan only, never executable code —
// see scripts/generate-from-description.js's own header for why) ----

const PLAN_ID_RE = /^[a-z0-9-]+$/i;

app.post("/api/projects/:name/generate-plan", (req, res) => {
  const { name } = req.params;
  const { role, description } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!description || typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "Description is required." });
  }

  const id = `${role}-${randomUUID()}`;
  // description goes via env var, not a CLI arg — see generate-from-description.js's
  // header comment: spawn's shell:true word-splits a multi-word array arg on Windows.
  const jobId = startJob(
    "node",
    ["scripts/generate-from-description.js", role, "--project", name, "--id", id],
    { env: { ...process.env, MENDIX_NL_DESCRIPTION: description } }
  );
  res.json({ jobId, id });
});

app.get("/api/projects/:name/generate-plan/:id", (req, res) => {
  const { name, id } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: "Invalid plan id." });
  const { explorer } = projectPaths(name);
  const filePath = path.join(explorer, "nl-plans", `${id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Plan not found." });
  res.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
});

app.get("/api/projects/:name/roles/:role/files/:file/history", (req, res) => {
  const { name, role, file } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!SPEC_FILE_RE.test(file)) return res.status(400).json({ error: "Invalid file name." });
  const history = readTestHistory(name);
  const entries = history[`${role}/${file}`] || [];
  const { testHistoryArtifacts } = projectPaths(name);
  // test-history-reporter.js copies each failure screenshot into
  // testHistoryArtifacts/ at record time (see its own comment), so entries
  // written from here on stay valid indefinitely. Older entries recorded
  // before that change still point into the since-wiped test-results/ and
  // will correctly resolve to no URL here — that screenshot is genuinely
  // gone, not recoverable, so hide the link rather than send the client to
  // a dead artifact (previously surfaced as a raw "Cannot GET ..." page).
  const toArtifactUrl = (artifactPath) =>
    artifactPath && fs.existsSync(path.join(testHistoryArtifacts, artifactPath))
      ? `/artifacts/${encodeURIComponent(name)}/${artifactPath.split("/").map(encodeURIComponent).join("/")}`
      : null;
  res.json({
    entries: entries.map((e) => ({ ...e, artifactUrl: toArtifactUrl(e.artifactPath) })),
    ...computeFlaky(entries),
  });
});

// ---- Run history ----

app.get("/api/projects/:name/history", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ history: readHistory(name) });
});

// ---- Run tests ----

app.post("/api/run", (req, res) => {
  const { project, scope, role, file, tag, environment } = req.body || {};
  if (!projectExists(project)) return res.status(400).json({ error: "Unknown project." });
  if (environment && !isValidEnvironmentName(environment)) {
    return res.status(400).json({ error: "Invalid environment name." });
  }
  if (environment && readEnvironmentContent(project, environment) === null) {
    return res.status(400).json({ error: `Environment "${environment}" not found.` });
  }

  // Playwright's positional CLI arg is a SUBSTRING pattern matched against
  // test files already discovered under testDir (playwright.config.js
  // resolves testDir to this project's generated-tests/) — NOT a filesystem
  // path relative to CWD, and NOT anchored to a full path segment. A bare
  // role name like "admin" also matches "admin-fonctionnel/..." (confirmed:
  // `npx playwright test admin` by hand pulls in both). Trail a "/" on the
  // role so it can only match that role's own folder boundary.
  const args = ["playwright", "test"];
  let label = "all tests";
  if (scope === "role" && role) {
    args.push(`${role}/`);
    label = `role "${role}"`;
  } else if (scope === "file" && role && file) {
    args.push(`${role}/${file}`);
    label = file;
  } else if (scope === "tag" && tag) {
    if (!TAG_RE.test(tag)) return res.status(400).json({ error: "Invalid tag." });
    args.push("--grep", tag);
    label = `tag "${tag}"`;
  }
  if (environment) label += ` [${environment}]`;

  const jobId = startJob("npx", args, {
    env: { ...process.env, MENDIX_PROJECT: project, ...(environment ? { MENDIX_ENV: environment } : {}) },
  });
  recordHistoryOnFinish(jobId, { type: "run", project, scope, role, file, tag, environment: environment || "Default", label });
  res.json({ jobId, label });
});

// ---- Record + enrich a new test ----
//
// --stage instead of --force: the UI never writes straight to
// generated-tests/ — every recording lands in the pending/ review queue
// below first (see project.js's pending-proposal functions), and only
// becomes a real test once approved.

app.post("/api/record", (req, res) => {
  const { project, role, flowName, update, extend } = req.body || {};
  if (!projectExists(project)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(project).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!flowName || !/^[a-z0-9-]+$/.test(flowName)) {
    return res.status(400).json({ error: "Flow name must be lowercase letters, digits, and hyphens only." });
  }
  if (update && extend) return res.status(400).json({ error: "update and extend are mutually exclusive." });

  const args = ["scripts/record-and-enrich.js", role, flowName, "--project", project, "--stage"];
  if (update) args.push("--update");
  if (extend) args.push("--extend");
  const jobId = startJob("node", args, { env: process.env });
  recordHistoryOnFinish(jobId, { type: extend ? "extend" : update ? "update" : "record", project, role, label: `${role}/${flowName}` });
  res.json({ jobId });
});

// ---- Self-heal a broken locator ----
//
// Same "grounded in a real replay, never guessed" principle as everywhere
// else — see scripts/heal.js's own header comment. Writes a "fix" proposal
// to the same pending review queue as a new recording; nothing is ever
// applied to a real test without approval.

const WIDGET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

app.post("/api/projects/:name/heal", (req, res) => {
  const { name } = req.params;
  const { role, flowName, oldWidget } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!flowName || !/^[a-z0-9-]+$/.test(flowName)) {
    return res.status(400).json({ error: "Flow name must be lowercase letters, digits, and hyphens only." });
  }
  if (!oldWidget || !WIDGET_NAME_RE.test(oldWidget)) {
    return res.status(400).json({ error: "Widget name must start with a letter and contain only letters, digits, and underscores." });
  }

  const jobId = startJob("node", ["scripts/heal.js", role, flowName, oldWidget, "--project", name], {
    env: process.env,
  });
  res.json({ jobId });
});

// ---- Self-heal, SCAN mode — finds every broken locator automatically,
// instead of requiring the widget name that's failing (see scripts/heal-scan.js) ----

app.post("/api/projects/:name/heal-scan", (req, res) => {
  const { name } = req.params;
  const { role, flowName } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!flowName || !/^[a-z0-9-]+$/.test(flowName)) {
    return res.status(400).json({ error: "Flow name must be lowercase letters, digits, and hyphens only." });
  }

  const jobId = startJob("node", ["scripts/heal-scan.js", role, flowName, "--project", name], {
    env: process.env,
  });
  res.json({ jobId });
});

// ---- Pending proposals (human review before a test is written for real) ----

app.get("/api/projects/:name/pending", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ pending: listPending(name) });
});

app.get("/api/projects/:name/pending/:id", (req, res) => {
  const { name, id } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const item = readPending(name, id);
  if (!item) return res.status(404).json({ error: "Pending item not found." });
  res.json({ id: item.id, meta: item.meta, before: item.before, proposed: item.proposed, feature: item.feature });
});

app.post("/api/projects/:name/pending/:id/approve", (req, res) => {
  const { name, id } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const item = readPending(name, id);
  if (!item) return res.status(404).json({ error: "Pending item not found." });

  // Checked BEFORE anything is written — a proposal that fails this never
  // touches generated-tests/ at all, rather than being written then rolled
  // back (see scripts/check-secrets.js, shared with the same check
  // pre-commit/CI run against files already on disk).
  const problems = checkTextForSecrets(item.proposed);
  if (problems.length) {
    return res.status(400).json({
      error: "Refusing to approve: possible hardcoded secret in the proposed test.",
      problems,
    });
  }

  try {
    const { specPath, featurePath } = approvePending(name, id);
    res.json({ ok: true, specPath, featurePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/projects/:name/pending/:id/reject", (req, res) => {
  const { name, id } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  try {
    rejectPending(name, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/projects/:name/pending/:id/regenerate", (req, res) => {
  const { name, id } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const item = readPending(name, id);
  if (!item) return res.status(404).json({ error: "Pending item not found." });
  if (item.meta.type !== "new-test" && item.meta.type !== "update") {
    return res.status(400).json({ error: "Only a new-test or update proposal can be regenerated." });
  }

  const { role, flowName } = item.meta;
  const { explorer, env } = projectPaths(name);
  const rawPath = path.join(explorer, `raw-${role}-${flowName}.spec.js`);
  if (!fs.existsSync(rawPath)) {
    return res.status(400).json({ error: `Original raw recording not found at ${rawPath} — can't regenerate without it.` });
  }
  // Read straight from the project's .env rather than process.env — this
  // server process never loads any one project's env (each spawned job
  // does that itself via loadProjectEnv()), so process.env.BASE_URL here
  // would be whatever happened to be set when `npm run ui` itself started,
  // not necessarily this project's value.
  const envText = fs.existsSync(env) ? fs.readFileSync(env, "utf-8") : "";
  const baseUrlMatch = envText.match(/^BASE_URL=(.*)$/m);
  const baseUrl = baseUrlMatch?.[1]?.trim();
  if (!baseUrl) {
    return res.status(400).json({ error: `BASE_URL not set in ${env}.` });
  }
  const outPath = path.join(explorer, "pending", id, "spec.js");

  const jobId = startJob(
    "node",
    ["explorer/enrich.js", rawPath, baseUrl, outPath, "--role", role, "--project", name],
    { env: process.env }
  );
  // enrich.js doesn't know about the quality score or meta.json (it's a
  // generic replay+rewrite tool, reused as-is by heal.js too) — recompute
  // and persist it here once the job actually wrote a new spec.js, so the
  // pending-review UI isn't showing a score for content that's since changed.
  const job = getJob(jobId);
  if (job) {
    const listener = (text) => {
      if (text !== null) return;
      job.listeners.delete(listener);
      if (job.exitCode !== 0 || !fs.existsSync(outPath)) return;
      const metaPath = path.join(explorer, "pending", id, "meta.json");
      if (!fs.existsSync(metaPath)) return;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      meta.quality = scoreTestQuality(fs.readFileSync(outPath, "utf-8"));
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    };
    job.listeners.add(listener);
  }
  res.json({ jobId });
});

// ---- Mendix App Scanner ----
//
// A best-effort, single-login exploration of what's actually reachable by
// clicking things while logged in as a given role — see scripts/scan-app.js's
// own header comment for exactly what it does and doesn't do.

app.post("/api/projects/:name/scan", (req, res) => {
  const { name } = req.params;
  const { role, maxPages } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  const pages = Number(maxPages) || 15;
  if (!Number.isInteger(pages) || pages < 1 || pages > 50) {
    return res.status(400).json({ error: "max-pages must be an integer between 1 and 50." });
  }

  const jobId = startJob(
    "node",
    ["scripts/scan-app.js", role, "--project", name, "--max-pages", String(pages)],
    { env: process.env }
  );
  res.json({ jobId });
});

app.get("/api/projects/:name/scan/:role", (req, res) => {
  const { name, role } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  if (!readProjectRoles(name).includes(role)) return res.status(400).json({ error: "Unknown role." });
  const { explorer } = projectPaths(name);
  const scanPath = path.join(explorer, "app-scan", `${role}.json`);
  if (!fs.existsSync(scanPath)) return res.status(404).json({ error: "No scan yet for this role." });
  res.json(JSON.parse(fs.readFileSync(scanPath, "utf-8")));
});

// ---- Authorization boundary scan (see scripts/auth-boundary-scan.js header
// for why this compares widget visibility rather than probing URLs directly) ----

app.post("/api/projects/:name/auth-boundary-scan", (req, res) => {
  const { name } = req.params;
  const { lowerRole, higherRole } = req.body || {};
  if (!projectExists(name)) return res.status(400).json({ error: "Unknown project." });
  const projectRoles = readProjectRoles(name);
  if (!lowerRole || !projectRoles.includes(lowerRole)) return res.status(400).json({ error: "Unknown lower-privilege role." });
  if (!higherRole || !projectRoles.includes(higherRole)) return res.status(400).json({ error: "Unknown higher-privilege role." });
  if (lowerRole === higherRole) return res.status(400).json({ error: "Pick two different roles." });

  const jobId = startJob(
    "node",
    ["scripts/auth-boundary-scan.js", lowerRole, higherRole, "--project", name],
    { env: process.env }
  );
  res.json({ jobId });
});

app.get("/api/projects/:name/auth-boundary-scan/:lowerRole/:higherRole", (req, res) => {
  const { name, lowerRole, higherRole } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  const { explorer } = projectPaths(name);
  const resultPath = path.join(explorer, "auth-boundary-scan", `${lowerRole}-vs-${higherRole}.json`);
  if (!fs.existsSync(resultPath)) return res.status(404).json({ error: "No scan yet for this role pair." });
  res.json(JSON.parse(fs.readFileSync(resultPath, "utf-8")));
});

// ---- Cancel a running job ----

app.post("/api/jobs/:jobId/cancel", (req, res) => {
  res.json({ ok: cancelJob(req.params.jobId) });
});

// ---- Live output stream (SSE) ----

app.get("/api/stream/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).end();

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
  if (job.done) {
    res.write(`event: done\ndata: ${job.exitCode}\n\n`);
    return res.end();
  }

  const listener = (text) => {
    if (text === null) {
      res.write(`event: done\ndata: ${job.exitCode}\n\n`);
      res.end();
    } else {
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    }
  };
  job.listeners.add(listener);
  req.on("close", () => job.listeners.delete(listener));
});

// ---- HTML report (served statically, no separate `playwright show-report`
// process — that command starts its own server and was a recurring source of
// port 9323 conflicts earlier in this project) ----

app.use("/report/:project", (req, res, next) => {
  const { playwrightReport } = projectPaths(req.params.project);
  express.static(playwrightReport)(req, res, next);
});

// ---- Failure artifacts (screenshots test-history-reporter.js recorded) ----

app.use("/artifacts/:project", (req, res, next) => {
  const { testHistoryArtifacts } = projectPaths(req.params.project);
  express.static(testHistoryArtifacts)(req, res, next);
});

// ---- Fallback: single-page app, all non-API routes serve index.html ----
//
// Must exclude /artifacts and /report too, not just /api — otherwise a
// missing screenshot or report file falls through express.static's next()
// into this catch-all, which returns index.html with a 200 instead of a
// real 404. The browser then renders that HTML at the deep /artifacts/...
// URL, where index.html's relative asset links (style.css, app.js) 404 in
// turn, producing an unstyled page with no JS ever running (verified
// 2026-09-10: this is exactly what a stale/missing test-failed-N.png
// screenshot link produced).
app.get(/^(?!\/api|\/report|\/artifacts).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

setInterval(() => pruneOldJobs(), 10 * 60 * 1000).unref();

const PORT = process.env.UI_PORT || 4300;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Mendix Test Agent UI running at ${url}`);
  openBrowser(url);
});

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
