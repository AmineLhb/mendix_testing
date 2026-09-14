const state = {
  project: null,
  currentJobId: null,
  testsCache: [],
  envLines: [],
};

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---- Toasts ----

function toast(message, type = "success") {
  const container = el("toast-container");
  const node = document.createElement("div");
  node.className = `toast${type === "error" ? " toast-error" : ""}`;
  node.textContent = message;
  container.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

// ---- Client-side field validation ----
//
// Deliberately not relying on HTML `required`/pattern attributes as the
// actual mechanism (forms carry novalidate) — this gives one consistent,
// styled inline error instead of the browser's own validation bubble, and
// lets a field's format be checked against the exact same rule the server
// enforces (e.g. flow name / role name / env name patterns) BEFORE a round
// trip, not only after the server rejects it.

function showFieldError(input, errorEl, message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
  input.classList.add("input-invalid");
}

function clearFieldError(input, errorEl) {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  input.classList.remove("input-invalid");
}

// Returns the trimmed value if it passes required/pattern checks, else shows
// errorEl with a specific message and returns null.
function requireField(input, errorEl, { label, pattern, patternMessage } = {}) {
  const value = input.value.trim();
  if (!value) {
    showFieldError(input, errorEl, `${label || "This field"} is required.`);
    return null;
  }
  if (pattern && !pattern.test(value)) {
    showFieldError(input, errorEl, patternMessage || `${label || "This field"} has an invalid format.`);
    return null;
  }
  clearFieldError(input, errorEl);
  return value;
}

// Same shape, for a <select> — just the presence check, no pattern.
function requireSelect(select, errorEl, label) {
  const value = select.value;
  if (!value) {
    showFieldError(select, errorEl, `${label || "This field"} is required.`);
    return null;
  }
  if (errorEl) clearFieldError(select, errorEl);
  return value;
}

// ---- Confirmation modal (replaces native confirm() for destructive actions) ----

function confirmAction(message, { title = "Are you sure?", confirmLabel = "Delete", danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal" role="alertdialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button type="button" class="btn-plain" data-action="cancel">Cancel</button>
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-teal"} btn-sm" data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const finish = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") finish(false);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-action="confirm"]').focus();
  });
}

// Browser notifications so a run/record you tabbed away from still gets
// noticed — only fires if the tab isn't focused, and only after the user has
// actually started a job (permission is requested from that click, a real
// user gesture, rather than on page load where most browsers just ignore it).
function notifyJobDone(label, exitCode) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  new Notification(exitCode === 0 ? "✓ Passed" : "✗ Failed", {
    body: `${label} — ${state.project}`,
  });
}

function requestNotificationPermission() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  Notification.requestPermission();
}

// ---- View switching ----

function showProjectsView() {
  state.project = null;
  el("view-project").classList.add("hidden");
  el("view-projects").classList.remove("hidden");
  el("back-link").classList.add("hidden");
  el("crumb-sep").classList.add("hidden");
  el("side-current-project").classList.add("hidden");
  el("topbar-title").textContent = "Projects";
  loadProjects();
}

function showProjectView(name) {
  state.project = name;
  el("view-projects").classList.add("hidden");
  el("view-project").classList.remove("hidden");
  el("back-link").classList.remove("hidden");
  el("crumb-sep").classList.remove("hidden");
  el("side-current-project").classList.remove("hidden");
  el("side-current-name").textContent = name;
  el("topbar-title").textContent = name;
  el("log").textContent = "Nothing running yet.";
  el("result-badge").classList.add("hidden");
  el("report-link").href = `/report/${encodeURIComponent(name)}/`;
  el("rename-input").value = "";
  el("project-toolbar-error").classList.add("hidden");
  el("add-role-row").classList.add("hidden");
  el("add-role-input").value = "";
  hideSourcePanel();
  hideTestHistoryPanel();
  switchTab("tests");
  setUiLocked(false);
  loadRunOptions();
  loadEnv();
  loadHistory();
  loadPending();
  loadTests();
  loadCoverage();
  el("scan-results").classList.add("hidden");
  loadPerformance();
  loadRegressionIntelligence();
  loadCoverageMapTable();
  loadDependencies();
}

// ---- Tabs (Tests / Coverage / Runs / Review / Settings) ----

function switchTab(tabName) {
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
  }
}

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

function guardNav(e) {
  e.preventDefault();
  if (state.currentJobId) {
    toast("A job is still running — cancel it first, or wait for it to finish.", "error");
    return true;
  }
  return false;
}

el("back-link").addEventListener("click", (e) => {
  if (guardNav(e)) return;
  showProjectsView();
});

el("side-projects-link").addEventListener("click", (e) => {
  if (guardNav(e)) return;
  showProjectsView();
});

// ---- Project list ----

async function loadProjects() {
  const listEl = el("project-list");
  listEl.innerHTML = '<p class="muted">Loading projects…</p>';
  try {
    const { projects } = await api("/api/projects");
    if (projects.length === 0) {
      listEl.innerHTML = '<p class="muted">No projects yet — create one below.</p>';
      return;
    }
    listEl.innerHTML = "";
    for (const p of projects) {
      const totalTests = Object.values(p.roles).reduce((a, b) => a + b, 0);
      const roleCount = Object.keys(p.roles).length;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "project-card";
      btn.innerHTML = `
        <span>
          <span class="name">${escapeHtml(p.name)}</span><br />
          <span class="summary">${roleCount} role${roleCount === 1 ? "" : "s"}, ${totalTests} test file${totalTests === 1 ? "" : "s"}</span>
        </span>
        <span class="arrow">&rarr;</span>
      `;
      btn.addEventListener("click", () => showProjectView(p.name));
      listEl.appendChild(btn);
    }
  } catch (err) {
    listEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

el("new-project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = el("new-project-name");
  const errorEl = el("new-project-error");
  const name = requireField(nameInput, errorEl, {
    label: "Project name",
    pattern: /^[A-Za-z0-9_-]+$/,
    patternMessage: "Project name may only contain letters, numbers, hyphens, and underscores.",
  });
  if (!name) return;
  try {
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
    nameInput.value = "";
    showProjectView(name);
  } catch (err) {
    showFieldError(nameInput, errorEl, err.message);
  }
});

// ---- Project toolbar: rename / delete ----

el("rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const input = el("rename-input");
  const errorEl = el("project-toolbar-error");
  const newName = requireField(input, errorEl, {
    label: "New project name",
    pattern: /^[A-Za-z0-9_-]+$/,
    patternMessage: "Project name may only contain letters, numbers, hyphens, and underscores.",
  });
  if (!newName) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/rename`, {
      method: "POST",
      body: JSON.stringify({ newName }),
    });
    toast(`Renamed to "${newName}".`);
    showProjectView(newName);
  } catch (err) {
    showFieldError(input, errorEl, err.message);
  }
});

el("delete-project-btn").addEventListener("click", async () => {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const ok = await confirmAction(
    `Delete project "${state.project}"? This removes its generated-tests, .env, and report — this cannot be undone.`,
    { title: "Delete project?", confirmLabel: "Delete project" }
  );
  if (!ok) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}`, { method: "DELETE" });
    toast(`Deleted "${state.project}".`);
    showProjectsView();
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---- Env editor (Default = project .env, or a named environment) ----
//
// Secure secrets management V1 (masking): parsed into KEY=VALUE fields,
// password/secret/token-looking keys rendered as type="password" by
// default with a single "Reveal" toggle — never sent anywhere unmasked,
// this is purely a display concern client-side. The raw textarea stays
// available (collapsed) for content the structured view can't represent
// well (comments, unusual formatting) — whichever one is open when you
// hit Save is treated as authoritative.

function envApiPath(envName) {
  const base = `/api/projects/${encodeURIComponent(state.project)}`;
  return envName ? `${base}/environments/${encodeURIComponent(envName)}` : `${base}/env`;
}

function parseEnvLines(text) {
  return text.split("\n").map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return m ? { type: "kv", key: m[1], value: m[2] } : { type: "raw", text: line };
  });
}

