/**
 * Locked auth multi-empresa contract — login auto-select, active-empresa switch, me memberships.
 * Hermetic: node:sqlite + Hono app.request via createAuthApp(db).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/worker/auth/password.ts";
import { createAuthApp } from "../src/worker/routes/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const SESSION_COOKIE_NAME = "gestao_session";
const LOGIN_PATH = "/api/auth/login";
const ME_PATH = "/api/auth/me";
const ACTIVE_EMPRESA_PATH = "/api/auth/active-empresa";

/**
 * @description Open in-memory SQLite, enable FKs, apply every migrations/*.sql sorted by filename.
 * @returns {DatabaseSync}
 */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
    db.exec(sql);
  }
  return db;
}

/**
 * @description Seed a role=user with known password via hashPassword.
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string, password?: string }} [opts]
 */
async function seedUser(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const email = opts.email ?? "user@example.com";
  const name = opts.name ?? "Regular User";
  const password = opts.password ?? "secure-pass-ok";
  assert.ok(password.length >= 8);

  const { hash, salt } = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, hash, salt);

  return { id, email, name, password, role: "user" };
}

/**
 * @description Seed an empresa row (active — deleted_at NULL).
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Empresa Seed";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  return { id, nome };
}

/**
 * @description Seed empresa_membros link.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, userId: string, papel?: string, id?: string }} opts
 */
