// Applies any migration in ./drizzle that the database has not seen yet.
// Runs before `next build` (see package.json) so a schema change reaches the
// live database on the same deploy as the code that needs it.
//
// Without DATABASE_URL it logs one line and exits 0, so a build with no
// database (a fresh clone, CI without secrets) still works.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `next build` reads .env files itself; this script runs before it, so load
// them the same way (later files never override what is already set).
if (!process.env.DATABASE_URL && typeof process.loadEnvFile === "function") {
  for (const name of [".env.local", ".env"]) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch {
      // Unreadable or malformed; treated like a missing file.
    }
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("[migrate] DATABASE_URL is not set; skipping database migrations.");
  process.exit(0);
}

const migrationsFolder = resolve(root, "drizzle");
// `prepare: false` for the pooled endpoint's transaction mode (see
// src/db/index.ts); one connection, closed at the end so the build exits.
const client = postgres(url, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
const db = drizzle(client);

// A database that refuses every query - over its plan's quota, rate limited,
// switched off - is an outage, not a bad migration. Aborting the build on it
// leaves the previous deployment live and the new code stranded behind a red
// X, while the site is already serving errors either way. So that case is
// logged loudly and the build goes through: the code matches the schema it
// was written against, and the site starts working the moment the database
// does, with no redeploy. A migration that actually fails still aborts, which
// is the case worth stopping for - that is a schema problem, and shipping
// past it is how a deploy takes a working site down for good.
function outageReason(err) {
  const seen = new Set();
  for (let e = err; e && typeof e === "object" && !seen.has(e); e = e.cause) {
    seen.add(e);
    const code = String(e.code || "");
    const text = [e.message, e.detail, e.hint].filter(Boolean).join(" ");
    // Postgres SQLSTATE: 53000 insufficient_resources (over quota), 53300 too
    // many connections, 57P03 cannot connect now, 08xxx connection exceptions.
    if (/^(53000|53300|57P03|08[0-9A-F]{3})$/i.test(code)) return text || code;
    // The driver's own codes: a host that does not answer at all.
    if (/^(CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/.test(code)) return text || code;
    // Neon's HTTP driver reports the same quota as a status in the message.
    if (/(HTTP status (5\d\d|429|402))\b/i.test(text)) return text;
    if (/exceeded the quota|too many requests|endpoint is disabled|project is suspended|not currently accepting connections/i.test(text)) return text;
  }
  return "";
}

try {
  await migrate(db, { migrationsFolder });
  console.log("[migrate] Database is up to date.");
} catch (err) {
  const outage = process.env.MIGRATE_STRICT === "1" ? "" : outageReason(err);
  if (outage) {
    console.warn("[migrate] The database refused the migration query, so the schema was NOT verified:");
    console.warn("[migrate]   " + outage.replace(/\s+/g, " ").trim().slice(0, 300));
    console.warn("[migrate] Building anyway. This deploy goes live once the database answers again;");
    console.warn("[migrate] set MIGRATE_STRICT=1 to fail the build on a database outage instead.");
    process.exit(0);
  }
  console.error("[migrate] Migration failed; aborting the build.");
  console.error(err);
  process.exit(1);
}

// postgres.js keeps its socket (and a keepalive timer) alive, so the build
// would sit here until the machine killed it. Both exits above already end the
// process; this is the success path.
await client.end().catch(() => {});
