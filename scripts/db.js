/**
 * Direct Postgres connection to the Mendix app's own database — separate
 * from BASE_URL/role credentials, which only ever go through the app's
 * normal HTTP login. Mendix (9.x onward, including this project's 10.24.2)
 * requires PostgreSQL even for a local Studio Pro dev runtime, so that's
 * the one engine this connects as — see scripts/reset-mendix-sessions.js
 * for what this is actually used for.
 *
 * Reads MENDIX_DB_HOST/PORT/NAME/USER/PASSWORD from the active project's
 * env (loadProjectEnv() from project.js must already have run — this
 * module doesn't load env itself, same convention as every other script
 * here that expects its caller to have called loadProjectEnv() first).
 */
import pg from "pg";

export function dbConfigFromEnv() {
  const host = process.env.MENDIX_DB_HOST;
  const port = process.env.MENDIX_DB_PORT;
  const database = process.env.MENDIX_DB_NAME;
  const user = process.env.MENDIX_DB_USER;
  const password = process.env.MENDIX_DB_PASSWORD;
  const missing = ["MENDIX_DB_HOST", "MENDIX_DB_NAME", "MENDIX_DB_USER", "MENDIX_DB_PASSWORD"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    throw new Error(
      `Missing DB connection var(s): ${missing.join(", ")} — fill them in for the active environment first (Settings tab, or the project's .env directly).`
    );
  }
  return { host, port: Number(port) || 5432, database, user, password };
}

/** Connects, runs `fn(client)`, always disconnects afterward (even on
 * error) — every caller here follows this instead of managing a raw
 * pg.Client lifecycle itself. */
export async function withDbClient(fn) {
  const client = new pg.Client(dbConfigFromEnv());
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Couldn't connect to the database (${err.message}). Check MENDIX_DB_HOST/PORT/NAME/USER/PASSWORD for the active environment — ` +
        `for a local Studio Pro run, the actual host/port are in Studio Pro's App Settings > Configurations > (active config) > Database.`
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
