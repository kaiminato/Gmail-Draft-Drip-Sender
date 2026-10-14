import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

const scrypt = promisify(scryptCb);

/* ---------- Google allow-list ---------- */

// Always allowed. Extra seats are added from the Settings page and live in
// the admin_emails table; ADMIN_EMAIL (env) is honoured too.
export const BUILTIN_ADMIN_EMAILS = [
  "minatodevstar@gmail.com",
  "topdev0335@gmail.com",
  "reddev0110@gmail.com",
  "rainbow224565@gmail.com",
];

export const norm = (e: string | null | undefined) => (e || "").trim().toLowerCase();

export function isBuiltinAdmin(email: string | null | undefined): boolean {
  const e = norm(email);
  if (!e) return false;
  if (BUILTIN_ADMIN_EMAILS.includes(e)) return true;
  const env = norm(process.env.ADMIN_EMAIL);
  return !!env && e === env;
}

export async function extraAdminEmails(): Promise<{ email: string; addedBy: string | null; createdAt: Date }[]> {
  return db.select().from(schema.adminEmails).orderBy(schema.adminEmails.createdAt);
}

export async function isAllowedGoogleEmail(email: string | null | undefined): Promise<boolean> {
  const e = norm(email);
  if (!e) return false;
  if (isBuiltinAdmin(e)) return true;
  const [row] = await db.select().from(schema.adminEmails).where(eq(schema.adminEmails.email, e)).limit(1);
  return !!row;
}

export async function addAdminEmail(email: string, addedBy: string | null) {
  const e = norm(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
  await db.insert(schema.adminEmails).values({ email: e, addedBy }).onConflictDoNothing();
}

export async function removeAdminEmail(email: string) {
  await db.delete(schema.adminEmails).where(eq(schema.adminEmails.email, norm(email)));
}

/* ---------- password ---------- */

// The password that works until an admin sets a different one. Change it from
// the Settings page right after the first deploy.
export const DEFAULT_ADMIN_PASSWORD = "qwe123QWE!@#";
const PASSWORD_KEY = "admin_password_hash";

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scrypt(password, salt, 64)) as Buffer;
  return "scrypt$" + salt + "$" + buf.toString("hex");
}

async function verifyHash(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hex] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hex) return false;
  const want = Buffer.from(hex, "hex");
  const got = (await scrypt(password, salt, want.length)) as Buffer;
  return got.length === want.length && timingSafeEqual(got, want);
}

async function storedPasswordHash(): Promise<string | null> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, PASSWORD_KEY)).limit(1);
  return row?.value ?? null;
}

// True while no password has ever been set, i.e. the default still works.
export async function passwordIsDefault(): Promise<boolean> {
  return (await storedPasswordHash()) === null;
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (typeof password !== "string" || !password) return false;
  const stored = await storedPasswordHash();
  if (stored === null) {
    // Constant-time compare against the default, same as a real hash check.
    const a = Buffer.from(password);
    const b = Buffer.from(DEFAULT_ADMIN_PASSWORD);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return verifyHash(password, stored);
}

export async function setAdminPassword(password: string) {
  const value = await hashPassword(password);
  await db
    .insert(schema.settings)
    .values({ key: PASSWORD_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password.length > 200) return "That is too long.";
  if (password === DEFAULT_ADMIN_PASSWORD) return "Choose something other than the temporary password.";
  return null;
}
