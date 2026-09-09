/**
 * Runs a shell command as a background "job" whose output can be streamed to
 * multiple SSE subscribers (see the /api/stream/:jobId route in server.js).
 * Buffers every line so a client that connects after the job already
 * produced output (or after it finished) still gets the full transcript.
 */
import { spawn, exec } from "node:child_process";
import { randomUUID } from "node:crypto";

const jobs = new Map();

export function startJob(command, args, options = {}) {
  const id = randomUUID();
  const job = { lines: [], done: false, exitCode: null, listeners: new Set() };
  jobs.set(id, job);

  const child = spawn(command, args, { shell: true, ...options });

  const onData = (chunk) => {
    const text = chunk.toString();
    job.lines.push(text);
    for (const listener of job.listeners) listener(text);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("exit", (code) => {
    job.done = true;
    job.exitCode = code;
    job.finishedAt = Date.now();
    for (const listener of job.listeners) listener(null);
  });
  child.on("error", (err) => {
    job.lines.push(`\n[job error] ${err.message}\n`);
    job.done = true;
    job.exitCode = -1;
    job.finishedAt = Date.now();
    for (const listener of job.listeners) listener(null);
  });

  job.child = child;
  return id;
}

export function getJob(id) {
  return jobs.get(id);
}

// child processes here are always started with { shell: true }, which on
// Windows means the spawned pid is actually cmd.exe wrapping the real
// command (npx/node) — a plain child.kill() only kills that wrapper and
// leaves the real process (and Playwright's own browser children) running.
// taskkill /T walks the whole process tree instead.
export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  if (process.platform === "win32") {
    exec(`taskkill /pid ${job.child.pid} /T /F`);
  } else {
    job.child.kill("SIGTERM");
  }
  return true;
}

// Jobs are kept in memory only — fine for a local dev tool; a server
// restart naturally drops any stale entries along with the child processes
// they'd otherwise reference.
export function pruneOldJobs(maxAgeMs = 30 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, job] of jobs) {
    if (job.done && (job.finishedAt ?? 0) < cutoff) jobs.delete(id);
  }
}
