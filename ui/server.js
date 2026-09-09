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
  DEFAULT_PROJECT,
} from "../scripts/project.js";
import { checkTextForSecrets } from "../scripts/check-secrets.js";
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

app.get("/api/projects/:name/tags", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ tags: projectTags(name) });
});

// ---- Run history ----

app.get("/api/projects/:name/history", (req, res) => {
  const { name } = req.params;
  if (!projectExists(name)) return res.status(404).json({ error: "Project not found." });
  res.json({ history: readHistory(name) });
});

// ---- Run tests ----

app.post("/api/run", (req, res) => {
  const { project, scope, role, file, tag } = req.body || {};
  if (!projectExists(project)) return res.status(400).json({ error: "Unknown project." });

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

  const jobId = startJob("npx", args, {
    env: { ...process.env, MENDIX_PROJECT: project },
  });
  recordHistoryOnFinish(jobId, { type: "run", project, scope, role, file, tag, label });
  res.json({ jobId, label });
});

// ---- Record + enrich a new test ----
//
// --stage instead of --force: the UI never writes straight to
// generated-tests/ — every recording lands in the pending/ review queue
// below first (see project.js's pending-proposal functions), and only
// becomes a real test once approved.

app.post("/api/record", (req, res) => {
  const { project, role, flowName } = req.body || {};
  if (!projectExists(project)) return res.status(400).json({ error: "Unknown project." });
  if (!role || !readProjectRoles(project).includes(role)) return res.status(400).json({ error: "Unknown role." });
  if (!flowName || !/^[a-z0-9-]+$/.test(flowName)) {
    return res.status(400).json({ error: "Flow name must be lowercase letters, digits, and hyphens only." });
  }

  const jobId = startJob(
    "node",
    ["scripts/record-and-enrich.js", role, flowName, "--project", project, "--stage"],
    { env: process.env }
  );
  recordHistoryOnFinish(jobId, { type: "record", project, role, label: `${role}/${flowName}` });
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
  if (item.meta.type !== "new-test") {
    return res.status(400).json({ error: "Only a new-test proposal can be regenerated." });
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
  res.json({ jobId });
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

// ---- Fallback: single-page app, all non-API routes serve index.html ----

app.get(/^(?!\/api|\/report).*/, (req, res) => {
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
