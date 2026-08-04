/**
 * Locked empresa membros contract — list isolation, admin create/invite, guards.
 * Hermetic: node:sqlite + Hono app.request via createEmpresaApp(db) / createAuthApp(db).
 * Applies migrations/0001_init.sql (foreign_keys=ON).
 * Seeds active empresa via mintSession third arg / setActiveEmpresa (no auth auto-select).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/worker/auth/password.ts";
import {
  buildSessionCookie,
  mintSession,
  setActiveEmpresa,
} from "../src/worker/auth/session.ts";
import { createAuthApp } from "../src/worker/routes/auth.ts";
import { createEmpresaApp } from "../src/worker/routes/empresa.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(__dirname, "../migrations/0001_init.sql");

const SESSION_COOKIE_NAME = "gestao_session";
const MEMBROS_PATH = "/api/empresa/membros";
const LOGIN_PATH = "/api/auth/login";

/**
 * @description Open in-memory SQLite, enable FKs, apply 0001_init.sql.
 * @returns {DatabaseSync}
 */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  db.exec(sql);
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

  return { id, email, name, password, role: "user", hash, salt };
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
 * @description Mint session (optional active empresa) and return Cookie header + raw token.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {string | null} [activeEmpresaId]
 */
async function sessionFor(db, userId, activeEmpresaId = null) {
  const rawToken = await mintSession(db, userId, activeEmpresaId);
  const setCookie = buildSessionCookie(rawToken);
  const token = setCookie.split(";")[0]?.split("=").slice(1).join("=");
  assert.ok(token && token.length > 0, "minted session token");
  return {
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    rawToken,
  };
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
 * @description GET helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {Record<string, string>} [extraHeaders]
 */
async function getJson(app, path, extraHeaders = {}) {
  return app.request(path, {
    method: "GET",
    headers: { ...extraHeaders },
  });
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
 * @description Count rows in a table (optional WHERE).
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string} [whereSql]
 * @param {unknown[]} [params]
 */
function countRows(db, table, whereSql = "", params = []) {
  const sql = whereSql
    ? `SELECT COUNT(*) AS c FROM ${table} WHERE ${whereSql}`
    : `SELECT COUNT(*) AS c FROM ${table}`;
  const row = db.prepare(sql).get(...params);
  return Number(row.c);
}

/**
 * @description Read password_hash and password_salt for a user id.
 * @param {DatabaseSync} db
 * @param {string} userId
 */
function userPasswordMaterial(db, userId) {
  const row = db
    .prepare(`SELECT password_hash, password_salt FROM users WHERE id = ?`)
    .get(userId);
  assert.ok(row, "user row exists");
  return {
    password_hash: row.password_hash,
    password_salt: row.password_salt,
  };
}

/**
 * @description Collect ids and emails from membros list body for membership checks.
 * @param {unknown} body
 */
function membrosIdsAndEmails(body) {
  assert.ok(body && typeof body === "object", "body is object");
  assert.ok(Array.isArray(body.membros), "body.membros is array");
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {Set<string>} */
  const emails = new Set();
  for (const m of body.membros) {
    assert.ok(m && typeof m === "object", "membro entry is object");
    if (typeof m.id === "string") ids.add(m.id);
    if (typeof m.user_id === "string") ids.add(m.user_id);
    if (m.user && typeof m.user === "object") {
      if (typeof m.user.id === "string") ids.add(m.user.id);
      if (typeof m.user.email === "string") emails.add(m.user.email.toLowerCase());
    }
    if (typeof m.email === "string") emails.add(m.email.toLowerCase());
  }
  return { membros: body.membros, ids, emails };
}

// ─── lt-list-membros-isolates-tenant ───────────────────────────────────────

/**
 * @description GET /api/empresa/membros lists only members of the session active empresa (tenant isolation).
 */
test("lt-list-membros-isolates-tenant: active A excludes X; active B includes X and excludes A-only", async () => {
  const db = openDb();
  const actor = await seedUser(db, {
    email: "actor-list@example.com",
    name: "Actor List",
  });
  const onlyA = await seedUser(db, {
    email: "only-a@example.com",
    name: "Only A",
  });
  const userX = await seedUser(db, {
    email: "user-x@example.com",
    name: "User X",
  });
  const empA = seedEmpresa(db, { id: "emp-list-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-list-b", nome: "Empresa B" });

  seedMembership(db, { empresaId: empA.id, userId: actor.id, papel: "admin" });
  seedMembership(db, { empresaId: empB.id, userId: actor.id, papel: "admin" });
  seedMembership(db, { empresaId: empA.id, userId: onlyA.id, papel: "membro" });
  seedMembership(db, { empresaId: empB.id, userId: userX.id, papel: "membro" });

  const app = createEmpresaApp(db);
  const { cookie, rawToken } = await sessionFor(db, actor.id, empA.id);

  const resA = await getJson(app, MEMBROS_PATH, { Cookie: cookie });
  assert.equal(resA.status, 200, "list with active A returns 200");
  const listA = membrosIdsAndEmails(await resA.json());

  assert.ok(
    listA.ids.has(actor.id) || listA.emails.has(actor.email.toLowerCase()),
    "A list includes actor",
  );
  assert.ok(
    listA.ids.has(onlyA.id) || listA.emails.has(onlyA.email.toLowerCase()),
    "A list includes A-only user",
  );
  assert.equal(listA.ids.has(userX.id), false, "A list never includes X id");
  assert.equal(
    listA.emails.has(userX.email.toLowerCase()),
    false,
    "A list never includes X email",
  );

  await setActiveEmpresa(db, rawToken, empB.id);

  const resB = await getJson(app, MEMBROS_PATH, { Cookie: cookie });
  assert.equal(resB.status, 200, "list with active B returns 200");
  const listB = membrosIdsAndEmails(await resB.json());

  assert.ok(
    listB.ids.has(userX.id) || listB.emails.has(userX.email.toLowerCase()),
    "B list includes X",
  );
  assert.equal(listB.ids.has(onlyA.id), false, "B list excludes A-only id");
  assert.equal(
    listB.emails.has(onlyA.email.toLowerCase()),
    false,
    "B list excludes A-only email",
  );

  db.close();
});

// ─── lt-admin-creates-user-can-login ───────────────────────────────────────

/**
 * @description Admin POST /api/empresa/membros creates membro user; response has no password fields; login works.
 */
test("lt-admin-creates-user-can-login: admin POST → 201 {user,papel} no password; login 200 + gestao_session", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-create@example.com",
    name: "Admin Create",
  });
  const empA = seedEmpresa(db, { id: "emp-create-a", nome: "Empresa Create" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });

  const empresaApp = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const newEmail = "new-membro@example.com";
  const newPassword = "new-membro-pass-ok";
  const createBody = {
    name: "New Membro",
    email: newEmail,
    password: newPassword,
    papel: "membro",
  };
  assert.ok(createBody.password.length >= 8);

  const res = await postJson(empresaApp, MEMBROS_PATH, createBody, {
    Cookie: cookie,
  });
  assert.equal(res.status, 201, "create returns 201");
  const json = await res.json();

  assert.ok(json.user && typeof json.user === "object", "body.user");
  assert.equal(typeof json.user.id, "string");
  assert.ok(json.user.id.length > 0);
  assert.equal(json.user.email, newEmail);
  assert.equal(json.user.name, "New Membro");
  assert.equal(json.papel, "membro");

  assert.equal("password" in json, false);
  assert.equal("password" in json.user, false);
  assert.equal("password_hash" in json.user, false);
  assert.equal("password_salt" in json.user, false);
  const serialized = JSON.stringify(json);
  assert.equal(serialized.includes("password_hash"), false);
  assert.equal(serialized.includes("password_salt"), false);
  assert.equal(serialized.includes(newPassword), false);

  const authApp = createAuthApp(db);
  const loginRes = await postJson(authApp, LOGIN_PATH, {
    email: newEmail,
    password: newPassword,
  });
  assert.equal(loginRes.status, 200, "created user can login");
  const setCookie = getSetCookie(loginRes.headers);
  assert.ok(setCookie, "Set-Cookie present on login");
  assert.match(
    setCookie,
    new RegExp(`${SESSION_COOKIE_NAME}=`),
    "cookie named gestao_session",
  );

  db.close();
});

