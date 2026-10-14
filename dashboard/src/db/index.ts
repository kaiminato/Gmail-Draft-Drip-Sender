import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Db = NeonHttpDatabase<typeof schema>;

let instance: Db | null = null;

// Created on first use, not at import, so `next build` does not need a
// DATABASE_URL and a missing one fails the request that needed it instead.
function get(): Db {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Neon's HTTP driver: one fetch per query, no connection to keep alive,
  // which is what a Vercel function wants.
  instance = drizzle(neon(url), { schema });
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
