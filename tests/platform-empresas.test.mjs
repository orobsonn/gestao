/**
 * Locked platform create-empresa contract — POST /api/platform/empresas.
 * Hermetic: node:sqlite + Hono app.request via createPlatformApp(db).
 * Applies migrations/0001_init.sql (foreign_keys=ON).
 * Batch path: createEmpresaAsSuperAdmin (DB.batch / transaction-emulated).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/worker/auth/password.ts";
import { buildSessionCookie, mintSession } from "../src/worker/auth/session.ts";
import { createPlatformApp } from "../src/worker/routes/platform.ts";
import { createEmpresaAsSuperAdmin } from "../src/worker/services/create-empresa.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(__dirname, "../migrations/0001_init.sql");
const CREATE_EMPRESA_SRC = resolve(
  __dirname,
  "../src/worker/services/create-empresa.ts",
);

const SESSION_COOKIE_NAME = "gestao_session";
const PLATFORM_CREATE_PATH = "/api/platform/empresas";

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
 * @description Seed a super_admin user with a known password.
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string, password?: string }} [opts]
 */
async function seedSuperAdmin(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const email = opts.email ?? "sa@example.com";
  const name = opts.name ?? "Super Admin";
  const password = opts.password ?? "secure-pass-ok";
  assert.ok(password.length >= 8);

  const { hash, salt } = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'super_admin')`,
  ).run(id, email, name, hash, salt);

  return { id, email, name, password, role: "super_admin" };
}

/**
 * @description Seed a role=user row (optional password).
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
  db.prepare(
    `INSERT INTO empresas (id, nome) VALUES (?, ?)`,
  ).run(id, nome);
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
 * @description Cookie header for an authenticated session of the given user id.
 * @param {DatabaseSync} db
 * @param {string} userId
 */
async function sessionCookieFor(db, userId) {
  const rawToken = await mintSession(db, userId);
  const setCookie = buildSessionCookie(rawToken);
  const token = setCookie.split(";")[0]?.split("=").slice(1).join("=");
  assert.ok(token && token.length > 0, "minted session token");
  return `${SESSION_COOKIE_NAME}=${token}`;
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
 * @description Valid create-empresa request body.
 * @param {{ nome?: string, adminName?: string, adminEmail?: string, adminPassword?: string }} [opts]
 */
function validCreateBody(opts = {}) {
  return {
    nome: opts.nome ?? "Nova Empresa",
    admin: {
      name: opts.adminName ?? "Admin Empresa",
      email: opts.adminEmail ?? "admin-nova@example.com",
      password: opts.adminPassword ?? "secure-pass-ok",
    },
  };
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

// ─── lt-ac-21-create-empresa-admin ─────────────────────────────────────────

/**
 * @description SA session POST /api/platform/empresas → 201 body shape; DB empresa + user role=user + membership admin.
 */
test("lt-ac-21-create-empresa-admin: SA POST → 201 {empresa,admin} no password; DB empresa+user(role=user)+membro admin", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, { email: "sa-create@example.com" });
  const app = createPlatformApp(db);
  const cookie = await sessionCookieFor(db, sa.id);

  const body = validCreateBody({
    nome: "Acme Corp",
    adminName: "Alice Admin",
    adminEmail: "alice@acme.example",
    adminPassword: "secure-pass-ok",
  });
  assert.ok(body.admin.password.length >= 8);

  const beforeEmpresas = countRows(db, "empresas");
  const res = await postJson(app, PLATFORM_CREATE_PATH, body, {
    Cookie: cookie,
  });

  assert.equal(res.status, 201, "create succeeds with 201");
  const json = await res.json();

  assert.equal(typeof json, "object");
  assert.ok(json.empresa && typeof json.empresa === "object", "body.empresa");
  assert.ok(json.admin && typeof json.admin === "object", "body.admin");
  assert.equal(typeof json.empresa.id, "string");
  assert.ok(json.empresa.id.length > 0);
  assert.equal(json.empresa.nome, "Acme Corp");
  assert.equal(typeof json.admin.id, "string");
  assert.ok(json.admin.id.length > 0);
  assert.equal(json.admin.email, "alice@acme.example");
  assert.equal(json.admin.name, "Alice Admin");

  // No password fields anywhere in response.
  const serialized = JSON.stringify(json);
  assert.equal("password" in json, false);
  assert.equal("password" in json.admin, false);
  assert.equal("password_hash" in json.admin, false);
  assert.equal("password_salt" in json.admin, false);
  assert.equal(serialized.includes("password_hash"), false);
  assert.equal(serialized.includes("password_salt"), false);
  assert.equal(serialized.includes(body.admin.password), false);

  assert.equal(countRows(db, "empresas"), beforeEmpresas + 1);

  const empresaRow = db
    .prepare(
      `SELECT id, nome, deleted_at FROM empresas WHERE id = ?`,
    )
    .get(json.empresa.id);
  assert.ok(empresaRow, "empresas row exists");
  assert.equal(empresaRow.nome, "Acme Corp");
  assert.equal(empresaRow.deleted_at, null, "deleted_at IS NULL");

  const userRow = db
    .prepare(
      `SELECT id, email, name, role FROM users WHERE email = ? COLLATE NOCASE`,
    )
    .get("alice@acme.example");
  assert.ok(userRow, "admin users row exists");
  assert.equal(userRow.id, json.admin.id);
  assert.equal(userRow.role, "user", "admin user role=user (not super_admin)");
  assert.notEqual(userRow.role, "super_admin");

  const memberRow = db
    .prepare(
      `SELECT empresa_id, user_id, papel FROM empresa_membros
       WHERE empresa_id = ? AND user_id = ?`,
    )
    .get(json.empresa.id, json.admin.id);
  assert.ok(memberRow, "empresa_membros link exists");
  assert.equal(memberRow.papel, "admin");

  db.close();
});

// ─── lt-ac-22-non-sa-forbidden ─────────────────────────────────────────────

/**
 * @description Authenticated role=user with empresa_membros.papel=admin cannot create empresas (403, zero new rows).
 */
test("lt-ac-22-non-sa-forbidden: role=user + membership admin → 403, zero new empresas", async () => {
  const db = openDb();
  const empresa = seedEmpresa(db, { nome: "Existing Co" });
  const user = await seedUser(db, {
    email: "empresa-admin@example.com",
    name: "Empresa Admin",
  });
  seedMembership(db, {
    empresaId: empresa.id,
    userId: user.id,
    papel: "admin",
  });

  const app = createPlatformApp(db);
  const cookie = await sessionCookieFor(db, user.id);

  const before = countRows(db, "empresas");
  const res = await postJson(app, PLATFORM_CREATE_PATH, validCreateBody({
    nome: "Should Not Create",
    adminEmail: "new-admin@example.com",
  }), { Cookie: cookie });

  assert.equal(res.status, 403, "non-SA forbidden");
  assert.equal(countRows(db, "empresas"), before, "zero new empresas rows");

  db.close();
});

// ─── lt-create-duplicate-email-409 ─────────────────────────────────────────

/**
 * @description Existing users.email on create → 409 and no orphan empresa for the attempted create.
 */
test("lt-create-duplicate-email-409: existing email → 409, no orphan empresa", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, { email: "sa-dup@example.com" });
  const existing = await seedUser(db, {
    email: "taken@example.com",
    name: "Already Here",
  });

  const app = createPlatformApp(db);
  const cookie = await sessionCookieFor(db, sa.id);

  const beforeEmpresas = countRows(db, "empresas");
  const beforeUsers = countRows(db, "users");
  const empresaIdsBefore = new Set(
    db.prepare(`SELECT id FROM empresas`).all().map((r) => r.id),
  );

  const res = await postJson(
    app,
    PLATFORM_CREATE_PATH,
    validCreateBody({
      nome: "Orphan Attempt",
      adminEmail: existing.email,
      adminName: "Dup Admin",
    }),
    { Cookie: cookie },
  );

  assert.equal(res.status, 409, "duplicate email → 409");
  assert.equal(
    countRows(db, "empresas"),
    beforeEmpresas,
    "no new empresas row remains (no orphan)",
  );
  assert.equal(
    countRows(db, "users"),
    beforeUsers,
    "no extra users row for failed create",
  );

  const empresaIdsAfter = db.prepare(`SELECT id FROM empresas`).all().map((r) => r.id);
  for (const id of empresaIdsAfter) {
    assert.ok(empresaIdsBefore.has(id), "no new empresa id after failed create");
  }

  // Existing user unchanged (not re-attached / not promoted).
  const still = db
    .prepare(`SELECT id, role FROM users WHERE email = ? COLLATE NOCASE`)
    .get(existing.email);
  assert.ok(still);
  assert.equal(still.id, existing.id);
  assert.equal(still.role, "user");

  db.close();
});

// ─── lt-create-short-password-400 ──────────────────────────────────────────

/**
 * @description admin.password length < 8 → 400 and zero new rows in empresas, users (that email), empresa_membros.
 */
test("lt-create-short-password-400: password < 8 → 400, zero new rows", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, { email: "sa-short@example.com" });
  const app = createPlatformApp(db);
  const cookie = await sessionCookieFor(db, sa.id);

  const shortPassword = "short"; // length 5 < 8
  assert.ok(shortPassword.length < 8);

  const adminEmail = "short-pw-admin@example.com";
  const beforeEmpresas = countRows(db, "empresas");
  const beforeUsers = countRows(db, "users");
  const beforeMembros = countRows(db, "empresa_membros");

  const res = await postJson(
    app,
    PLATFORM_CREATE_PATH,
    validCreateBody({
      nome: "Short PW Co",
      adminEmail,
      adminPassword: shortPassword,
    }),
    { Cookie: cookie },
  );

  assert.equal(res.status, 400, "short password → 400");
  assert.equal(countRows(db, "empresas"), beforeEmpresas, "zero new empresas");
  assert.equal(countRows(db, "users"), beforeUsers, "zero new users overall");
  assert.equal(
    countRows(db, "users", `email = ? COLLATE NOCASE`, [adminEmail]),
    0,
    "zero users for that email",
  );
  assert.equal(
    countRows(db, "empresa_membros"),
    beforeMembros,
    "zero new empresa_membros",
  );

  db.close();
});

// ─── lt-create-unauthenticated-401 ─────────────────────────────────────────

/**
 * @description No valid session cookie → 401 and zero new empresas rows.
 */
test("lt-create-unauthenticated-401: no cookie → 401, zero new empresas", async () => {
  const db = openDb();
  // SA exists but request carries no cookie.
  await seedSuperAdmin(db, { email: "sa-unauth@example.com" });
  const app = createPlatformApp(db);

  const before = countRows(db, "empresas");
  const res = await postJson(app, PLATFORM_CREATE_PATH, validCreateBody({
    nome: "Unauth Co",
    adminEmail: "unauth-admin@example.com",
  }));

  assert.equal(res.status, 401, "unauthenticated → 401");
  assert.equal(countRows(db, "empresas"), before, "zero new empresas");

  db.close();
});

// ─── lt-create-uses-batch-not-sequential ────────────────────────────────────

/**
 * @description createEmpresaAsSuperAdmin write path uses a single batch/transaction with three inserts — not three independent non-batched run() commits as the sole path.
 */
test("lt-create-uses-batch-not-sequential: batch/transaction with 3 inserts, not sole sequential run() path", async () => {
  // ── Source inspection (implementation contract) ──────────────────────────
  const src = readFileSync(CREATE_EMPRESA_SRC, "utf8");

  // DB.batch-only atomicity — sequential independent run() commits are not the sole write path.
  assert.match(src, /\.batch\s*\(/, "createEmpresaAsSuperAdmin must invoke db.batch(...)");

  const insertMatches = src.match(/INSERT\s+INTO\s+(empresas|users|empresa_membros)/gi) ?? [];
  assert.ok(
    insertMatches.length >= 3,
    `expected ≥3 inserts into empresas/users/empresa_membros, found ${insertMatches.length}`,
  );
  const targets = insertMatches.map((m) => m.toLowerCase());
  assert.ok(targets.some((t) => t.includes("empresas")), "inserts empresas");
  assert.ok(targets.some((t) => t.includes("users")), "inserts users");
  assert.ok(
    targets.some((t) => t.includes("empresa_membros")),
    "inserts empresa_membros",
  );

  // ── Runtime spy: batch receives three write statements (sqlite-immediate-transaction) ──
  const db = openDb();
  await seedSuperAdmin(db, { email: "sa-batch@example.com" });

  /** @type {unknown[][]} */
  const batchCalls = [];

  /**
   * @description DbLike + batch: emulate D1.batch via BEGIN IMMEDIATE transaction.
   */
  const spyDb = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          return stmt.run(...params);
        },
        get(...params) {
          return stmt.get(...params);
        },
        all(...params) {
          return typeof stmt.all === "function" ? stmt.all(...params) : [];
        },
        /**
         * @description D1-style bind returning a statement handle for batch.
         */
        bind(...params) {
          return {
            sql,
            params,
            run: () => stmt.run(...params),
            get: () => stmt.get(...params),
          };
        },
      };
    },
    /**
     * @description D1-compatible batch: run all statements inside one IMMEDIATE transaction.
     * @param {Array<{ run?: Function, sql?: string, params?: unknown[] }>} statements
     */
    async batch(statements) {
      batchCalls.push(statements);
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const s of statements) {
          if (s && typeof s.run === "function") {
            results.push(await Promise.resolve(s.run()));
          } else if (
            s &&
            typeof s === "object" &&
            "sql" in s &&
            Array.isArray(/** @type {{ params?: unknown[] }} */ (s).params)
          ) {
            const item = /** @type {{ sql: string, params: unknown[] }} */ (s);
            results.push(db.prepare(item.sql).run(...item.params));
          } else {
            throw new Error("unsupported batch statement shape");
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw err;
      }
    },
  };

  const result = await createEmpresaAsSuperAdmin(spyDb, {
    nome: "Batch Co",
    admin: {
      name: "Batch Admin",
      email: "batch-admin@example.com",
      password: "secure-pass-ok",
    },
  });

  assert.ok(result, "createEmpresaAsSuperAdmin returns a result");
  assert.ok(
    batchCalls.length >= 1,
    "write path must call db.batch at least once (not sole sequential run)",
  );

  const batchStmtCount = batchCalls[0]?.length ?? 0;
  assert.equal(
    batchStmtCount,
    3,
    `batch must carry three inserts (empresa+user+membership), got ${batchStmtCount}`,
  );

  // Confirm rows landed atomically via the batch path.
  const empresa = db
    .prepare(`SELECT id, nome FROM empresas WHERE nome = ?`)
    .get("Batch Co");
  assert.ok(empresa, "empresa row created via batch path");
  const admin = db
    .prepare(`SELECT id, role FROM users WHERE email = ? COLLATE NOCASE`)
    .get("batch-admin@example.com");
  assert.ok(admin);
  assert.equal(admin.role, "user");
  const link = db
    .prepare(
      `SELECT papel FROM empresa_membros WHERE empresa_id = ? AND user_id = ?`,
    )
    .get(empresa.id, admin.id);
  assert.ok(link);
  assert.equal(link.papel, "admin");

  db.close();
});
