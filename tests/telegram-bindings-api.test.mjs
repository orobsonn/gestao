/**
 * Locked admin API telegram-bindings status + mint commands contract.
 * Hermetic: node:sqlite + Hono app.request via createEmpresaApp(db).
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
import {
  buildSessionCookie,
  mintSession,
} from "../src/worker/auth/session.ts";
import { createEmpresaApp } from "../src/worker/routes/empresa.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const SESSION_COOKIE_NAME = "gestao_session";
const BINDINGS_PATH = "/api/empresa/telegram-bindings";
const EMPRESA_COMMAND_PATH = "/api/empresa/telegram-bindings/empresa-command";
const EXPERT_COMMAND_PATH = "/api/empresa/telegram-bindings/expert-command";

const EMPRESA_COMMAND_RE = /^\/vincular_empresa [0-9a-f]{64}$/;
const EXPERT_COMMAND_RE = /^\/vincular_expert [0-9a-f]{64}$/;

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
 * @description Seed a live expert row (deleted_at NULL unless deletedAt set).
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, id?: string, nome?: string, deletedAt?: string | null }} opts
 */
function seedExpert(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Expert Seed";
  const deletedAt = opts.deletedAt ?? null;
  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
    ).run(id, opts.empresaId, nome);
  } else {
    db.prepare(
      `INSERT INTO experts (id, empresa_id, nome, deleted_at) VALUES (?, ?, ?, ?)`,
    ).run(id, opts.empresaId, nome, deletedAt);
  }
  return { id, nome, empresaId: opts.empresaId, deletedAt };
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
 * @description SHA-256 hex digest of utf8 string.
 * @param {string} value
 */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * @description Extract 64-hex raw code from a /vincular_* command string.
 * @param {string} command
 */
function rawCodeFromCommand(command) {
  const parts = String(command).trim().split(/\s+/);
  assert.equal(parts.length, 2, "command must be '/vincular_* <64hex>'");
  const raw = parts[1];
  assert.match(raw, /^[0-9a-f]{64}$/, "raw code must be 64 hex chars");
  return raw;
}

/**
 * @description Count telegram_bind_codes rows (optional WHERE).
 * @param {DatabaseSync} db
 * @param {string} [whereSql]
 * @param {unknown[]} [params]
 */
function countBindCodes(db, whereSql = "", params = []) {
  const sql = whereSql
    ? `SELECT COUNT(*) AS c FROM telegram_bind_codes WHERE ${whereSql}`
    : `SELECT COUNT(*) AS c FROM telegram_bind_codes`;
  const row = db.prepare(sql).get(...params);
  return Number(row.c);
}

/**
 * @description Assert expires_at string falls in [T+14min, T+16min] window.
 * @param {string} expiresAt
 * @param {number} tBefore
 * @param {number} tAfter
 */
function assertExpiresWithinTtl(expiresAt, tBefore, tAfter) {
  assert.equal(typeof expiresAt, "string");
  const expiresMs = Date.parse(expiresAt);
  assert.ok(Number.isFinite(expiresMs), "expires_at must parse as instant");
  const minMs = tBefore + 14 * 60 * 1000;
  const maxMs = tAfter + 16 * 60 * 1000;
  assert.ok(
    expiresMs >= minMs,
    `expires_at ${expiresAt} must be >= T+14min (min=${new Date(minMs).toISOString()})`,
  );
  assert.ok(
    expiresMs <= maxMs,
    `expires_at ${expiresAt} must be <= T+16min (max=${new Date(maxMs).toISOString()})`,
  );
}

// ─── lt-api-mint-empresa-command-shape ─────────────────────────────────────

/**
 * @description Admin POST empresa-command returns /vincular_empresa + 64 hex, TTL 14..16 min, DB stores SHA-256 hash only.
 */