function serializeEnvLines(lines) {
  return lines.map((l) => (l.type === "kv" ? `${l.key}=${l.value}` : l.text)).join("\n");
}

function isSecretKey(key) {
  return /password|secret|token|api_key|apikey/i.test(key);
}

function renderEnvFields(lines) {
  const container = el("env-fields");
  const reveal = el("env-reveal-toggle").checked;
  const kvIndices = lines.map((l, i) => i).filter((i) => lines[i].type === "kv");
  if (!kvIndices.length) {
    container.innerHTML = '<p class="muted">No KEY=VALUE lines found — use raw text edit below.</p>';
    return;
  }
  container.innerHTML = kvIndices
    .map((i) => {
      const l = lines[i];
      const masked = isSecretKey(l.key) && !reveal;
      return `
        <label class="env-field-row">
          ${escapeHtml(l.key)}
          <input type="${masked ? "password" : "text"}" data-index="${i}" value="${escapeHtml(l.value)}" autocomplete="off" />
        </label>
      `;
    })
    .join("");
}

el("env-reveal-toggle").addEventListener("change", () => renderEnvFields(state.envLines || []));

async function loadEnv() {
  const textarea = el("env-editor");
  const envName = el("env-picker").value;
  el("env-delete-btn").classList.toggle("hidden", !envName);
  el("env-fields").innerHTML = '<p class="muted">Loading…</p>';
  textarea.value = "Loading…";
  try {
    const { content } = await api(envApiPath(envName));
    textarea.value = content;
    state.envLines = parseEnvLines(content);
    renderEnvFields(state.envLines);
  } catch (err) {
    textarea.value = "";
    el("env-fields").innerHTML = "";
    toast(err.message, "error");
  }
}

el("env-picker").addEventListener("change", loadEnv);

function currentEnvContent() {
  const rawOpen = document.querySelector(".env-raw-details")?.open;
  if (rawOpen) return el("env-editor").value;
  const lines = (state.envLines || []).map((l) => ({ ...l }));
  for (const input of el("env-fields").querySelectorAll("input[data-index]")) {
    const idx = Number(input.dataset.index);
    if (lines[idx]) lines[idx].value = input.value;
  }
  return serializeEnvLines(lines);
}

el("env-save-btn").addEventListener("click", async () => {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const statusEl = el("env-save-status");
  const envName = el("env-picker").value;
  try {
    await api(envApiPath(envName), {
      method: "POST",
      body: JSON.stringify({ content: currentEnvContent() }),
    });
    statusEl.textContent = "Saved.";
    toast(`Saved ${envName || "Default"}.`);
    setTimeout(() => (statusEl.textContent = ""), 2500);
    await loadEnv();
  } catch (err) {
    toast(err.message, "error");
  }
});

el("env-new-btn").addEventListener("click", () => {
  el("env-new-row").classList.remove("hidden");
  clearFieldError(el("env-new-name"), el("env-new-error"));
  el("env-new-name").focus();
});