// ─── lt-admin-invite-existing-email-no-password-change ─────────────────────

/**
 * @description Admin invite of existing email adds membership only; password_hash/salt unchanged; old password still works.
 */
test("lt-admin-invite-existing-email-no-password-change: invite U → 201 membership; hash/salt unchanged; P0 ok P1 401", async () => {
  const db = openDb();
  const passwordP0 = "original-pass-ok";
  const passwordP1 = "hijack-pass-ok";
  assert.notEqual(passwordP0, passwordP1);

  const userU = await seedUser(db, {
    email: "invite-u@example.com",
    name: "User U",
    password: passwordP0,
  });
  const adminA = await seedUser(db, {
    email: "admin-invite@example.com",
    name: "Admin Invite",
  });
  const empA = seedEmpresa(db, { id: "emp-invite-a", nome: "Empresa A Invite" });
  const empB = seedEmpresa(db, { id: "emp-invite-b", nome: "Empresa B Invite" });

  seedMembership(db, { empresaId: empB.id, userId: userU.id, papel: "membro" });
  seedMembership(db, { empresaId: empA.id, userId: adminA.id, papel: "admin" });

  const before = userPasswordMaterial(db, userU.id);
  const beforeUsers = countRows(db, "users");
  const beforeMembershipsA = countRows(
    db,
    "empresa_membros",
    "empresa_id = ? AND user_id = ?",
    [empA.id, userU.id],
  );
  assert.equal(beforeMembershipsA, 0, "U not yet member of A");

  const empresaApp = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, adminA.id, empA.id);

  const res = await postJson(
    empresaApp,
    MEMBROS_PATH,
    {
      name: "Ignored Name",
      email: userU.email,
      password: passwordP1,
      papel: "membro",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 201, "invite existing email returns 201");

  const membershipA = db
    .prepare(
      `SELECT id, papel FROM empresa_membros WHERE empresa_id = ? AND user_id = ?`,
    )
    .get(empA.id, userU.id);
  assert.ok(membershipA, "membership on A created");
  assert.equal(membershipA.papel, "membro");

  assert.equal(countRows(db, "users"), beforeUsers, "no extra user row");

  const after = userPasswordMaterial(db, userU.id);
  assert.equal(
    after.password_hash,
    before.password_hash,
    "password_hash unchanged vs pre-invite",
  );
  assert.equal(
    after.password_salt,
    before.password_salt,
    "password_salt unchanged vs pre-invite",
  );

  const authApp = createAuthApp(db);
  const loginP0 = await postJson(authApp, LOGIN_PATH, {
    email: userU.email,
    password: passwordP0,
  });
  assert.equal(loginP0.status, 200, "login with P0 succeeds");

  const loginP1 = await postJson(authApp, LOGIN_PATH, {
    email: userU.email,
    password: passwordP1,
  });
  assert.equal(loginP1.status, 401, "login with P1 returns 401");

  db.close();
});