test("lt-api-mint-empresa-command-shape: admin POST empresa-command → 200 command shape, TTL, code_hash SHA-256, kind=empresa used_at NULL", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-emp-shape@example.com",
    name: "Admin Bind Empresa",
  });
  const emp = seedEmpresa(db, { id: "emp-bind-shape", nome: "Empresa Bind" });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const tBefore = Date.now();
  const res = await app.request(EMPRESA_COMMAND_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  const tAfter = Date.now();

  assert.equal(res.status, 200, "admin mint empresa-command succeeds");
  const body = await res.json();
  assert.equal(typeof body.command, "string");
  assert.match(body.command, EMPRESA_COMMAND_RE);
  assertExpiresWithinTtl(body.expires_at, tBefore, tAfter);

  const rawCode = rawCodeFromCommand(body.command);
  const expectedHash = sha256Hex(rawCode);
  assert.notEqual(
    rawCode,
    expectedHash,
    "raw code must not equal its SHA-256 hex",
  );

  const rows = db
    .prepare(
      `SELECT code_hash, kind, expert_id, used_at, empresa_id
       FROM telegram_bind_codes WHERE empresa_id = ?`,
    )
    .all(emp.id);
  assert.equal(rows.length, 1, "exactly one bind code row for empresa");
  assert.equal(rows[0].empresa_id, emp.id);
  assert.equal(rows[0].kind, "empresa");
  assert.equal(rows[0].expert_id, null);
  assert.equal(
    rows[0].code_hash,
    expectedHash,
    "DB code_hash must equal SHA-256 hex of raw command code",
  );
  assert.equal(rows[0].used_at, null, "fresh mint used_at IS NULL");

  const bodyText = JSON.stringify(body);
  assert.equal(
    bodyText.includes(expectedHash),
    false,
    "mint JSON must not leak code_hash",
  );

  db.close();
});

// ─── lt-api-mint-expert-command-shape ──────────────────────────────────────

/**
 * @description Admin POST expert-command with live same-tenant expert returns /vincular_expert + 64 hex; DB kind=expert.
 */
test("lt-api-mint-expert-command-shape: admin POST expert-command {expert_id} → 200 command shape, DB kind=expert", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-ex-shape@example.com",
    name: "Admin Bind Expert",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-ex-shape",
    nome: "Empresa Expert Bind",
  });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-shape",
    nome: "Expert Bind Shape",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res = await postJson(
    app,
    EXPERT_COMMAND_PATH,
    { expert_id: expert.id },
    { Cookie: cookie },
  );

  assert.equal(res.status, 200, "admin mint expert-command succeeds");
  const body = await res.json();
  assert.equal(typeof body.command, "string");
  assert.match(body.command, EXPERT_COMMAND_RE);

  const rawCode = rawCodeFromCommand(body.command);
  const expectedHash = sha256Hex(rawCode);

  const rows = db
    .prepare(
      `SELECT code_hash, kind, expert_id, used_at, empresa_id
       FROM telegram_bind_codes WHERE expert_id = ?`,
    )
    .all(expert.id);
  assert.equal(rows.length, 1, "exactly one bind code row for expert");
  assert.equal(rows[0].kind, "expert");
  assert.equal(rows[0].expert_id, expert.id);
  assert.equal(rows[0].empresa_id, emp.id);
  assert.equal(rows[0].code_hash, expectedHash);
  assert.equal(rows[0].used_at, null);

  db.close();
});

// ─── lt-api-mint-empresa-invalidates-prior ─────────────────────────────────

/**
 * @description Second empresa-command mint burns prior unused C1; exactly one unused C2 remains with different hash.
 */