async function submitNewEnvironment() {
  const input = el("env-new-name");
  const errorEl = el("env-new-error");
  const name = requireField(input, errorEl, {
    label: "Environment name",
    pattern: /^[A-Za-z][A-Za-z0-9_-]*$/,
    patternMessage: "Environment name must start with a letter, and contain only letters, numbers, hyphens, and underscores.",
  });
  if (!name) return;
  try {
    // BASE_URL plus one username/password pair per role this project already
    // has, ready to fill in — not a bare "BASE_URL=" that fails the first
    // time any role tries to log in.
    const { content } = await api(`/api/projects/${encodeURIComponent(state.project)}/env-template`);
    await api(`/api/projects/${encodeURIComponent(state.project)}/environments/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    input.value = "";
    el("env-new-row").classList.add("hidden");
    await loadEnvironmentOptions();
    el("env-picker").value = name;
    await loadEnv();
    toast(`Created environment "${name}".`);
  } catch (err) {
    showFieldError(input, errorEl, err.message);
  }
}

el("env-new-confirm").addEventListener("click", submitNewEnvironment);
el("env-new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitNewEnvironment();
  }
});

el("env-delete-btn").addEventListener("click", async () => {
  const envName = el("env-picker").value;
  if (!envName) return;
  const ok = await confirmAction(`Delete environment "${envName}"? This cannot be undone.`, {
    title: "Delete environment?",
    confirmLabel: "Delete environment",
  });
  if (!ok) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/environments/${encodeURIComponent(envName)}`, {
      method: "DELETE",
    });
    toast(`Deleted "${envName}".`);
    await loadEnvironmentOptions();
    el("env-picker").value = "";
    await loadEnv();
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---- Project dashboard: run/record option population ----

async function loadRunOptions() {
  // Record offers every role defined for this project (projects/<name>/roles.json),
  // even ones with zero tests yet — that's the whole point of being able to add one.
  const { roles: definedRoles } = await api(`/api/projects/${encodeURIComponent(state.project)}/roles`);
  const recordRole = el("record-role");
  const previousRecordRole = recordRole.value;
  recordRole.innerHTML = definedRoles.map((r) => `<option value="${r}">${r}</option>`).join("");
  if (definedRoles.includes(previousRecordRole)) recordRole.value = previousRecordRole;

  // Run's "one role" scope only makes sense for roles that already have at
  // least one test file, so it stays driven by the generated-tests/ folders
  // rather than the full defined-roles list.
  const { roles: testCounts } = await api(`/api/projects/${encodeURIComponent(state.project)}`);
  const rolesWithTests = Object.keys(testCounts);
  const runRole = el("run-role");
  runRole.innerHTML = rolesWithTests.map((r) => `<option value="${r}">${r} (${testCounts[r]})</option>`).join("");
  await loadFileOptions();

  const healRole = el("heal-role");
  const previousHealRole = healRole.value;
  healRole.innerHTML = rolesWithTests.map((r) => `<option value="${r}">${r} (${testCounts[r]})</option>`).join("");
  if (rolesWithTests.includes(previousHealRole)) healRole.value = previousHealRole;
  await loadFilesInto("heal-role", "heal-file");

  const scanRole = el("scan-role");
  const previousScanRole = scanRole.value;
  scanRole.innerHTML = definedRoles.map((r) => `<option value="${r}">${r}</option>`).join("");
  if (definedRoles.includes(previousScanRole)) scanRole.value = previousScanRole;
  if (scanRole.value) loadScanResults(scanRole.value);

  const sessionsRole = el("sessions-role");
  const previousSessionsRole = sessionsRole.value;
  sessionsRole.innerHTML = definedRoles.map((r) => `<option value="${r}">${r}</option>`).join("");
  if (definedRoles.includes(previousSessionsRole)) sessionsRole.value = previousSessionsRole;

  const authLower = el("auth-boundary-lower");
  const authHigher = el("auth-boundary-higher");
  const previousAuthLower = authLower.value;
  const previousAuthHigher = authHigher.value;
  authLower.innerHTML = definedRoles.map((r) => `<option value="${r}">${r}</option>`).join("");
  authHigher.innerHTML = definedRoles.map((r) => `<option value="${r}">${r}</option>`).join("");
  if (definedRoles.includes(previousAuthLower)) authLower.value = previousAuthLower;
  if (definedRoles.includes(previousAuthHigher)) authHigher.value = previousAuthHigher;
  if (authLower.value && authHigher.value) loadAuthBoundaryResults(authLower.value, authHigher.value);

  const nlRole = el("nl-role");
  const previousNlRole = nlRole.value;
  nlRole.innerHTML = definedRoles.map((r) => `<option value="${r}">${r}</option>`).join("");
  if (definedRoles.includes(previousNlRole)) nlRole.value = previousNlRole;

  const assertionsRole = el("assertions-role");
  const previousAssertionsRole = assertionsRole.value;
  assertionsRole.innerHTML = rolesWithTests.map((r) => `<option value="${r}">${r} (${testCounts[r]})</option>`).join("");
  if (rolesWithTests.includes(previousAssertionsRole)) assertionsRole.value = previousAssertionsRole;
  await loadFilesInto("assertions-role", "assertions-file");

  const { tags } = await api(`/api/projects/${encodeURIComponent(state.project)}/tags`);
  const runTag = el("run-tag");
  runTag.innerHTML = tags.length
    ? tags.map((t) => `<option value="${t}">${t}</option>`).join("")
    : '<option value="">(no tags found in this project\'s tests)</option>';

  await loadEnvironmentOptions();
}

// ---- Multiple environments (Dev/QA/Staging/...) ----

async function loadEnvironmentOptions() {
  const { environments } = await api(`/api/projects/${encodeURIComponent(state.project)}/environments`);
  const runEnv = el("run-environment");
  const previousRunEnv = runEnv.value;
  runEnv.innerHTML =
    '<option value="">Default</option>' + environments.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("");
  if (environments.includes(previousRunEnv)) runEnv.value = previousRunEnv;

  const picker = el("env-picker");
  const previousPicked = picker.value;
  picker.innerHTML =
    '<option value="">Default</option>' + environments.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("");
  if (environments.includes(previousPicked)) picker.value = previousPicked;
}

// ---- Add a role (per project — projects/<name>/roles.json) ----

el("add-role-btn").addEventListener("click", () => {
  el("add-role-row").classList.remove("hidden");
  clearFieldError(el("add-role-input"), el("add-role-error"));
  el("add-role-input").focus();
});

async function submitAddRole() {
  const input = el("add-role-input");
  const errorEl = el("add-role-error");
  const role = requireField(input, errorEl, {
    label: "Role name",
    pattern: /^[a-z][a-z0-9-]*$/,
    patternMessage: "Role name must start with a lowercase letter, and contain only lowercase letters, digits, and hyphens.",
  });
  if (!role) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/roles`, {
      method: "POST",
      body: JSON.stringify({ role }),
    });
    input.value = "";
    el("add-role-row").classList.add("hidden");
    await loadRunOptions();
    el("record-role").value = role;
    toast(`Added role "${role}".`);
  } catch (err) {
    showFieldError(input, errorEl, err.message);
  }
}

el("add-role-confirm").addEventListener("click", submitAddRole);
el("add-role-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitAddRole();
  }
});

async function loadFilesInto(roleSelectId, fileSelectId) {
  const role = el(roleSelectId).value;
  const fileSelect = el(fileSelectId);
  if (!role) {
    fileSelect.innerHTML = "";
    return;
  }
  const { files } = await api(`/api/projects/${encodeURIComponent(state.project)}/roles/${encodeURIComponent(role)}/files`);
  fileSelect.innerHTML = files.map((f) => `<option value="${f}">${f}</option>`).join("");
}

function loadFileOptions() {
  return loadFilesInto("run-role", "run-file");
}

el("run-scope").addEventListener("change", () => {
  const scope = el("run-scope").value;
  el("run-role-row").classList.toggle("hidden", scope !== "role" && scope !== "file");
  el("run-file-row").classList.toggle("hidden", scope !== "file");
  el("run-tag-row").classList.toggle("hidden", scope !== "tag");
  if (scope !== "file") hideSourcePanel();
});

el("run-role").addEventListener("change", loadFileOptions);
el("heal-role").addEventListener("change", () => {
  clearFieldError(el("heal-file"), el("fix-test-error"));
  loadFilesInto("heal-role", "heal-file");
});
el("heal-file").addEventListener("change", () => clearFieldError(el("heal-file"), el("fix-test-error")));
el("assertions-role").addEventListener("change", () => loadFilesInto("assertions-role", "assertions-file"));

// ---- Source viewer ----

function hideSourcePanel() {
  el("source-panel").classList.add("hidden");
}

async function showSource(role, file) {
  if (!role || !file) return;
  try {
    const { spec, feature } = await api(
      `/api/projects/${encodeURIComponent(state.project)}/roles/${encodeURIComponent(role)}/files/${encodeURIComponent(file)}/source`
    );
    el("source-title").textContent = `${role}/${file}`;
    el("source-spec").textContent = spec;
    el("source-feature").textContent = feature ?? "(no .feature file — this spec has no test.step() calls yet)";
    el("source-panel").classList.remove("hidden");
    el("source-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    toast(err.message, "error");
  }
}

el("view-source-btn").addEventListener("click", () => showSource(el("run-role").value, el("run-file").value));
el("source-close").addEventListener("click", hideSourcePanel);

// ---- Per-test history (screenshots on failure, flaky-rate summary) ----

function hideTestHistoryPanel() {
  el("test-history-panel").classList.add("hidden");
}

async function openTestHistory(role, file) {
  const panel = el("test-history-panel");
  const listEl = el("test-history-list");
  el("test-history-title").textContent = `${role}/${file}`;
  listEl.innerHTML = '<p class="muted">Loading…</p>';
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const { entries, flaky, failureRate } = await api(
      `/api/projects/${encodeURIComponent(state.project)}/roles/${encodeURIComponent(role)}/files/${encodeURIComponent(file)}/history`
    );
    if (!entries.length) {
      listEl.innerHTML = '<p class="muted">No runs recorded yet for this test.</p>';
      return;
    }
    const flakyNote = flaky
      ? `<p class="muted">⚠ Flaky — ${failureRate}% failure rate over the last ${entries.length} run${entries.length === 1 ? "" : "s"}.</p>`
      : "";
    listEl.innerHTML =
      flakyNote +
      entries
        .map(
          (e) => `
        <div class="test-history-row">
          <span class="status-chip ${e.status}">${escapeHtml(e.status)}</span>
          <span>${(e.duration / 1000).toFixed(1)}s</span>
          ${e.artifactUrl ? `<a href="${e.artifactUrl}" target="_blank" class="btn-plain">Screenshot</a>` : ""}
          <span class="history-time">${relativeTime(e.finishedAt)}</span>
        </div>
      `
        )
        .join("");
  } catch (err) {
    listEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

el("test-history-close").addEventListener("click", hideTestHistoryPanel);

// ---- Test explorer (Tests tab) ----

function qualityClass(score) {
  if (score >= 90) return "";
  if (score >= 70) return "mid";
  return "low";
}

function renderTestsTable(tests) {
  const container = el("tests-table");
  if (!tests.length) {
    container.innerHTML = state.testsCache.length
      ? '<p class="muted">No tests match the current filters.</p>'
      : '<p class="muted">No tests yet — record one from the Review tab.</p>';
    return;
  }
  const rows = tests
    .map((t) => {
      const tagsHtml = t.tags.length
        ? `<div class="test-tags">${t.tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("")}</div>`
        : "";
      const q = t.quality.overall;
      const npc = t.quality.breakdown.negativePathCoverage;
      const npcHtml =
        npc === undefined
          ? ""
          : `<span class="negative-path-badge ${npc === 0 ? "npc-none" : npc < 50 ? "npc-low" : "npc-good"}" title="Negative/boundary-path coverage: does this test check failure states (invalid input, errors, unauthorized) as well as the happy path? Heuristic, not exhaustive.">${npc === 0 ? "happy-path only" : `neg. paths ${npc}%`}</span>`;
      const statusHtml = t.latest
        ? `<span class="status-chip ${t.latest.status}">${escapeHtml(t.latest.status)}</span>${
            t.flaky ? `<span class="flaky-badge">⚠ flaky ${t.failureRate}%</span>` : ""
          }`
        : '<span class="status-chip none">no runs</span>';
      const duration = t.latest ? `${(t.latest.duration / 1000).toFixed(1)}s` : "—";
      return `
        <tr data-role="${escapeHtml(t.role)}" data-file="${escapeHtml(t.file)}">
          <td>
            <div class="test-name">${escapeHtml(t.role)} / ${escapeHtml(t.flowName)}</div>
            ${tagsHtml}
          </td>
          <td>
            <span class="quality-bar-track"><span class="quality-bar-fill ${qualityClass(q)}" style="width:${q}%"></span></span>${q}%
            ${npcHtml}
          </td>
          <td>${statusHtml}</td>
          <td>${duration}</td>
          <td class="test-actions">
            <button type="button" class="btn-plain" data-action="run">Run</button>
            <button type="button" class="btn-plain" data-action="source">Source</button>
            <button type="button" class="btn-plain" data-action="history">History</button>
            <button type="button" class="btn-plain" data-action="edit">Edit</button>
            <button type="button" class="btn-plain" data-action="delete">Delete</button>
          </td>
        </tr>
      `;
    })
    .join("");
  container.innerHTML = `
    <div style="overflow-x:auto">
      <table class="tests-table">
        <thead><tr><th>Test</th><th>Quality</th><th>Last run</th><th>Duration</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  for (const row of container.querySelectorAll("tr[data-role]")) {
    const { role, file } = row.dataset;
    row.querySelector('[data-action="run"]').addEventListener("click", () =>
      startRun({ scope: "file", role, file, environment: el("run-environment").value, label: file })
    );
    row.querySelector('[data-action="source"]').addEventListener("click", () => showSource(role, file));
    row.querySelector('[data-action="history"]').addEventListener("click", () => openTestHistory(role, file));
    row.querySelector('[data-action="edit"]').addEventListener("click", () => editTest(role, file));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTest(role, file));
  }
}

// Jumps to the Review tab's "Fix an existing test" card, pre-selected to
// this row — doesn't start anything itself, just gets the user to the
// Update/Analyze buttons with the right test already chosen, since actually
// launching a recorder window shouldn't happen on a single misclick.
async function editTest(role, file) {
  switchTab("review");
  await loadRunOptions(); // ensures #heal-role/#heal-file are populated before we set them
  el("heal-role").value = role;
  await loadFilesInto("heal-role", "heal-file");
  el("heal-file").value = file;
  clearFieldError(el("heal-file"), el("fix-test-error"));
  el("fix-test-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function deleteTest(role, file) {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const ok = await confirmAction(`Delete ${role}/${file}? This removes the generated test file — this cannot be undone.`, {
    title: "Delete test?",
    confirmLabel: "Delete test",
  });
  if (!ok) return;
  try {
    await api(
      `/api/projects/${encodeURIComponent(state.project)}/roles/${encodeURIComponent(role)}/files/${encodeURIComponent(file)}`,
      { method: "DELETE" }
    );
    toast(`Deleted ${role}/${file}.`);
    await loadTests();
    await loadCoverage();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---- Test explorer filters (search / role / tag / status) ----
//
// Client-side only, over the already-loaded test list — this project's test
// counts are small enough that a round-trip per keystroke would be pure
// overhead; filtering happens against state.testsCache instead.

function populateTestFilterOptions(tests) {
  const roleSelect = el("tests-filter-role");
  const previousRole = roleSelect.value;
  const roles = [...new Set(tests.map((t) => t.role))].sort((a, b) => a.localeCompare(b));
  roleSelect.innerHTML = '<option value="">All roles</option>' + roles.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
  if (roles.includes(previousRole)) roleSelect.value = previousRole;

  const tagSelect = el("tests-filter-tag");
  const previousTag = tagSelect.value;
  const tags = [...new Set(tests.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b));
  tagSelect.innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  if (tags.includes(previousTag)) tagSelect.value = previousTag;
}

function testStatusCategory(t) {
  if (t.flaky) return "flaky";
  if (!t.latest) return "none";
  return t.latest.status === "passed" ? "passed" : "failed";
}

function applyTestsFilter() {
  const search = el("tests-filter-search").value.trim().toLowerCase();
  const role = el("tests-filter-role").value;
  const tag = el("tests-filter-tag").value;
  const status = el("tests-filter-status").value;

  const filtered = state.testsCache.filter((t) => {
    if (role && t.role !== role) return false;
    if (tag && !t.tags.includes(tag)) return false;
    if (status && testStatusCategory(t) !== status) return false;
    if (search && !`${t.role}/${t.flowName}`.toLowerCase().includes(search)) return false;
    return true;
  });
  renderTestsTable(filtered);
}

for (const id of ["tests-filter-role", "tests-filter-tag", "tests-filter-status"]) {
  el(id).addEventListener("change", applyTestsFilter);
}
el("tests-filter-search").addEventListener("input", applyTestsFilter);
el("tests-filter-clear").addEventListener("click", () => {
  el("tests-filter-search").value = "";
  el("tests-filter-role").value = "";
  el("tests-filter-tag").value = "";
  el("tests-filter-status").value = "";
  applyTestsFilter();
});

async function loadTests() {
  const container = el("tests-table");
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { tests } = await api(`/api/projects/${encodeURIComponent(state.project)}/tests`);
    state.testsCache = tests;
    populateTestFilterOptions(tests);
    applyTestsFilter();
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// ---- Role coverage matrix (Coverage tab) ----

async function loadCoverage() {
  const container = el("coverage-table");
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { roles, flows, matrix } = await api(`/api/projects/${encodeURIComponent(state.project)}/coverage`);
    if (!flows.length) {
      container.innerHTML = '<p class="muted">No tests yet.</p>';
      return;
    }
    const header = `<th>Flow</th>${roles.map((r) => `<th>${escapeHtml(r)}</th>`).join("")}`;
    const rows = flows
      .map((flow) => {
        const cells = roles
          .map((r) => (matrix[flow]?.[r] ? '<td class="coverage-yes">✓</td>' : '<td class="coverage-no">—</td>'))
          .join("");
        return `<tr><td>${escapeHtml(flow)}</td>${cells}</tr>`;
      })
      .join("");
    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="coverage-table">
          <thead><tr>${header}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// ---- Insights: performance / regression intelligence / coverage map ----

async function loadPerformance() {
  const container = el("performance-table");
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { performance } = await api(`/api/projects/${encodeURIComponent(state.project)}/performance`);
    const entries = Object.entries(performance);
    if (!entries.length) {
      container.innerHTML = '<p class="muted">No timed runs yet.</p>';
      return;
    }
    const rows = entries
      .map(
        ([testId, p]) => `
        <tr>
          <td>${escapeHtml(testId)}</td>
          <td>${(p.avg / 1000).toFixed(1)}s</td>
          <td>${(p.p95 / 1000).toFixed(1)}s</td>
          <td>${(p.latest / 1000).toFixed(1)}s ${p.regression ? '<span class="flaky-badge">⚠ slower</span>' : ""}</td>
          <td>${p.runCount}</td>
        </tr>
      `
      )
      .join("");
    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="tests-table">
          <thead><tr><th>Test</th><th>Avg</th><th>P95</th><th>Latest</th><th>Runs</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function loadRegressionIntelligence() {
  const container = el("regression-summary");
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.project)}/regression-intelligence`);
    if (!data.latest) {
      container.innerHTML = '<p class="muted">No grouped run data yet — run the suite at least twice (via "All roles" or a tag) to compare.</p>';
      return;
    }
    const list = (title, ids, cls) =>
      ids.length
        ? `<div class="test-history-row"><strong>${title} (${ids.length})</strong></div>` +
          ids.map((id) => `<div class="test-history-row"><span class="status-chip ${cls}">${cls}</span> ${escapeHtml(id)}</div>`).join("")
        : "";
    const commitLine = data.latest.commit
      ? `<p class="muted">Latest run: commit <code>${escapeHtml(data.latest.commit)}</code>${
          data.previous && data.previous.commit && data.previous.commit !== data.latest.commit
            ? ` (previous run was <code>${escapeHtml(data.previous.commit)}</code> — code changed between runs)`
            : ""
        }, ${relativeTime(data.latest.finishedAt)}</p>`
      : "";
    const nothing = !data.newFailures.length && !data.recovered.length && !data.stillFailing.length;
    container.innerHTML =
      commitLine +
      list("New failures", data.newFailures, "failed") +
      list("Recovered", data.recovered, "passed") +
      list("Still failing", data.stillFailing, "failed") +
      (data.flaky.length ? list("Flaky (recent mix of pass/fail)", data.flaky, "none") : "") +
      (nothing ? '<p class="muted">No changes between the last two runs.</p>' : "");
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function loadCoverageMapTable() {
  const container = el("coverage-map-table");
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { roles } = await api(`/api/projects/${encodeURIComponent(state.project)}/coverage-map`);
    const rows = roles
      .map((r) => {
        if (!r.scanned) {
          return `<tr><td>${escapeHtml(r.role)}</td><td colspan="4" class="muted">Not scanned yet (${r.testedWidgetCount} widget(s) referenced by tests)</td></tr>`;
        }
        return `
          <tr>
            <td>${escapeHtml(r.role)}</td>
            <td>${r.pageCount}</td>
            <td>${r.scannedWidgetCount}</td>
            <td>${r.coveredWidgetCount} / ${r.scannedWidgetCount}</td>
            <td>${r.coveragePct}%</td>
          </tr>
        `;
      })
      .join("");
    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="coverage-table">
          <thead><tr><th>Role</th><th>Pages scanned</th><th>Widgets scanned</th><th>Widgets tested</th><th>Coverage</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function loadDependencies() {
  const container = el("dependencies-table");
  container.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { edges, brokenEdges, cycles } = await api(`/api/projects/${encodeURIComponent(state.project)}/dependencies`);
    if (!edges.length) {
      container.innerHTML = '<p class="muted">No dependencies declared yet.</p>';
      return;
    }
    const rows = edges
      .map((e) => {
        const broken = brokenEdges.some((b) => b.from === e.from && b.to === e.to);
        return `<div class="test-history-row">${escapeHtml(e.from)} → ${escapeHtml(e.to)}${broken ? ' <span class="flaky-badge">⚠ target not found</span>' : ""}</div>`;
      })
      .join("");
    const cycleNote = cycles.length
      ? `<p class="error">⚠ Circular dependency: ${cycles.map((c) => c.join(" → ")).join("; ")}</p>`
      : "";
    container.innerHTML = rows + cycleNote;
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// ---- Recent runs ----

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function loadHistory() {
  const listEl = el("history-list");
  try {
    const { history } = await api(`/api/projects/${encodeURIComponent(state.project)}/history`);
    if (!history.length) {
      listEl.innerHTML = '<p class="muted">No runs yet.</p>';
      return;
    }
    listEl.innerHTML = history
      .map((h) => {
        const statusClass = h.exitCode === 0 ? "pass" : "fail";
        const kind = h.type === "record" ? "Recorded" : "Ran";
        const envBadge = h.environment && h.environment !== "Default" ? ` <span class="tag-chip">${escapeHtml(h.environment)}</span>` : "";
        return `
          <div class="history-row">
            <span class="history-status ${statusClass}"></span>
            <span class="history-label">${kind} ${escapeHtml(h.label || h.role || "")}${envBadge}</span>
            <span class="history-time">${relativeTime(h.finishedAt || h.startedAt)}</span>
          </div>
        `;
      })
      .join("");
  } catch (err) {
    listEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// ---- Pending review: a recording (or a self-healing fix) waiting for a
// human to approve before it becomes a real, running test ----

async function loadPending() {
  const panel = el("pending-panel");
  const listEl = el("pending-list");
  try {
    const { pending } = await api(`/api/projects/${encodeURIComponent(state.project)}/pending`);
    panel.classList.toggle("hidden", pending.length === 0);
    if (!pending.length) return;
    listEl.innerHTML = "";
    for (const item of pending) listEl.appendChild(renderPendingItem(item));
  } catch (err) {
    panel.classList.remove("hidden");
    listEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// Switches to Review and scrolls/flashes the just-created pending item —
// called after a record/heal job finishes, so the user lands somewhere
// useful instead of a finished terminal with no next step.
async function jumpToPendingItem(id) {
  switchTab("review");
  await loadPending();
  const node = el("pending-list").querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) return; // e.g. auto-rejected by validation — nothing to jump to
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("pending-item-flash");
  setTimeout(() => node.classList.remove("pending-item-flash"), 2000);
}

function renderPendingItem(summary) {
  const node = document.createElement("div");
  node.className = "pending-item";
  node.dataset.id = summary.id;
  const kind =
    summary.type === "fix" ? "Suggested fix" : summary.type === "update" ? "Update" : summary.type === "extend" ? "Extended" : "New test";
  node.innerHTML = `
    <div class="pending-item-head">
      <span class="pending-type-badge ${summary.type === "fix" ? "fix" : ""}">${escapeHtml(kind)}</span>
      <span class="pending-title">${escapeHtml(summary.role)} / ${escapeHtml(summary.flowName)}</span>
      <span class="history-time">${relativeTime(summary.createdAt)}</span>
    </div>
    <div class="pending-meta"></div>
    <div class="source-grid">
      <div>
        <div class="source-label">Before</div>
        <pre class="code-block pending-before">Loading…</pre>
      </div>
      <div>
        <div class="source-label">Proposed</div>
        <pre class="code-block pending-after">Loading…</pre>
      </div>
    </div>
    <div class="pending-actions">
      <button type="button" class="btn btn-teal btn-sm" data-action="approve">Approve</button>
      ${summary.type === "new-test" || summary.type === "update" ? '<button type="button" class="btn-plain" data-action="regenerate">Regenerate</button>' : ""}
      <button type="button" class="btn btn-danger btn-sm" data-action="reject">Reject</button>
    </div>
  `;

  loadPendingDetail(summary.id, node);

  node.querySelector('[data-action="approve"]').addEventListener("click", () => approvePendingItem(summary.id));
  node.querySelector('[data-action="reject"]').addEventListener("click", () => rejectPendingItem(summary.id));
  const regenBtn = node.querySelector('[data-action="regenerate"]');
  if (regenBtn) regenBtn.addEventListener("click", () => regeneratePendingItem(summary.id, node));

  return node;
}

async function loadPendingDetail(id, node) {
  try {
    const item = await api(`/api/projects/${encodeURIComponent(state.project)}/pending/${encodeURIComponent(id)}`);
    node.querySelector(".pending-before").textContent = item.before ?? "(nothing to compare — original recording not found)";
    node.querySelector(".pending-after").textContent = item.proposed;
    const metaEl = node.querySelector(".pending-meta");
    const qualityNote = item.meta.quality
      ? ` Test quality: ${item.meta.quality.overall}% (locators ${item.meta.quality.breakdown.locatorStability}%, assertions ${item.meta.quality.breakdown.assertions}%, async ${item.meta.quality.breakdown.asyncHandling}%, BDD ${item.meta.quality.breakdown.bddStructure}%, negative-path coverage ${item.meta.quality.breakdown.negativePathCoverage ?? 0}%).`
      : "";
    if (item.meta.type === "fix" && Array.isArray(item.meta.fixes)) {
      // heal-scan.js's multi-locator scan result.
      const fixLines = item.meta.fixes.map((f) => `${f.oldWidget} → ${f.newWidget} (${f.confidence}%)`).join("; ");
      const unresolvedNote = item.meta.unresolved?.length
        ? ` ⚠ ${item.meta.unresolved.length} locator(s) still need a manual look: ${item.meta.unresolved.map((u) => u.oldWidget).join(", ")}.`
        : "";
      metaEl.textContent = `${fixLines}.${unresolvedNote}${qualityNote}`;
    } else if (item.meta.type === "fix") {
      // heal.js's single-widget result.
      metaEl.textContent = `${item.meta.oldWidget} → ${item.meta.newWidget} (fix confidence: ${item.meta.confidence}%). ${item.meta.reasoning || ""}${qualityNote}`;
    } else if (item.meta.type === "update") {
      metaEl.textContent = `Re-recorded from scratch — replaces the current test entirely.${qualityNote}`;
    } else if (item.meta.type === "extend") {
      metaEl.textContent = `New step(s) recorded and spliced in right before the existing closing logout step — everything else in the test is untouched.${qualityNote}`;
    } else if (qualityNote) {
      metaEl.textContent = qualityNote.trim();
    } else {
      metaEl.remove();
    }
  } catch (err) {
    node.querySelector(".pending-before").textContent = "";
    node.querySelector(".pending-after").textContent = `Error: ${err.message}`;
  }
}

async function approvePendingItem(id) {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/pending/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    });
    toast("Approved — now part of the regression suite.");
    await loadPending();
    await loadRunOptions();
    await loadTests();
    await loadCoverage();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function rejectPendingItem(id) {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const ok = await confirmAction("Reject this proposal? It will be discarded.", {
    title: "Reject proposal?",
    confirmLabel: "Reject",
  });
  if (!ok) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/pending/${encodeURIComponent(id)}/reject`, {
      method: "POST",
    });
    toast("Rejected.");
    await loadPending();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function regeneratePendingItem(id, node) {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  try {
    const { jobId } = await api(
      `/api/projects/${encodeURIComponent(state.project)}/pending/${encodeURIComponent(id)}/regenerate`,
      { method: "POST" }
    );
    setJobRunning(true, "Regenerating…");
    // Not shown anywhere — a detached element just so streamJob has a real
    // DOM node to write progress into (avoids reimplementing its API with a
    // fake object). The actual regenerated content is picked up via
    // loadPendingDetail() once the job finishes.
    const sink = document.createElement("pre");
    streamJob(jobId, sink, "Regenerate", async () => {
      await loadPendingDetail(id, node);
      toast("Regenerated — review the updated proposal.");
    });
  } catch (err) {
    toast(err.message, "error");
    setJobRunning(false);
  }
}

// ---- Actions: run / record, streamed to the log panel ----

function resetLog() {
  const logEl = el("log");
  logEl.textContent = "";
  el("result-badge").classList.add("hidden");
  return logEl;
}

// While a job is running, the only allowed action is Cancel — starting a
// second job (a run while a record is mid-flight, or vice versa) would
// spawn a second browser session, and this Mendix app's trial license caps
// concurrent signed-in sessions (see README's "known issue" section), so a
// second job isn't just confusing, it actively makes the seat-cap problem
// worse. Rename/delete/switching project mid-job would also orphan the
// running child process from a UI that's no longer showing it.
function setUiLocked(locked) {
  el("run-form").querySelector("button[type=submit]").disabled = locked;
  el("record-form").querySelector("button[type=submit]").disabled = locked;
  el("rename-form").querySelector("button[type=submit]").disabled = locked;
  el("delete-project-btn").disabled = locked;
  el("env-save-btn").disabled = locked;
  el("fix-update-btn").disabled = locked;
  el("fix-analyze-btn").disabled = locked;
  el("fix-extend-btn").disabled = locked;
  el("scan-form").querySelector("button[type=submit]").disabled = locked;
  el("auth-boundary-form").querySelector("button[type=submit]").disabled = locked;
  el("sessions-check-btn").disabled = locked;
  el("sessions-reset-role-btn").disabled = locked;
  el("sessions-reset-all-btn").disabled = locked;
  el("assertions-form").querySelector("button[type=submit]").disabled = locked;
  el("nl-form").querySelector("button[type=submit]").disabled = locked;
  el("env-new-confirm").disabled = locked;
  el("env-delete-btn").disabled = locked;
  // Rendered dynamically per pending item / test row, so queried live rather
  // than by id.
  for (const btn of el("pending-list").querySelectorAll("button")) btn.disabled = locked;
  for (const btn of el("tests-table").querySelectorAll("button")) btn.disabled = locked;
}

function setJobRunning(running, label) {
  const status = el("job-status");
  status.classList.toggle("hidden", !running);
  if (running) el("job-status-text").textContent = label || "Running…";
  el("cancel-job-btn").classList.toggle("hidden", !running);
  setUiLocked(running);
}

function showResultBadge(exitCode) {
  const badge = el("result-badge");
  badge.classList.remove("hidden", "pass", "fail");
  if (exitCode === 0) {
    badge.textContent = "PASSED";
    badge.classList.add("pass");
  } else {
    badge.textContent = "FAILED";
    badge.classList.add("fail");
  }
}

function streamJob(jobId, logEl, label, onDone) {
  state.currentJobId = jobId;
  const source = new EventSource(`/api/stream/${jobId}`);
  source.onmessage = (e) => {
    logEl.textContent += JSON.parse(e.data);
    logEl.scrollTop = logEl.scrollHeight;
  };
  source.addEventListener("done", (e) => {
    logEl.textContent += `\n\n[done, exit code ${e.data}]`;
    logEl.scrollTop = logEl.scrollHeight;
    source.close();
    state.currentJobId = null;
    setJobRunning(false);
    showResultBadge(Number(e.data));
    notifyJobDone(label, Number(e.data));
    loadHistory();
    onDone?.(Number(e.data));
  });
  source.onerror = () => {
    source.close();
    state.currentJobId = null;
    setJobRunning(false);
  };
}

el("cancel-job-btn").addEventListener("click", async () => {
  if (!state.currentJobId) return;
  try {
    await api(`/api/jobs/${state.currentJobId}/cancel`, { method: "POST" });
    toast("Cancelled.");
  } catch (err) {
    toast(err.message, "error");
  }
});

// Shared by the Runs tab's form AND a single row's "Run" button in the Tests
// tab — same /api/run call either way, just a different scope/label.
async function startRun({ scope, role, file, tag, environment, label }, button) {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  requestNotificationPermission();
  if (button) button.disabled = true;
  setJobRunning(true, "Running tests…");
  const logEl = resetLog();
  logEl.textContent = "Starting test run…\n";
  try {
    const { jobId } = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ project: state.project, scope, role, file, tag, environment }),
    });
    streamJob(jobId, logEl, label, async () => {
      if (button) button.disabled = false;
      await loadRunOptions();
      await loadTests();
      await loadPerformance();
      await loadRegressionIntelligence();
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    if (button) button.disabled = false;
    setJobRunning(false);
  }
}

el("run-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const scope = el("run-scope").value;
  const role = el("run-role").value;
  const file = el("run-file").value;
  const tag = el("run-tag").value;
  const environment = el("run-environment").value;
  const label =
    scope === "file" ? file : scope === "role" ? `role "${role}"` : scope === "tag" ? `tag "${tag}"` : "all tests";
  startRun({ scope, role, file, tag, environment, label }, e.target.querySelector("button[type=submit]"));
});

