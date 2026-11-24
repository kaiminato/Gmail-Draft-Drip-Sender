import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = PostgresJsDatabase<typeof schema>;

let instance: Db | null = null;

// Created on first use, not at import, so `next build` does not need a
// DATABASE_URL and a missing one fails the request that needed it instead.
function get(): Db {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // postgres.js over TCP, with a pool small enough that a burst of function
  // instances cannot exhaust the host's connection limit. `prepare: false` is
  // what the pooled endpoint (pgbouncer, port 6543) needs: it runs in
  // transaction mode, so a statement prepared on one client would not exist on
  // whichever server connection the next query lands on.
  const client = postgres(url, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });
  instance = drizzle(client, { schema });
  return instance;
}

export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = get() as unknown as Record<PropertyKey, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export { schema };