test("lt-api-mint-empresa-invalidates-prior: second mint burns C1; one unused C2; different hash", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-emp-inv@example.com",
    name: "Admin Bind Invalidate Empresa",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-inv",
    nome: "Empresa Invalidate",
  });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res1 = await app.request(EMPRESA_COMMAND_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  const c1 = rawCodeFromCommand(body1.command);
  const hash1 = sha256Hex(c1);

  const res2 = await app.request(EMPRESA_COMMAND_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  const c2 = rawCodeFromCommand(body2.command);
  const hash2 = sha256Hex(c2);

  assert.notEqual(c1, c2, "second mint raw code must differ from first");
  assert.notEqual(hash1, hash2, "second mint code_hash must differ from first");

  const rowC1 = db
    .prepare(`SELECT used_at FROM telegram_bind_codes WHERE code_hash = ?`)
    .get(hash1);
  assert.ok(rowC1, "C1 row exists");
  assert.notEqual(
    rowC1.used_at,
    null,
    "C1 used_at must be NOT NULL after remint",
  );

  const rowC2 = db
    .prepare(`SELECT used_at FROM telegram_bind_codes WHERE code_hash = ?`)
    .get(hash2);
  assert.ok(rowC2, "C2 row exists");
  assert.equal(rowC2.used_at, null, "C2 used_at must be IS NULL");

  assert.equal(
    countBindCodes(
      db,
      `empresa_id = ? AND kind = 'empresa' AND used_at IS NULL`,
      [emp.id],
    ),
    1,
    "exactly one unused kind=empresa row remains for A",
  );

  db.close();
});

// ─── lt-api-mint-expert-invalidates-prior ──────────────────────────────────

/**
 * @description Second expert-command mint for same expert burns prior unused C1; one unused C2 remains with different hash.
 */
test("lt-api-mint-expert-invalidates-prior: second mint burns C1; one unused C2; different hash", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-ex-inv@example.com",
    name: "Admin Bind Invalidate Expert",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-ex-inv",
    nome: "Empresa Expert Invalidate",
  });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-inv",
    nome: "Expert Invalidate",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res1 = await postJson(
    app,
    EXPERT_COMMAND_PATH,
    { expert_id: expert.id },
    { Cookie: cookie },
  );
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  const c1 = rawCodeFromCommand(body1.command);
  const hash1 = sha256Hex(c1);

  const res2 = await postJson(
    app,
    EXPERT_COMMAND_PATH,
    { expert_id: expert.id },
    { Cookie: cookie },
  );
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  const c2 = rawCodeFromCommand(body2.command);
  const hash2 = sha256Hex(c2);

  assert.notEqual(c1, c2, "second mint raw code must differ from first");
  assert.notEqual(hash1, hash2, "second mint code_hash must differ from first");

  const rowC1 = db
    .prepare(`SELECT used_at FROM telegram_bind_codes WHERE code_hash = ?`)
    .get(hash1);
  assert.ok(rowC1, "C1 row exists");
  assert.notEqual(
    rowC1.used_at,
    null,
    "C1 used_at must be NOT NULL after remint",
  );

  const rowC2 = db
    .prepare(`SELECT used_at FROM telegram_bind_codes WHERE code_hash = ?`)
    .get(hash2);
  assert.ok(rowC2, "C2 row exists");
  assert.equal(rowC2.used_at, null, "C2 used_at must be IS NULL");

  assert.equal(
    countBindCodes(
      db,
      `expert_id = ? AND kind = 'expert' AND used_at IS NULL`,
      [expert.id],
    ),
    1,
    "exactly one unused kind=expert row remains for E",
  );

  db.close();
});

// ─── lt-api-mint-membro-403 ────────────────────────────────────────────────

/**
 * @description Membro session GET bindings and both POST mints return 403; no telegram_bind_codes inserted.
 */
