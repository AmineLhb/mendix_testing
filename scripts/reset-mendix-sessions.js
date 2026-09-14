#!/usr/bin/env node
/**
 * Works around this project's recurring, real seat-limit problem (see
 * README's "Known issue" section, and pages/BasePage.js's expectApiSuccess
 * 402-handling) a different way than the app-level mitigations already in
 * place (workers: 1, retries: 1, an explicit logout() at the end of every
 * generated test): instead of hoping every session ends cleanly on its
 * own, connect DIRECTLY to the Mendix app's database and clear stuck
 * sessions there, so a role can be tested again without waiting for a
 * stale session to time out (or restarting the whole app in Studio Pro).
 *
 * Grounded the same way this whole project insists on for anything else
 * that could silently do the wrong thing: this does NOT hardcode a guess
 * at the exact schema and run a DELETE blind. Verified live 2026-09-11
 * against a real migrated database: `system$session` (Mendix's standard
 * table for the built-in System.Session entity) has NO direct column
 * linking it to `system$user` — that link goes through a separate
 * `system$session_user` junction table instead (standard Mendix
 * many-to-many convention). An earlier version of this script assumed a
 * direct `userid` column, which was wrong but safe: it refused to guess
 * and errored out clearly rather than silently doing nothing or deleting
 * the wrong rows.
 *
 *   - Default action is `list` — READ-ONLY. Reports the current session
 *     count and whether `--role` is usable here. Nothing is ever deleted
 *     by this mode. Add `--describe` for the full column-level detail
 *     (kept off by default — noisy for everyday use, useful the first
 *     time you point this at a new database).
 *   - `--all` deletes every row in system$session (frees every seat —
 *     safe for a local/trial dev database with no other real users on it,
 *     which is exactly the case this exists for; NOT something to run
 *     against a shared or production database).
 *   - `--role <role>` deletes only that role's own session row(s), found
 *     by matching its configured username against system$user then
 *     joining through system$session_user. Refuses to guess and reports
 *     what it found instead if the schema doesn't match expectations.
 *   - Either delete mode prompts for confirmation unless --yes is given
 *     (same pattern as record-and-enrich.js's overwrite confirmation).
 *
 * Usage:
 *   node scripts/reset-mendix-sessions.js [--describe] [--project <name>] [--environment <env>]
 *   node scripts/reset-mendix-sessions.js --all [--yes] [--project <name>] [--environment <env>]
 *   node scripts/reset-mendix-sessions.js --role <role> [--yes] [--project <name>] [--environment <env>]
 */
import readline from "node:readline/promises";
import { loadProjectEnv, projectExists, projectPaths } from "./project.js";
import { resolveRole, isValidRoleName } from "./roles.js";
import { withDbClient } from "./db.js";

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf("--project");
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);
const envIdx = argv.indexOf("--environment");
const environment = envIdx > -1 ? argv[envIdx + 1] : undefined;
if (envIdx > -1) argv.splice(envIdx, 2);
const yesIdx = argv.indexOf("--yes");
const skipConfirm = yesIdx > -1;
if (yesIdx > -1) argv.splice(yesIdx, 1);
const allIdx = argv.indexOf("--all");
const resetAll = allIdx > -1;
if (allIdx > -1) argv.splice(allIdx, 1);
const roleIdx = argv.indexOf("--role");
const role = roleIdx > -1 ? argv[roleIdx + 1] : undefined;
if (roleIdx > -1) argv.splice(roleIdx, 2);
const describeIdx = argv.indexOf("--describe");
const describe = describeIdx > -1;
if (describeIdx > -1) argv.splice(describeIdx, 1);

if (resetAll && role) {
  console.error("--all and --role are mutually exclusive — pick one.");
  process.exit(1);
}
if (role && !isValidRoleName(role)) {
  console.error(`Invalid role name "${role}".`);
  process.exit(1);
}

if (!projectExists(projectName)) {
  const paths = projectPaths(projectName);
  console.error(`Project "${paths.name}" doesn't exist (looked for ${paths.root}).`);
  process.exit(1);
}
await loadProjectEnv(projectName, environment);
const paths = projectPaths(projectName);

async function confirm(message) {
  if (skipConfirm) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message} (y/N) `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

const SESSION_TABLE = "system$session";
const USER_TABLE = "system$user";
// Verified live 2026-09-11: system$session has NO direct column linking it
// to system$user (an earlier version of this script guessed "userid" and
// was wrong) — the real link is this separate junction table, standard
// Mendix convention for a many-to-many association
// (System.Session_System.User under the hood).
const SESSION_USER_TABLE = "system$session_user";

async function tableExists(client, tableName) {
  const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${tableName}`]);
  return rows[0]?.exists === true;
}

async function listMode(client) {
  const sessionExists = await tableExists(client, SESSION_TABLE);
  if (!sessionExists) {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%session%' ORDER BY table_name`
    );
    console.log(`No table literally named "${SESSION_TABLE}" found — that's Mendix's standard name for the built-in System.Session entity, but hasn't been verified against THIS database.`);
    if (rows.length) {
      console.log(`Tables that do exist with "session" in the name: ${rows.map((r) => r.table_name).join(", ")}`);
      console.log("If one of those is the right one, this script needs updating to use it — nothing guessed or run automatically.");
    } else {
      console.log("No table with \"session\" in the name found at all — double check MENDIX_DB_HOST/PORT/NAME point at the right database.");
    }
    return;
  }

  const { rows: countRows } = await client.query(`SELECT COUNT(*) AS count FROM "${SESSION_TABLE}"`);
  console.log(`${countRows[0].count} session(s) currently active.`);

  // Only report whether --role would actually work here, not the raw
  // schema — the schema dump was useful while verifying this script
  // against a real database for the first time, not for everyday use.
  // See describeMode() below for the full column-level detail on demand.
  const roleCapable = (await tableExists(client, USER_TABLE)) && (await tableExists(client, SESSION_USER_TABLE));
  console.log(roleCapable ? "--role <role> is available." : "--role <role> isn't available here (--all still is) — run with --describe for details.");

  if (describe) await describeMode(client);

  console.log(`\nNothing was changed (list is read-only). Run again with --all or --role <role> to actually clear session(s).`);
}

