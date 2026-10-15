// Applies any migration in ./drizzle that the database has not seen yet.
// Runs before `next build` (see package.json) so a schema change reaches the
// live database on the same deploy as the code that needs it.
//
// Without DATABASE_URL it logs one line and exits 0, so a build with no
// database (a fresh clone, CI without secrets) still works.

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
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
const db = drizzle(neon(url));

try {
  await migrate(db, { migrationsFolder });
  console.log("[migrate] Database is up to date.");
} catch (err) {
  console.error("[migrate] Migration failed; aborting the build.");
  console.error(err);
  process.exit(1);
}