function seedMembership(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const papel = opts.papel ?? "admin";
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, ?)`,
  ).run(id, opts.empresaId, opts.userId, papel);
  return { id, papel };
}

/**
 * @description Soft-delete empresa via deleted_at = datetime('now').
 * @param {DatabaseSync} db
 * @param {string} empresaId
 */
function softDeleteEmpresa(db, empresaId) {
  db.prepare(
    `UPDATE empresas SET deleted_at = datetime('now') WHERE id = ?`,
  ).run(empresaId);
}

/**
 * @description Extract first Set-Cookie header value (string or array).
 * @param {Headers} headers
 * @returns {string | null}
 */
function getSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") {
    const list = headers.getSetCookie();
    if (Array.isArray(list) && list.length > 0) {
      const match = list.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      return match ?? list[0] ?? null;
    }
  }
  const raw = headers.get("set-cookie");
  return raw;
}

/**
 * @description Parse gestao_session raw token from a Set-Cookie header string.
 * @param {string} setCookie
 * @returns {string | null}
 */
function parseSessionToken(setCookie) {
  if (!setCookie) return null;
  const part = setCookie.split(";")[0] ?? "";
  const eq = part.indexOf("=");
  if (eq < 0) return null;
  const name = part.slice(0, eq).trim();
  if (name !== SESSION_COOKIE_NAME) return null;
  return part.slice(eq + 1);
}

/**
 * @description Build Cookie request header from a Set-Cookie response header.
 * @param {string} setCookie
 */
function cookieHeaderFromSetCookie(setCookie) {
  const token = parseSessionToken(setCookie);
  assert.ok(token != null && token.length > 0, "Set-Cookie must carry gestao_session token");
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/**
 * @description SHA-256 hex of raw session token (matches session token_hash storage).
 * @param {string} rawToken
 */
function sha256Hex(rawToken) {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * @description Read sessions.active_empresa_id for a raw token.
 * @param {DatabaseSync} db
 * @param {string} rawToken
 */
function sessionActiveEmpresaId(db, rawToken) {
  const row = db
    .prepare(`SELECT active_empresa_id FROM sessions WHERE token_hash = ?`)
    .get(sha256Hex(rawToken));
  return row ? row.active_empresa_id : undefined;
}

/**
 * @description POST JSON helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 */
async function postJson(app, path, body, extraHeaders = {}) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/**
 * @description Index memberships by empresa_id for stable assertions.
 * @param {unknown} memberships
 * @returns {Map<string, { empresa_id: string, nome: string, papel: string }>}
 */
function membershipsByEmpresaId(memberships) {
  assert.ok(Array.isArray(memberships), "memberships must be an array");
  /** @type {Map<string, { empresa_id: string, nome: string, papel: string }>} */
  const map = new Map();
  for (const m of memberships) {
    assert.ok(m && typeof m === "object", "membership entry is object");
    assert.equal(typeof m.empresa_id, "string");
    assert.equal(typeof m.nome, "string");
    assert.equal(typeof m.papel, "string");
    map.set(m.empresa_id, {
      empresa_id: m.empresa_id,
      nome: m.nome,
      papel: m.papel,
    });
  }
  return map;
}

// ─── lt-login-multi-empresa-needs-select ───────────────────────────────────

/**
 * @description Login with two non-deleted memberships leaves active_empresa_id null and returns both memberships.
 */
test("lt-login-multi-empresa-needs-select: two empresas → active null, memberships length 2, session NULL", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    email: "multi@example.com",
    password: "secure-pass-ok",
  });
  const empA = seedEmpresa(db, { id: "emp-a-multi", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-b-multi", nome: "Empresa B" });
  seedMembership(db, { empresaId: empA.id, userId: user.id, papel: "admin" });
  seedMembership(db, { empresaId: empB.id, userId: user.id, papel: "membro" });

  const app = createAuthApp(db);
  const loginRes = await postJson(app, LOGIN_PATH, {
    email: user.email,
    password: user.password,
  });

  assert.equal(loginRes.status, 200, "login succeeds");
  const body = await loginRes.json();
  assert.equal(body.active_empresa_id, null, "active_empresa_id is null with multiple memberships");
  assert.ok(Array.isArray(body.memberships), "memberships is array");
  assert.equal(body.memberships.length, 2, "memberships length === 2");

  const byId = membershipsByEmpresaId(body.memberships);
  assert.ok(byId.has(empA.id), "memberships includes A");
  assert.ok(byId.has(empB.id), "memberships includes B");
  assert.equal(byId.get(empA.id).empresa_id, empA.id);
  assert.equal(byId.get(empA.id).nome, empA.nome);
  assert.equal(byId.get(empA.id).papel, "admin");
  assert.equal(byId.get(empB.id).empresa_id, empB.id);
  assert.equal(byId.get(empB.id).nome, empB.nome);
  assert.equal(byId.get(empB.id).papel, "membro");

  const setCookie = getSetCookie(loginRes.headers);
  const rawToken = parseSessionToken(setCookie);
  assert.ok(rawToken, "session token present");
  const activeInDb = sessionActiveEmpresaId(db, rawToken);
  assert.equal(activeInDb, null, "sessions.active_empresa_id IS NULL");

  db.close();
});

// ─── lt-login-single-empresa-auto-select ───────────────────────────────────

/**
 * @description Login with exactly one non-deleted membership auto-selects that empresa as active.
 */
test("lt-login-single-empresa-auto-select: one membership → active_empresa_id === A.id in body and session", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    email: "single@example.com",
    password: "secure-pass-ok",
  });
  const empA = seedEmpresa(db, { id: "emp-a-single", nome: "Empresa Unica" });
  seedMembership(db, { empresaId: empA.id, userId: user.id, papel: "admin" });

  const app = createAuthApp(db);
  const loginRes = await postJson(app, LOGIN_PATH, {
    email: user.email,
    password: user.password,
  });

  assert.equal(loginRes.status, 200, "login succeeds");
  const body = await loginRes.json();
  assert.equal(body.active_empresa_id, empA.id, "body active_empresa_id === A.id");

  const setCookie = getSetCookie(loginRes.headers);
  const rawToken = parseSessionToken(setCookie);
  assert.ok(rawToken, "session token present");
  const activeInDb = sessionActiveEmpresaId(db, rawToken);
  assert.equal(activeInDb, empA.id, "sessions.active_empresa_id === A.id");

  db.close();
});

// ─── lt-switch-active-empresa ──────────────────────────────────────────────

/**
 * @description POST /api/auth/active-empresa switches among member empresas; non-member yields 403 Forbidden and leaves active unchanged.
 */
test("lt-switch-active-empresa: switch A then B → 200; non-member → 403 Forbidden, active unchanged", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    email: "switch@example.com",
    password: "secure-pass-ok",
  });
  const empA = seedEmpresa(db, { id: "emp-a-switch", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-b-switch", nome: "Empresa B" });
  const empOther = seedEmpresa(db, { id: "emp-other-switch", nome: "Outra" });
  seedMembership(db, { empresaId: empA.id, userId: user.id, papel: "admin" });
  seedMembership(db, { empresaId: empB.id, userId: user.id, papel: "membro" });

  const app = createAuthApp(db);
  const loginRes = await postJson(app, LOGIN_PATH, {
    email: user.email,
    password: user.password,
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.equal(loginBody.active_empresa_id, null, "multi-empresa login starts with null active");

  const setCookie = getSetCookie(loginRes.headers);
  const cookieHeader = cookieHeaderFromSetCookie(setCookie);
  const rawToken = parseSessionToken(setCookie);
  assert.ok(rawToken);

  const switchA = await postJson(
    app,
    ACTIVE_EMPRESA_PATH,
    { empresa_id: empA.id },
    { Cookie: cookieHeader },
  );
  assert.equal(switchA.status, 200, "switch to A → 200");
  const bodyA = await switchA.json();
  assert.equal(bodyA.active_empresa_id, empA.id);
  assert.equal(sessionActiveEmpresaId(db, rawToken), empA.id);

  const switchB = await postJson(
    app,
    ACTIVE_EMPRESA_PATH,
    { empresa_id: empB.id },
    { Cookie: cookieHeader },
  );
  assert.equal(switchB.status, 200, "switch to B → 200");
  const bodyB = await switchB.json();
  assert.equal(bodyB.active_empresa_id, empB.id);
  assert.equal(sessionActiveEmpresaId(db, rawToken), empB.id);

  const beforeForbidden = sessionActiveEmpresaId(db, rawToken);
  const switchOther = await postJson(
    app,
    ACTIVE_EMPRESA_PATH,
    { empresa_id: empOther.id },
    { Cookie: cookieHeader },
  );
  assert.equal(switchOther.status, 403, "non-member → 403");
  const forbiddenBody = await switchOther.json();
  assert.deepEqual(forbiddenBody, { error: "Forbidden" });
  assert.equal(
    sessionActiveEmpresaId(db, rawToken),
    beforeForbidden,
    "active unchanged after non-member attempt",
  );
  assert.equal(sessionActiveEmpresaId(db, rawToken), empB.id);

  db.close();
});

// ─── lt-deleted-empresa-not-in-memberships ─────────────────────────────────

/**
 * @description Soft-deleted empresa is excluded from login memberships and cannot be activated (403).
 */
test("lt-deleted-empresa-not-in-memberships: soft-deleted D excluded from memberships; activate D → 403, session not D", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    email: "deleted@example.com",
    password: "secure-pass-ok",
  });
  const empA = seedEmpresa(db, { id: "emp-a-del", nome: "Empresa Ativa" });
  const empD = seedEmpresa(db, { id: "emp-d-del", nome: "Empresa Deletada" });
  seedMembership(db, { empresaId: empA.id, userId: user.id, papel: "admin" });
  seedMembership(db, { empresaId: empD.id, userId: user.id, papel: "membro" });
  softDeleteEmpresa(db, empD.id);

  const app = createAuthApp(db);
  const loginRes = await postJson(app, LOGIN_PATH, {
    email: user.email,
    password: user.password,
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.ok(Array.isArray(loginBody.memberships), "memberships is array");
  assert.equal(loginBody.memberships.length, 1, "only non-deleted membership");
  const byId = membershipsByEmpresaId(loginBody.memberships);
  assert.ok(byId.has(empA.id), "memberships contains A");
  assert.equal(byId.has(empD.id), false, "memberships does not contain D");

  // Single non-deleted membership → auto-select A (or null if implementation differs before task; assert not D either way).
  const setCookie = getSetCookie(loginRes.headers);
  const cookieHeader = cookieHeaderFromSetCookie(setCookie);
  const rawToken = parseSessionToken(setCookie);
  assert.ok(rawToken);
  assert.notEqual(
    sessionActiveEmpresaId(db, rawToken),
    empD.id,
    "session active is not deleted empresa after login",
  );

  const activateD = await postJson(
    app,
    ACTIVE_EMPRESA_PATH,
    { empresa_id: empD.id },
    { Cookie: cookieHeader },
  );
  assert.equal(activateD.status, 403, "activate soft-deleted → 403");
  assert.notEqual(
    sessionActiveEmpresaId(db, rawToken),
    empD.id,
    "sessions.active_empresa_id remains not D",
  );

  db.close();
});

// ─── lt-me-memberships-papel-admin-membro ──────────────────────────────────

/**
 * @description GET /me returns memberships with papel admin|membro only, includes active_empresa_id, omits password fields.
 */
test("lt-me-memberships-papel-admin-membro: /me papéis admin|membro, has active_empresa_id, no password fields", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    email: "me-papel@example.com",
    password: "secure-pass-ok",
  });
  const empA = seedEmpresa(db, { id: "emp-a-me", nome: "Empresa Admin" });
  const empB = seedEmpresa(db, { id: "emp-b-me", nome: "Empresa Membro" });
  seedMembership(db, { empresaId: empA.id, userId: user.id, papel: "admin" });
  seedMembership(db, { empresaId: empB.id, userId: user.id, papel: "membro" });

  const app = createAuthApp(db);
  const loginRes = await postJson(app, LOGIN_PATH, {
    email: user.email,
    password: user.password,
  });
  assert.equal(loginRes.status, 200);
  const setCookie = getSetCookie(loginRes.headers);
  const cookieHeader = cookieHeaderFromSetCookie(setCookie);

  const meRes = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookieHeader },
  });
  assert.equal(meRes.status, 200, "/me authenticated");
  const me = await meRes.json();

  assert.ok("active_empresa_id" in me, "body includes active_empresa_id");
  assert.ok(Array.isArray(me.memberships), "memberships is array");
  assert.equal(me.memberships.length, 2);

  const byId = membershipsByEmpresaId(me.memberships);
  assert.equal(byId.get(empA.id).papel, "admin");
  assert.equal(byId.get(empB.id).papel, "membro");
  for (const m of me.memberships) {
    assert.ok(
      m.papel === "admin" || m.papel === "membro",
      `papel must be admin|membro, got ${m.papel}`,
    );
  }

  assert.equal("password" in me, false, "no password in /me");
  assert.equal("password_hash" in me, false, "no password_hash in /me");
  assert.equal("password_salt" in me, false, "no password_salt in /me");

  db.close();
});