test("lt-api-mint-membro-403: GET + both POSTs → 403 each; no new bind codes", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-bind@example.com",
    name: "Membro Bind",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-membro",
    nome: "Empresa Membro Bind",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-membro",
    nome: "Expert For Membro Gate",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const before = countBindCodes(db);

  const getRes = await getJson(app, BINDINGS_PATH, { Cookie: cookie });
  assert.equal(getRes.status, 403, "membro GET telegram-bindings must be 403");

  const empMintRes = await app.request(EMPRESA_COMMAND_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(
    empMintRes.status,
    403,
    "membro POST empresa-command must be 403",
  );

  const exMintRes = await postJson(
    app,
    EXPERT_COMMAND_PATH,
    { expert_id: expert.id },
    { Cookie: cookie },
  );
  assert.equal(
    exMintRes.status,
    403,
    "membro POST expert-command must be 403",
  );

  assert.equal(
    countBindCodes(db),
    before,
    "no new telegram_bind_codes row after membro attempts",
  );

  db.close();
});

// ─── lt-api-mint-expert-soft-deleted-404 ───────────────────────────────────

/**
 * @description Admin POST expert-command for soft-deleted expert returns 404 Not found and inserts no bind code.
 */
test("lt-api-mint-expert-soft-deleted-404: soft-deleted expert → 404 {error:'Not found'}; no code", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-soft@example.com",
    name: "Admin Soft Delete Expert",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-soft",
    nome: "Empresa Soft Expert",
  });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-soft",
    nome: "Soft Deleted Expert",
    deletedAt: "2026-01-01 00:00:00",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const before = countBindCodes(db);

  const res = await postJson(
    app,
    EXPERT_COMMAND_PATH,
    { expert_id: expert.id },
    { Cookie: cookie },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: "Not found" });

  assert.equal(
    countBindCodes(db),
    before,
    "no telegram_bind_codes row after soft-deleted expert mint",
  );
  assert.equal(
    countBindCodes(db, `expert_id = ?`, [expert.id]),
    0,
    "no bind code for soft-deleted expert",
  );

  db.close();
});

// ─── lt-api-mint-expert-other-tenant-404 ───────────────────────────────────

/**
 * @description Admin of empresa A minting expert of empresa B returns 404 Not found and inserts no code for A.
 */
test("lt-api-mint-expert-other-tenant-404: expert of B + admin A → 404 {error:'Not found'}; no code for A", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-xtenant@example.com",
    name: "Admin Cross Tenant Bind",
  });
  const empA = seedEmpresa(db, {
    id: "emp-bind-x-a",
    nome: "Empresa A Bind",
  });
  const empB = seedEmpresa(db, {
    id: "emp-bind-x-b",
    nome: "Empresa B Bind",
  });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-bind-owned-by-b",
    nome: "Expert Of B",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const beforeA = countBindCodes(db, `empresa_id = ?`, [empA.id]);
  const beforeAll = countBindCodes(db);

  const res = await postJson(
    app,
    EXPERT_COMMAND_PATH,
    { expert_id: expertB.id },
    { Cookie: cookie },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: "Not found" });

  assert.equal(
    countBindCodes(db, `empresa_id = ?`, [empA.id]),
    beforeA,
    "no bind code inserted for empresa A",
  );
  assert.equal(
    countBindCodes(db),
    beforeAll,
    "no telegram_bind_codes row after cross-tenant expert mint",
  );

  db.close();
});

// ─── lt-api-status-booleans-only ───────────────────────────────────────────

/**
 * @description GET telegram-bindings with seeded maps returns linked booleans+timestamps only; never chat_id or message_thread_id.
 */