// ─── lt-membro-cannot-create-user ──────────────────────────────────────────

/**
 * @description Session with papel=membro cannot POST /api/empresa/membros (403 Forbidden; no new rows).
 */
test("lt-membro-cannot-create-user: papel=membro POST → 403 Forbidden; no users or membership for email", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-actor@example.com",
    name: "Membro Actor",
  });
  const emp = seedEmpresa(db, { id: "emp-membro-guard", nome: "Empresa Membro" });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });

  const targetEmail = "blocked-create@example.com";
  const beforeUsers = countRows(db, "users", "email = ? COLLATE NOCASE", [
    targetEmail,
  ]);
  const beforeMembros = countRows(
    db,
    "empresa_membros",
    `user_id IN (SELECT id FROM users WHERE email = ? COLLATE NOCASE)`,
    [targetEmail],
  );
  assert.equal(beforeUsers, 0);
  assert.equal(beforeMembros, 0);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const res = await postJson(
    app,
    MEMBROS_PATH,
    {
      name: "Should Fail",
      email: targetEmail,
      password: "secure-pass-ok",
      papel: "membro",
    },
    { Cookie: cookie },
  );

  assert.equal(res.status, 403, "membro create forbidden");
  assert.deepEqual(await res.json(), { error: "Forbidden" });

  assert.equal(
    countRows(db, "users", "email = ? COLLATE NOCASE", [targetEmail]),
    0,
    "no new users for that email",
  );
  assert.equal(
    countRows(
      db,
      "empresa_membros",
      `user_id IN (SELECT id FROM users WHERE email = ? COLLATE NOCASE)`,
      [targetEmail],
    ),
    0,
    "no empresa_membros rows for that email",
  );

  db.close();
});

// ─── lt-papel-only-admin-membro ────────────────────────────────────────────

/**
 * @description POST rejects papel outside admin|membro with 400; valid admin papel lists only admin|membro.
 */
