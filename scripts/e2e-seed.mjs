/**
 * @description Seed e2e users via live local API (same D1 as Vite Cloudflare plugin).
 * Requires `npm run dev` already up and SUPER_ADMIN_* in .dev.vars.
 *
 * Password for all e2e users: password-e2e-ok
 * - admin@e2e.local  — admin Casa Alpha only
 * - membro@e2e.local — membro Casa Alpha only
 * - multi@e2e.local  — admin Casa Alpha + membro Casa Beta
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const PASSWORD = "password-e2e-ok";

/**
 * @description Parse KEY=value from .dev.vars (no export).
 * @param {string} key
 */
function readDevVar(key) {
  const raw = readFileSync(resolve(process.cwd(), ".dev.vars"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    if (t.slice(0, i) === key) return t.slice(i + 1).trim();
  }
  return "";
}

/**
 * @param {string} path
 * @param {RequestInit & { cookie?: string }} [init]
 */
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.cookie) headers.set("Cookie", init.cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookieHeader =
    setCookie
      .map((c) => c.split(";")[0])
      .filter(Boolean)
      .join("; ") || init.cookie;
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { res, json, cookie: cookieHeader ?? "" };
}

/**
 * @param {string} email
 * @param {string} password
 */
async function login(email, password) {
  const { res, json, cookie } = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return { cookie, body: json };
}

/**
 * @param {string} cookie
 * @param {{ nome: string, adminEmail: string, adminName: string, adminPassword: string }} opts
 */
async function createEmpresa(cookie, opts) {
  const { res, json } = await api("/api/platform/empresas", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      nome: opts.nome,
      admin: {
        name: opts.adminName,
        email: opts.adminEmail,
        password: opts.adminPassword,
      },
    }),
  });
  // 201 created; 409 if already exists from prior run — treat as ok for idempotency
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `create empresa ${opts.nome}: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/**
 * @param {string} cookie
 * @param {{ email: string, name: string, password: string, papel: string }} opts
 */
async function inviteMembro(cookie, opts) {
  const { res, json } = await api("/api/empresa/membros", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      email: opts.email,
      name: opts.name,
      password: opts.password,
      papel: opts.papel,
    }),
  });
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `invite ${opts.email}: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function main() {
  const saEmail = readDevVar("SUPER_ADMIN_EMAIL");
  const saPassword = readDevVar("SUPER_ADMIN_PASSWORD");
  if (!saEmail || !saPassword) {
    throw new Error("SUPER_ADMIN_EMAIL/PASSWORD missing in .dev.vars");
  }

  // Warm bootstrap (creates SA if needed)
  await api("/api/auth/me");

  const sa = await login(saEmail, saPassword);

  await createEmpresa(sa.cookie, {
    nome: "Casa Alpha",
    adminEmail: "admin@e2e.local",
    adminName: "Admin E2E",
    adminPassword: PASSWORD,
  });

  await createEmpresa(sa.cookie, {
    nome: "Casa Beta",
    adminEmail: "beta-admin@e2e.local",
    adminName: "Beta Admin E2E",
    adminPassword: PASSWORD,
  });

  // Alpha admin invites membro + multi as admin
  const alphaAdmin = await login("admin@e2e.local", PASSWORD);
  await inviteMembro(alphaAdmin.cookie, {
    email: "membro@e2e.local",
    name: "Membro E2E",
    password: PASSWORD,
    papel: "membro",
  });
  await inviteMembro(alphaAdmin.cookie, {
    email: "multi@e2e.local",
    name: "Multi E2E",
    password: PASSWORD,
    papel: "admin",
  });

  // Beta admin invites multi as membro (second house)
  const betaAdmin = await login("beta-admin@e2e.local", PASSWORD);
  await inviteMembro(betaAdmin.cookie, {
    email: "multi@e2e.local",
    name: "Multi E2E",
    password: PASSWORD,
    papel: "membro",
  });

  // Verify multi has 2 memberships and null or set active
  const multi = await login("multi@e2e.local", PASSWORD);
  const memberships = multi.body?.memberships ?? [];
  if (memberships.length < 2) {
    throw new Error(
      `multi expected ≥2 memberships, got ${JSON.stringify(multi.body)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        base: BASE,
        password: PASSWORD,
        users: {
          admin: "admin@e2e.local",
          membro: "membro@e2e.local",
          multi: "multi@e2e.local",
        },
        multiMemberships: memberships.map((m) => ({
          nome: m.nome,
          papel: m.papel,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
