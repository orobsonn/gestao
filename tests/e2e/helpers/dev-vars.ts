/** @description Read gitignored .dev.vars for e2e (never log values). */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @description Parse KEY=value lines from project .dev.vars.
 */
export function readDevVars(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), ".dev.vars"), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  return out;
}

/**
 * @description Super-admin credentials from .dev.vars (required for platform e2e).
 */
export function superAdminCredentials(): { email: string; password: string } {
  const v = readDevVars();
  const email = v.SUPER_ADMIN_EMAIL ?? "";
  const password = v.SUPER_ADMIN_PASSWORD ?? "";
  if (!email || !password) {
    throw new Error("SUPER_ADMIN_EMAIL/PASSWORD missing in .dev.vars");
  }
  return { email, password };
}