test("lt-papel-only-admin-membro: super_admin → 400; valid admin then GET papéis only admin|membro", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-papel@example.com",
    name: "Admin Papel",
  });
  const emp = seedEmpresa(db, { id: "emp-papel", nome: "Empresa Papel" });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const badEmail = "super-papel@example.com";
  const beforeMemberships = countRows(db, "empresa_membros");
  const beforeUsers = countRows(db, "users", "email = ? COLLATE NOCASE", [
    badEmail,
  ]);

  const badRes = await postJson(
    app,
    MEMBROS_PATH,
    {
      name: "Bad Papel",
      email: badEmail,
      password: "secure-pass-ok",
      papel: "super_admin",
    },
    { Cookie: cookie },
  );
  assert.equal(badRes.status, 400, "invalid papel returns 400");
  assert.deepEqual(await badRes.json(), { error: "Invalid request" });
  assert.equal(
    countRows(db, "empresa_membros"),
    beforeMemberships,
    "no new membership row for super_admin papel",
  );
  assert.equal(
    countRows(db, "users", "email = ? COLLATE NOCASE", [badEmail]),
    beforeUsers,
    "no user created for invalid papel",
  );

  const goodEmail = "new-admin-papel@example.com";
  const goodRes = await postJson(
    app,
    MEMBROS_PATH,
    {
      name: "New Admin",
      email: goodEmail,
      password: "secure-pass-ok",
      papel: "admin",
    },
    { Cookie: cookie },
  );
  assert.equal(goodRes.status, 201, "valid papel admin returns 201");

  const listRes = await getJson(app, MEMBROS_PATH, { Cookie: cookie });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.ok(Array.isArray(listBody.membros), "membros is array");
  assert.ok(listBody.membros.length >= 2, "at least admin + new admin");

  for (const m of listBody.membros) {
    assert.ok(m && typeof m === "object", "membro entry");
    assert.ok(
      m.papel === "admin" || m.papel === "membro",
      `papel must be admin|membro, got ${m.papel}`,
    );
  }

  db.close();
});

// ─── lt-no-active-empresa-blocks-membros ───────────────────────────────────

/**
 * @description Authenticated session with active_empresa_id null cannot GET membros (403 Empresa ativa required).
 */
test("lt-no-active-empresa-blocks-membros: active null → GET 403 {error:'Empresa ativa required'}", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    email: "no-active@example.com",
    name: "No Active",
  });
  const emp = seedEmpresa(db, { id: "emp-no-active", nome: "Empresa No Active" });
  seedMembership(db, { empresaId: emp.id, userId: user.id, papel: "admin" });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, user.id, null);

  const res = await getJson(app, MEMBROS_PATH, { Cookie: cookie });
  assert.equal(res.status, 403, "no active empresa blocks list");
  assert.deepEqual(await res.json(), { error: "Empresa ativa required" });

  db.close();
});

// ─── lt-already-member-409 ─────────────────────────────────────────────────

/**
 * @description Admin POST membros with email already member of active empresa returns 409; no extra membership row.
 */
test("lt-already-member-409: existing member email → 409 Email already member; no extra membership", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-dup@example.com",
    name: "Admin Dup",
  });
  const existing = await seedUser(db, {
    email: "already@example.com",
    name: "Already Member",
  });
  const empA = seedEmpresa(db, { id: "emp-dup-a", nome: "Empresa Dup" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: existing.id,
    papel: "membro",
  });

  const beforeMemberships = countRows(
    db,
    "empresa_membros",
    "empresa_id = ? AND user_id = ?",
    [empA.id, existing.id],
  );
  assert.equal(beforeMemberships, 1);
  const beforeTotal = countRows(db, "empresa_membros", "empresa_id = ?", [
    empA.id,
  ]);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await postJson(
    app,
    MEMBROS_PATH,
    {
      name: "Duplicate Attempt",
      email: existing.email,
      password: "secure-pass-ok",
      papel: "membro",
    },
    { Cookie: cookie },
  );

  assert.equal(res.status, 409, "already member returns 409");
  assert.deepEqual(await res.json(), { error: "Email already member" });

  assert.equal(
    countRows(db, "empresa_membros", "empresa_id = ? AND user_id = ?", [
      empA.id,
      existing.id,
    ]),
    1,
    "still exactly one membership for existing user on A",
  );
  assert.equal(
    countRows(db, "empresa_membros", "empresa_id = ?", [empA.id]),
    beforeTotal,
    "no extra membership row on A",
  );

  db.close();
});