/** The original, verbose column-level dump — only shown on request
 * (--describe), not by default: useful while first verifying this script
 * against a real database, noisy for everyday use. */
async function describeMode(client) {
  console.log(`\n--describe:`);
  const userExists = await tableExists(client, USER_TABLE);
  if (userExists) {
    const { rows: cols } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [USER_TABLE]
    );
    console.log(`"${USER_TABLE}" columns: ${cols.map((c) => `${c.column_name} (${c.data_type})`).join(", ")}`);
  } else {
    console.log(`No "${USER_TABLE}" table found.`);
  }
  const junctionExists = await tableExists(client, SESSION_USER_TABLE);
  if (junctionExists) {
    const { rows: cols } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [SESSION_USER_TABLE]
    );
    console.log(`"${SESSION_USER_TABLE}" columns: ${cols.map((c) => `${c.column_name} (${c.data_type})`).join(", ")}`);
  } else {
    console.log(`No "${SESSION_USER_TABLE}" table found.`);
  }
}

async function deleteAll(client) {
  if (!(await tableExists(client, SESSION_TABLE))) {
    console.error(`No "${SESSION_TABLE}" table found — run without flags first to see what tables actually exist.`);
    process.exit(1);
  }
  const { rows: countRows } = await client.query(`SELECT COUNT(*) AS count FROM "${SESSION_TABLE}"`);
  const count = Number(countRows[0].count);
  if (count === 0) {
    console.log("0 sessions — nothing to clear.");
    return;
  }
  if (!(await confirm(`This will delete all ${count} row(s) from "${SESSION_TABLE}" in ${paths.name}'s database, ending EVERY active session (including anyone else currently using this app). Continue?`))) {
    console.log("Aborted — nothing changed.");
    return;
  }
  const result = await client.query(`DELETE FROM "${SESSION_TABLE}"`);
  console.log(`Deleted ${result.rowCount} session row(s).`);
}

async function deleteForRole(client, roleName) {
  if (!(await tableExists(client, SESSION_TABLE)) || !(await tableExists(client, USER_TABLE)) || !(await tableExists(client, SESSION_USER_TABLE))) {
    console.error(`"${SESSION_TABLE}", "${USER_TABLE}", and/or "${SESSION_USER_TABLE}" not found — run with --describe to see what actually exists. Falling back to --all is the only reliable option without them.`);
    process.exit(1);
  }
  const { usernameVar } = resolveRole(roleName);
  const username = process.env[usernameVar];
  if (!username) {
    console.error(`${usernameVar} isn't set in ${paths.env} — can't look up which user session belongs to "${roleName}" without it.`);
    process.exit(1);
  }

  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('character varying', 'text')`,
    [USER_TABLE]
  );
  const nameCol = cols.find((c) => c.column_name.toLowerCase() === "name")?.column_name;
  if (!nameCol) {
    console.error(
      `Couldn't find a column literally named "name" on "${USER_TABLE}" to match "${username}" against (text columns found: ${cols.map((c) => c.column_name).join(", ") || "none"}). ` +
        `Not guessing which one holds the login name — use --all instead, or update this script once you know the right column.`
    );
    process.exit(1);
  }

  const { rows: userRows } = await client.query(`SELECT id FROM "${USER_TABLE}" WHERE "${nameCol}" = $1`, [username]);
  if (userRows.length === 0) {
    console.error(`No row in "${USER_TABLE}" has ${nameCol} = "${username}" — nothing to delete for role "${roleName}".`);
    process.exit(1);
  }
  if (userRows.length > 1) {
    console.error(`${userRows.length} rows in "${USER_TABLE}" match ${nameCol} = "${username}" — that's ambiguous, refusing to guess which one. Use --all instead.`);
    process.exit(1);
  }
  const userId = userRows[0].id;

  // system$session has NO direct column linking it to system$user (verified
  // live 2026-09-11 — an earlier version of this guessed "userid" and was
  // wrong) — the real link is the system$session_user junction table,
  // standard Mendix convention for a many-to-many association.
  const { rows: sessionRows } = await client.query(
    `SELECT s."id" FROM "${SESSION_TABLE}" s JOIN "${SESSION_USER_TABLE}" su ON su."system$sessionid" = s."id" WHERE su."system$userid" = $1`,
    [userId]
  );
  const count = sessionRows.length;
  if (count === 0) {
    console.log(`0 session(s) for "${roleName}" (${username}) — nothing to clear.`);
    return;
  }
  if (!(await confirm(`This will delete ${count} session row(s) for "${roleName}" (${username}) in ${paths.name}'s database. Continue?`))) {
    console.log("Aborted — nothing changed.");
    return;
  }
  const sessionIds = sessionRows.map((r) => r.id);
  const result = await client.query(`DELETE FROM "${SESSION_TABLE}" WHERE "id" = ANY($1::bigint[])`, [sessionIds]);
  console.log(`Deleted ${result.rowCount} session row(s) for "${roleName}" (${username}).`);
}

await withDbClient(async (client) => {
  if (resetAll) await deleteAll(client);
  else if (role) await deleteForRole(client, role);
  else await listMode(client);
}).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
