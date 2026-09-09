const state = {
  project: null,
  currentJobId: null,
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
  setUiLocked(false);
  loadRunOptions();
  loadEnv();
  loadHistory();
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
  const name = nameInput.value.trim();
  errorEl.classList.add("hidden");
  try {
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
    nameInput.value = "";
    showProjectView(name);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

// ---- Project toolbar: rename / delete ----

el("rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const errorEl = el("project-toolbar-error");
  const newName = el("rename-input").value.trim();
  errorEl.classList.add("hidden");
  if (!newName) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/rename`, {
      method: "POST",
      body: JSON.stringify({ newName }),
    });
    toast(`Renamed to "${newName}".`);
    showProjectView(newName);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

el("delete-project-btn").addEventListener("click", async () => {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  if (!confirm(`Delete project "${state.project}"? This removes its generated-tests, .env, and report — this cannot be undone.`)) {
    return;
  }
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}`, { method: "DELETE" });
    toast(`Deleted "${state.project}".`);
    showProjectsView();
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---- Env editor ----

async function loadEnv() {
  const textarea = el("env-editor");
  textarea.value = "Loading…";
  try {
    const { content } = await api(`/api/projects/${encodeURIComponent(state.project)}/env`);
    textarea.value = content;
  } catch (err) {
    textarea.value = "";
    toast(err.message, "error");
  }
}

el("env-save-btn").addEventListener("click", async () => {
  if (state.currentJobId) return toast("A job is still running — cancel it first.", "error");
  const statusEl = el("env-save-status");
  try {
    await api(`/api/projects/${encodeURIComponent(state.project)}/env`, {
      method: "POST",
      body: JSON.stringify({ content: el("env-editor").value }),
    });
    statusEl.textContent = "Saved.";
    toast("Saved .env");
    setTimeout(() => (statusEl.textContent = ""), 2500);
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
}

// ---- Add a role (per project — projects/<name>/roles.json) ----

el("add-role-btn").addEventListener("click", () => {
  el("add-role-row").classList.remove("hidden");
  el("add-role-input").focus();
});

async function submitAddRole() {
  const input = el("add-role-input");
  const role = input.value.trim();
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
    toast(err.message, "error");
  }
}

el("add-role-confirm").addEventListener("click", submitAddRole);
el("add-role-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitAddRole();
  }
});

async function loadFileOptions() {
  const role = el("run-role").value;
  const fileSelect = el("run-file");
  if (!role) {
    fileSelect.innerHTML = "";
    return;
  }
  const { files } = await api(`/api/projects/${encodeURIComponent(state.project)}/roles/${encodeURIComponent(role)}/files`);
  fileSelect.innerHTML = files.map((f) => `<option value="${f}">${f}</option>`).join("");
}

el("run-scope").addEventListener("change", () => {
  const scope = el("run-scope").value;
  el("run-role-row").classList.toggle("hidden", scope === "all");
  el("run-file-row").classList.toggle("hidden", scope !== "file");
  if (scope !== "file") hideSourcePanel();
});

el("run-role").addEventListener("change", loadFileOptions);

// ---- Source viewer ----

function hideSourcePanel() {
  el("source-panel").classList.add("hidden");
}

el("view-source-btn").addEventListener("click", async () => {
  const role = el("run-role").value;
  const file = el("run-file").value;
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
});

el("source-close").addEventListener("click", hideSourcePanel);

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
        return `
          <div class="history-row">
            <span class="history-status ${statusClass}"></span>
            <span class="history-label">${kind} ${escapeHtml(h.label || h.role || "")}</span>
            <span class="history-time">${relativeTime(h.finishedAt || h.startedAt)}</span>
          </div>
        `;
      })
      .join("");
  } catch (err) {
    listEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
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

el("run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  requestNotificationPermission();
  const scope = el("run-scope").value;
  const role = el("run-role").value;
  const file = el("run-file").value;
  const label = scope === "file" ? file : scope === "role" ? `role "${role}"` : "all tests";
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  setJobRunning(true, "Running tests…");
  const logEl = resetLog();
  logEl.textContent = "Starting test run…\n";
  try {
    const { jobId } = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ project: state.project, scope, role, file }),
    });
    streamJob(jobId, logEl, label, async () => {
      button.disabled = false;
      await loadRunOptions();
    });
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    button.disabled = false;
    setJobRunning(false);
  }
});

el("record-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  requestNotificationPermission();
  const role = el("record-role").value;
  const flowName = el("record-flow-name").value.trim();
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

if (window.location.port) el("side-port").textContent = window.location.port;

showProjectsView();