el("record-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = requireSelect(el("record-role"), null, "Role");
  const flowName = requireField(el("record-flow-name"), el("record-flow-name-error"), {
    label: "Flow name",
    pattern: /^[a-z0-9-]+$/,
    patternMessage: "Flow name must be lowercase letters, digits, and hyphens only (e.g. validate-visit).",
  });
  if (!role) return toast("Pick a role first.", "error");
  if (!flowName) return;
  requestNotificationPermission();
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  setJobRunning(true, "Recording…");
  const logEl = resetLog();
  logEl.textContent = "Launching the recorder — a browser window should open shortly.\nClick through the flow, then close that window to finish.\n\n";
  try {
    const { jobId } = await api("/api/record", {
      method: "POST",
      body: JSON.stringify({ project: state.project, role, flowName }),
    });
    streamJob(jobId, logEl, `${role}/${flowName}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) el("record-flow-name").value = "";
      await loadRunOptions();
      // The recorder window closing is the whole point of this job — jump
      // straight to Review instead of leaving the user staring at a
      // finished terminal with no obvious next step (previously had to
      // manually find the Review tab themselves).
      if (exitCode === 0) await jumpToPendingItem(`${role}-${flowName}`);
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

// ---- Fix an existing test: Update (re-record) / Analyze & heal locators ----
//
// Both share the same role/file pickers (still #heal-role/#heal-file — kept
// the IDs from the old single-widget self-heal card to avoid touching
// loadRunOptions()'s wiring) and both land in the same pending review queue
// as a brand-new recording; nothing is ever applied to a real test without
// approval.

function getFixSelection() {
  const role = el("heal-role").value;
  const file = el("heal-file").value;
  if (!role || !file) {
    showFieldError(el("heal-file"), el("fix-test-error"), "Pick a role with an existing test first.");
    return null;
  }
  clearFieldError(el("heal-file"), el("fix-test-error"));
  return { role, file, flowName: file.replace(/\.spec\.js$/, "") };
}

el("fix-update-btn").addEventListener("click", async () => {
  const sel = getFixSelection();
  if (!sel) return;
  const { role, file, flowName } = sel;
  requestNotificationPermission();
  const button = el("fix-update-btn");
  button.disabled = true;
  setJobRunning(true, "Re-recording…");
  const logEl = resetLog();
  logEl.textContent = `Re-recording ${role}/${file} — a browser window should open shortly.\nClick through the FULL flow (not just the changed part), then close that window to finish.\n\n`;
  try {
    const { jobId } = await api("/api/record", {
      method: "POST",
      body: JSON.stringify({ project: state.project, role, flowName, update: true }),
    });
    streamJob(jobId, logEl, `update ${role}/${flowName}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) await jumpToPendingItem(`${role}-${flowName}`);
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

el("fix-extend-btn").addEventListener("click", async () => {
  const sel = getFixSelection();
  if (!sel) return;
  const { role, file, flowName } = sel;
  requestNotificationPermission();
  const button = el("fix-extend-btn");
  button.disabled = true;
  setJobRunning(true, "Preparing to extend…");
  const logEl = resetLog();
  logEl.textContent = `Running ${role}/${file}'s own steps against the app to reach a logged-in starting point, then opening the recorder already there — record only the NEW part, then close the window to finish.\n\n`;
  try {
    const { jobId } = await api("/api/record", {
      method: "POST",
      body: JSON.stringify({ project: state.project, role, flowName, extend: true }),
    });
    streamJob(jobId, logEl, `extend ${role}/${flowName}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) await jumpToPendingItem(`${role}-${flowName}`);
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

el("fix-analyze-btn").addEventListener("click", async () => {
  const sel = getFixSelection();
  if (!sel) return;
  const { role, file, flowName } = sel;
  requestNotificationPermission();
  const button = el("fix-analyze-btn");
  button.disabled = true;
  setJobRunning(true, "Scanning locators…");
  const logEl = resetLog();
  logEl.textContent = `Running ${role}/${file}'s own steps against the app right now to check every locator it uses…\n`;
  try {
    const { jobId } = await api(`/api/projects/${encodeURIComponent(state.project)}/heal-scan`, {
      method: "POST",
      body: JSON.stringify({ role, flowName }),
    });
    streamJob(jobId, logEl, `heal-scan ${role}/${file}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) await jumpToPendingItem(`${role}-${flowName}-fix`);
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

// ---- Mendix App Scanner ----

function renderScanResults(data) {
  const panel = el("scan-results");
  panel.classList.remove("hidden");
  el("scan-summary").textContent = `${data.summary.pageCount} page(s), ${data.summary.uniqueWidgetCount} unique widget(s) — scanned ${relativeTime(data.scannedAt)}.${
    data.stoppedEarly ? ` ⚠ ${data.stoppedEarly}` : ""
  }`;
  el("scan-pages").innerHTML = data.pages
    .map(
      (p, i) => `
      <details class="scan-page">
        <summary>${escapeHtml(p.label)} — ${escapeHtml(p.url)} (${p.widgets.length} widgets)</summary>
        <div class="scan-widget-list">
          ${p.widgets
            .map((w) => `<span class="tag-chip">${escapeHtml(w.mxNames.join(", ") || w.tag)}</span>`)
            .join(" ")}
        </div>
      </details>
    `
    )
    .join("");
}

async function loadScanResults(role) {
  if (!role) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.project)}/scan/${encodeURIComponent(role)}`);
    renderScanResults(data);
  } catch {
    el("scan-results").classList.add("hidden");
  }
}

el("scan-role").addEventListener("change", () => loadScanResults(el("scan-role").value));

const authBoundaryRoleChanged = () => {
  const lower = el("auth-boundary-lower").value;
  const higher = el("auth-boundary-higher").value;
  el("auth-boundary-results").innerHTML = "";
  if (lower && higher && lower !== higher) loadAuthBoundaryResults(lower, higher);
};
el("auth-boundary-lower").addEventListener("change", authBoundaryRoleChanged);
el("auth-boundary-higher").addEventListener("change", authBoundaryRoleChanged);

el("scan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  requestNotificationPermission();
  const role = el("scan-role").value;
  const maxPages = Number(el("scan-max-pages").value) || 15;
  if (!role) return toast("No role selected.", "error");
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  setJobRunning(true, "Scanning app…");
  const logEl = resetLog();
  logEl.textContent = `Logging in as "${role}" and crawling up to ${maxPages} page(s)…\n`;
  try {
    const { jobId } = await api(`/api/projects/${encodeURIComponent(state.project)}/scan`, {
      method: "POST",
      body: JSON.stringify({ role, maxPages }),
    });
    streamJob(jobId, logEl, `scan ${role}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) {
        await loadScanResults(role);
        await loadCoverageMapTable();
      }
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

// ---- Authorization boundary scan ----

function renderAuthBoundaryResults(data) {
  const container = el("auth-boundary-results");
  const skippedNote = data.skippedUnidentifiableCount
    ? ` (${data.skippedUnidentifiableCount} default-named, textless widget(s) skipped as unreliable to compare — see the panel description.)`
    : "";
  if (!data.findings.length) {
    container.innerHTML = `<p class="muted">No findings — none of the ${data.exclusiveWidgetCount} widget(s) exclusive to "${escapeHtml(data.higherRole)}" were visible while logged in as "${escapeHtml(data.lowerRole)}".${skippedNote}</p>`;
    return;
  }
  const rows = data.findings
    .map(
      (f) => `
      <div class="test-history-row" style="flex-direction:column;align-items:flex-start;gap:0.3rem;">
        <div><span class="negative-path-badge npc-none">exposed</span> <strong>${escapeHtml(f.widget)}</strong> <span class="muted">(${escapeHtml(f.tag)})</span></div>
        ${f.text ? `<div class="muted">Text: "${escapeHtml(f.text)}"</div>` : ""}
        <div class="muted">Seen at: ${f.seenAt.map(escapeHtml).join(", ")}</div>
      </div>
    `
    )
    .join("");
  container.innerHTML = `
    <p class="muted">${data.findings.length} widget(s) exclusive to "${escapeHtml(data.higherRole)}" in App Scan were visible to "${escapeHtml(data.lowerRole)}". ${escapeHtml(data.note)}${skippedNote}</p>
    ${rows}
  `;
}

async function loadAuthBoundaryResults(lowerRole, higherRole) {
  if (!lowerRole || !higherRole) return;
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(state.project)}/auth-boundary-scan/${encodeURIComponent(lowerRole)}/${encodeURIComponent(higherRole)}`
    );
    renderAuthBoundaryResults(data);
  } catch {
    el("auth-boundary-results").innerHTML = "";
  }
}

el("auth-boundary-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  requestNotificationPermission();
  const lowerSelect = el("auth-boundary-lower");
  const higherSelect = el("auth-boundary-higher");
  const errorEl = el("auth-boundary-error");
  clearFieldError(higherSelect, errorEl);
  const lowerRole = lowerSelect.value;
  const higherRole = higherSelect.value;
  if (!lowerRole || !higherRole) return toast("Pick both roles.", "error");
  if (lowerRole === higherRole) {
    showFieldError(higherSelect, errorEl, "Pick two different roles.");
    return;
  }
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  setJobRunning(true, "Checking authorization boundary…");
  const logEl = resetLog();
  logEl.textContent = `Comparing "${higherRole}"'s App Scan against "${lowerRole}"'s live session…\n`;
  try {
    const { jobId } = await api(`/api/projects/${encodeURIComponent(state.project)}/auth-boundary-scan`, {
      method: "POST",
      body: JSON.stringify({ lowerRole, higherRole }),
    });
    streamJob(jobId, logEl, `auth-boundary-scan ${lowerRole} vs ${higherRole}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) await loadAuthBoundaryResults(lowerRole, higherRole);
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

// ---- Mendix session reset (direct DB access — see
// scripts/reset-mendix-sessions.js's own header for what it does and does
// not guess about the schema) ----

function runSessionsJob(bodyExtra, label, startMessage) {
  requestNotificationPermission();
  const buttons = [el("sessions-check-btn"), el("sessions-reset-role-btn"), el("sessions-reset-all-btn")];
  for (const b of buttons) b.disabled = true;
  setJobRunning(true, label);
  const logEl = resetLog();
  logEl.textContent = `${startMessage}\n`;
  const environment = el("env-picker").value;
  api(`/api/projects/${encodeURIComponent(state.project)}/${bodyExtra.path}`, {
    method: "POST",
    body: JSON.stringify({ ...bodyExtra.body, ...(environment ? { environment } : {}) }),
  })
    .then(({ jobId }) => {
      streamJob(jobId, logEl, label, () => {
        for (const b of buttons) b.disabled = false;
      });
    })
    .catch((err) => {
      logEl.textContent += `\nError: ${err.message}`;
      for (const b of buttons) b.disabled = false;
      setJobRunning(false);
    });
}

el("sessions-check-btn").addEventListener("click", () => {
  runSessionsJob({ path: "sessions/check", body: {} }, "Checking sessions…", "Connecting to the database (read-only check)…");
});

el("sessions-reset-all-btn").addEventListener("click", async () => {
  const ok = await confirmAction(
    "This ends EVERY active session in the app's database — including anyone else currently signed in. Fine on a local/trial dev database, not on anything shared.",
    { title: "Clear ALL Mendix sessions?", confirmLabel: "Clear all", danger: true }
  );
  if (!ok) return;
  runSessionsJob({ path: "sessions/reset", body: { all: true } }, "Clearing all sessions…", "Connecting to the database…");
});

el("sessions-reset-role-btn").addEventListener("click", async () => {
  const role = el("sessions-role").value;
  if (!role) return toast("Pick a role first.", "error");
  const ok = await confirmAction(`This ends "${role}"'s active session in the app's database, if it has one.`, {
    title: `Clear "${role}"'s session?`,
    confirmLabel: "Clear",
    danger: false,
  });
  if (!ok) return;
  runSessionsJob({ path: "sessions/reset", body: { role } }, `Clearing ${role}'s session…`, "Connecting to the database…");
});

// ---- AI-generated assertion suggestions (review-only) ----

function renderAssertionSuggestions(data) {
  const container = el("assertions-results");
  if (!data.suggestions.length) {
    container.innerHTML = '<p class="muted">No suggestions — this test already looks well-covered.</p>';
    return;
  }
  container.innerHTML = data.suggestions
    .map(
      (s) => `
      <div class="test-history-row" style="flex-direction:column;align-items:flex-start;gap:0.3rem;">
        <div><strong>${escapeHtml(s.assertion)}</strong> <span class="muted">(${s.confidence}%)</span></div>
        <div class="muted">After: "${escapeHtml(s.afterStep)}"</div>
        <code style="font-size:0.78rem;">${escapeHtml(s.exampleCode)}</code>
        <div class="muted">${escapeHtml(s.rationale)}</div>
      </div>
    `
    )
    .join("");
}

el("assertions-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  requestNotificationPermission();
  const role = el("assertions-role").value;
  const file = el("assertions-file").value;
  const flowName = file.replace(/\.spec\.js$/, "");
  if (!role || !file) return toast("No test file selected.", "error");
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  setJobRunning(true, "Reviewing test…");
  const logEl = resetLog();
  logEl.textContent = `Asking for additional assertion ideas for ${role}/${file}…\n`;
  try {
    const { jobId } = await api(`/api/projects/${encodeURIComponent(state.project)}/suggest-assertions`, {
      method: "POST",
      body: JSON.stringify({ role, flowName }),
    });
    streamJob(jobId, logEl, `suggest-assertions ${role}/${file}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) {
        try {
          const data = await api(
            `/api/projects/${encodeURIComponent(state.project)}/suggest-assertions/${encodeURIComponent(role)}/${encodeURIComponent(flowName)}`
          );
          renderAssertionSuggestions(data);
        } catch (err) {
          toast(err.message, "error");
        }
      }
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

// ---- Natural-language test plan (BDD plan only, not runnable code) ----

function renderNlPlan(data) {
  const container = el("nl-results");
  const rows = data.steps
    .map(
      (s) => `
      <div class="test-history-row">
        <strong>${escapeHtml(s.type)}</strong> ${escapeHtml(s.description)}
        ${s.resolved ? `<span class="tag-chip">${escapeHtml(s.widget)}</span>` : '<span class="flaky-badge">⚠ unresolved</span>'}
      </div>
    `
    )
    .join("");
  container.innerHTML = `${rows}<p class="muted">${escapeHtml(data.summary)}</p>`;
}

el("nl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = requireSelect(el("nl-role"), null, "Role");
  const description = requireField(el("nl-description"), el("nl-description-error"), { label: "Description" });
  if (!role) return toast("Pick a role first.", "error");
  if (!description) return;
  requestNotificationPermission();
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  setJobRunning(true, "Generating plan…");
  const logEl = resetLog();
  logEl.textContent = `Generating a BDD plan for "${description}" as ${role}…\n`;
  try {
    const { jobId, id } = await api(`/api/projects/${encodeURIComponent(state.project)}/generate-plan`, {
      method: "POST",
      body: JSON.stringify({ role, description }),
    });
    streamJob(jobId, logEl, `generate-plan ${role}`, async (exitCode) => {
      button.disabled = false;
      if (exitCode === 0) {
        try {
          const data = await api(`/api/projects/${encodeURIComponent(state.project)}/generate-plan/${encodeURIComponent(id)}`);
          renderNlPlan(data);
        } catch (err) {
          toast(err.message, "error");
        }
      }
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Clear a field's error as soon as the user starts fixing it, rather than
// leaving a stale "required"/format message up until the next submit.
for (const [inputId, errorId] of [
  ["new-project-name", "new-project-error"],
  ["rename-input", "project-toolbar-error"],
  ["record-flow-name", "record-flow-name-error"],
  ["nl-description", "nl-description-error"],
  ["add-role-input", "add-role-error"],
  ["env-new-name", "env-new-error"],
]) {
  el(inputId).addEventListener("input", () => clearFieldError(el(inputId), el(errorId)));
}

if (window.location.port) el("side-port").textContent = window.location.port;

showProjectsView();