test("lt-api-status-booleans-only: linked true + linked_at; experts DTO keys only; no chat_id/thread in JSON", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-status@example.com",
    name: "Admin Status Linked",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-status",
    nome: "Empresa Status Linked",
  });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });
  const expertLinked = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-status-linked",
    nome: "Expert Linked",
  });
  const expertUnlinked = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-status-free",
    nome: "Expert Free",
  });

  const seededChatId = "-1001999888777";
  const seededThreadId = "4242";
  const empresaLinkedAt = "2026-06-01 12:00:00";
  const expertLinkedAt = "2026-06-02 15:30:00";

  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(emp.id, seededChatId, empresaLinkedAt);

  db.prepare(
    `INSERT INTO expert_telegram_topics
       (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    expertLinked.id,
    emp.id,
    seededChatId,
    seededThreadId,
    expertLinkedAt,
  );

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res = await getJson(app, BINDINGS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body && typeof body === "object", "body is object");
  assert.ok(body.empresa && typeof body.empresa === "object");
  assert.equal(body.empresa.linked, true);
  assert.equal(typeof body.empresa.linked_at, "string");
  assert.ok(body.empresa.linked_at.length > 0, "linked_at non-empty string");

  assert.ok(Array.isArray(body.experts), "body.experts is array");
  assert.ok(body.experts.length >= 2, "at least two experts in DTO");

  const allowedExpertKeys = new Set([
    "expert_id",
    "nome",
    "linked",
    "linked_at",
  ]);

  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();
  for (const entry of body.experts) {
    assert.ok(entry && typeof entry === "object", "expert entry is object");
    for (const key of Object.keys(entry)) {
      assert.ok(
        allowedExpertKeys.has(key),
        `experts[] entry must only expose expert_id,nome,linked,linked_at? — got key ${key}`,
      );
    }
    assert.equal(typeof entry.expert_id, "string");
    assert.equal(typeof entry.nome, "string");
    assert.equal(typeof entry.linked, "boolean");
    if (entry.linked === true) {
      assert.equal(typeof entry.linked_at, "string");
    }
    byId.set(entry.expert_id, entry);
  }

  const linkedEntry = byId.get(expertLinked.id);
  assert.ok(linkedEntry, "linked expert present in DTO");
  assert.equal(linkedEntry.linked, true);
  assert.equal(typeof linkedEntry.linked_at, "string");
  assert.equal(linkedEntry.nome, expertLinked.nome);

  const freeEntry = byId.get(expertUnlinked.id);
  assert.ok(freeEntry, "unlinked expert present in DTO");
  assert.equal(freeEntry.linked, false);

  const serialized = JSON.stringify(body);
  assert.equal(
    serialized.includes(seededChatId),
    false,
    "JSON must not contain seeded chat_id",
  );
  assert.equal(
    serialized.includes(seededThreadId),
    false,
    "JSON must not contain seeded message_thread_id",
  );
  assert.equal(
    serialized.includes("chat_id"),
    false,
    "JSON must not expose chat_id key",
  );
  assert.equal(
    serialized.includes("message_thread_id"),
    false,
    "JSON must not expose message_thread_id key",
  );

  db.close();
});

// ─── lt-api-status-unlinked-false ──────────────────────────────────────────

/**
 * @description GET telegram-bindings with no maps returns empresa.linked false and every expert.linked false.
 */
test("lt-api-status-unlinked-false: no maps → empresa.linked===false and every expert.linked===false", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-bind-unlinked@example.com",
    name: "Admin Status Unlinked",
  });
  const emp = seedEmpresa(db, {
    id: "emp-bind-unlinked",
    nome: "Empresa Unlinked",
  });
  seedMembership(db, { empresaId: emp.id, userId: admin.id, papel: "admin" });
  const e1 = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-unlinked-1",
    nome: "Expert One",
  });
  const e2 = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-bind-unlinked-2",
    nome: "Expert Two",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res = await getJson(app, BINDINGS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body && typeof body === "object");
  assert.ok(body.empresa && typeof body.empresa === "object");
  assert.equal(body.empresa.linked, false);

  assert.ok(Array.isArray(body.experts));
  const ids = new Set(body.experts.map((/** @type {{expert_id:string}} */ e) => e.expert_id));
  assert.ok(ids.has(e1.id));
  assert.ok(ids.has(e2.id));

  for (const entry of body.experts) {
    assert.equal(
      entry.linked,
      false,
      `expert ${entry.expert_id} must have linked===false`,
    );
  }

  db.close();
});
