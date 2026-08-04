/**
 * Locked experts tenant CRUD contract — admin writes, member guards, soft-delete, isolation.
 * Hermetic: node:sqlite + Hono app.request via createEmpresaApp(db).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 */
import assert from "node:assert/strict";
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
const EXPERTS_PATH = "/api/empresa/experts";

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
 * @description Seed a live expert row (deleted_at NULL).
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
 * @description Seed a live campanha under expert (composite FK expert_id+empresa_id).
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, expertId: string, id?: string, nome?: string, tipo?: string }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const tipo = opts.tipo ?? "gratuito";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.empresaId, opts.expertId, nome, tipo);
  return { id, nome, empresaId: opts.empresaId, expertId: opts.expertId };
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
 * @description PATCH JSON helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 */
async function patchJson(app, path, body, extraHeaders = {}) {
  return app.request(path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/**
 * @description DELETE helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {Record<string, string>} [extraHeaders]
 */
async function deleteReq(app, path, extraHeaders = {}) {
  return app.request(path, {
    method: "DELETE",
    headers: { ...extraHeaders },
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
 * @description Read expert row by id (or null).
 * @param {DatabaseSync} db
 * @param {string} id
 */
function expertRow(db, id) {
  return (
    db
      .prepare(
        `SELECT id, empresa_id, nome, deleted_at FROM experts WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

/**
 * @description Collect expert ids from list response body (array or {experts:[]}).
 * @param {unknown} body
 * @returns {Set<string>}
 */
function expertIdsFromList(body) {
  assert.ok(body !== null && body !== undefined, "list body present");
  /** @type {unknown[]} */
  let items;
  if (Array.isArray(body)) {
    items = body;
  } else if (body && typeof body === "object" && Array.isArray(body.experts)) {
    items = body.experts;
  } else {
    assert.fail("list body must be array or {experts:[]}");
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const item of items) {
    assert.ok(item && typeof item === "object", "expert entry is object");
    if (typeof item.id === "string") ids.add(item.id);
  }
  return ids;
}

/**
 * @description Count experts rows matching nome.
 * @param {DatabaseSync} db
 * @param {string} nome
 */
function countExpertsByNome(db, nome) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM experts WHERE nome = ?`)
    .get(nome);
  return Number(row.c);
}

// ─── lt-expert-admin-create-201 ────────────────────────────────────────────

/**
 * @description Admin POST /api/empresa/experts creates expert for active empresa with deleted_at NULL.
 */
test("lt-expert-admin-create-201: admin POST {nome:'Expert X'} → 201 id+nome; DB empresa_id=A deleted_at NULL", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-expert-create@example.com",
    name: "Admin Expert Create",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-create-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await postJson(
    app,
    EXPERTS_PATH,
    { nome: "Expert X" },
    { Cookie: cookie },
  );
  assert.equal(res.status, 201, "create returns 201");
  const body = await res.json();
  assert.ok(body && typeof body === "object", "body is object");
  assert.equal(typeof body.id, "string");
  assert.ok(body.id.length > 0, "body includes id");
  assert.equal(body.nome, "Expert X");

  const row = expertRow(db, body.id);
  assert.ok(row, "DB row exists");
  assert.equal(row.empresa_id, empA.id);
  assert.equal(row.nome, "Expert X");
  assert.equal(row.deleted_at, null);

  db.close();
});

// ─── lt-expert-membro-create-403 ───────────────────────────────────────────

/**
 * @description Membro session cannot POST /api/empresa/experts (403; no row for that nome).
 */
test("lt-expert-membro-create-403: membro POST {nome:'Nope'} → 403 body.error; no experts row for nome", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-expert-create@example.com",
    name: "Membro Expert Create",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-membro-c", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });

  assert.equal(countExpertsByNome(db, "Nope"), 0);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await postJson(
    app,
    EXPERTS_PATH,
    { nome: "Nope" },
    { Cookie: cookie },
  );
  assert.equal(res.status, 403, "membro create forbidden");
  const body = await res.json();
  assert.ok(body && typeof body === "object", "body is object");
  assert.ok("error" in body && body.error, "body.error is present");

  assert.equal(
    countExpertsByNome(db, "Nope"),
    0,
    "no experts row inserted for that nome",
  );

  db.close();
});

// ─── lt-expert-membro-patch-delete-403 ─────────────────────────────────────

/**
 * @description Membro cannot PATCH or DELETE a live expert of active empresa (403; row unchanged).
 */
test("lt-expert-membro-patch-delete-403: membro PATCH+DELETE live expert → both 403 body.error; nome/deleted_at unchanged", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-expert-write@example.com",
    name: "Membro Expert Write",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-membro-w", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-membro-guard",
    nome: "Original Nome",
  });

  const before = expertRow(db, expert.id);
  assert.ok(before);
  assert.equal(before.nome, "Original Nome");
  assert.equal(before.deleted_at, null);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);
  const path = `${EXPERTS_PATH}/${expert.id}`;

  const patchRes = await patchJson(
    app,
    path,
    { nome: "Hacked" },
    { Cookie: cookie },
  );
  assert.equal(patchRes.status, 403, "membro PATCH forbidden");
  const patchBody = await patchRes.json();
  assert.ok(patchBody && typeof patchBody === "object");
  assert.ok("error" in patchBody && patchBody.error, "PATCH body.error present");

  const delRes = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(delRes.status, 403, "membro DELETE forbidden");
  const delBody = await delRes.json();
  assert.ok(delBody && typeof delBody === "object");
  assert.ok("error" in delBody && delBody.error, "DELETE body.error present");

  const after = expertRow(db, expert.id);
  assert.ok(after);
  assert.equal(after.nome, "Original Nome", "nome unchanged");
  assert.equal(after.deleted_at, null, "deleted_at unchanged");

  db.close();
});

// ─── lt-expert-cross-tenant-get-404 ────────────────────────────────────────

/**
 * @description GET expert owned by empresa B while session active on A returns 404 Not found without foreign fields.
 */
test("lt-expert-cross-tenant-get-404: expert of B + session A → GET 404 {error:'Not found'}; no nome/empresa_id from B", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-xget@example.com",
    name: "Admin Cross Get",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-xget-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-ex-xget-b", nome: "Empresa B" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-owned-by-b-get",
    nome: "Secret Expert B",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await getJson(app, `${EXPERTS_PATH}/${expertB.id}`, {
    Cookie: cookie,
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: "Not found" });
  assert.equal("nome" in body, false, "JSON has no nome from B");
  assert.equal("empresa_id" in body, false, "JSON has no empresa_id from B");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("Secret Expert B"), false);
  assert.equal(serialized.includes(empB.id), false);

  db.close();
});

// ─── lt-expert-cross-tenant-patch-delete-404 ───────────────────────────────

/**
 * @description Admin on A cannot PATCH/DELETE expert of B (404 Not found; B row unchanged).
 */
test("lt-expert-cross-tenant-patch-delete-404: expert of B + admin A → PATCH+DELETE 404 Not found; B nome/deleted_at unchanged", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-xwrite@example.com",
    name: "Admin Cross Write",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-xwrite-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-ex-xwrite-b", nome: "Empresa B" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-owned-by-b-write",
    nome: "Expert B Original",
  });

  const before = expertRow(db, expertB.id);
  assert.ok(before);
  assert.equal(before.nome, "Expert B Original");
  assert.equal(before.deleted_at, null);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);
  const path = `${EXPERTS_PATH}/${expertB.id}`;

  const patchRes = await patchJson(
    app,
    path,
    { nome: "Hijacked" },
    { Cookie: cookie },
  );
  assert.equal(patchRes.status, 404);
  const patchBody = await patchRes.json();
  assert.equal(patchBody.error, "Not found");

  const delRes = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(delRes.status, 404);
  const delBody = await delRes.json();
  assert.equal(delBody.error, "Not found");

  const after = expertRow(db, expertB.id);
  assert.ok(after);
  assert.equal(after.nome, "Expert B Original", "B row nome unchanged");
  assert.equal(after.deleted_at, null, "B row deleted_at unchanged");

  db.close();
});

// ─── lt-expert-delete-tombstone-idempotent ─────────────────────────────────

/**
 * @description DELETE live expert is 204 and idempotent on tombstone; GET/list omit; never-existed UUID is 404 Not found.
 */
test("lt-expert-delete-tombstone-idempotent: DELETE×2 → 204; GET 404; list omits; never-existed UUID DELETE 404 same shape", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-tomb@example.com",
    name: "Admin Tombstone",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-tomb-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tomb-live",
    nome: "To Tombstone",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);
  const path = `${EXPERTS_PATH}/${expert.id}`;

  const del1 = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(del1.status, 204, "first DELETE returns 204");

  const del2 = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(del2.status, 204, "second DELETE returns 204");

  const getRes = await getJson(app, path, { Cookie: cookie });
  assert.equal(getRes.status, 404, "GET after delete returns 404");

  const listRes = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(listRes.status, 200);
  const listIds = expertIdsFromList(await listRes.json());
  assert.equal(listIds.has(expert.id), false, "list omits deleted id");

  const neverId = "00000000-0000-4000-8000-000000000099";
  const neverRes = await deleteReq(app, `${EXPERTS_PATH}/${neverId}`, {
    Cookie: cookie,
  });
  assert.equal(neverRes.status, 404, "never-existed UUID DELETE returns 404");
  const neverBody = await neverRes.json();
  assert.deepEqual(
    neverBody,
    { error: "Not found" },
    "same error body shape as cross-tenant",
  );

  db.close();
});

// ─── lt-expert-delete-409-live-children ────────────────────────────────────

/**
 * @description DELETE expert with live campanha child returns 409 Has children; after soft-delete child, DELETE returns 204.
 */
test("lt-expert-delete-409-live-children: live campanha → 409 Has children; after soft-delete child → 204", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-409@example.com",
    name: "Admin 409",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-409-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-with-child",
    nome: "Parent Expert",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-live-child",
    nome: "Live Child",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);
  const path = `${EXPERTS_PATH}/${expert.id}`;

  const blocked = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(blocked.status, 409, "DELETE with live child returns 409");
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error, "Has children");

  const childAfter = db
    .prepare(`SELECT id, deleted_at FROM campanhas WHERE id = ?`)
    .get(campanha.id);
  assert.ok(childAfter);
  assert.equal(
    childAfter.deleted_at,
    null,
    "SELECT campanha by id still has deleted_at IS NULL",
  );

  db.prepare(
    `UPDATE campanhas SET deleted_at = datetime('now') WHERE id = ?`,
  ).run(campanha.id);

  const ok = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(ok.status, 204, "DELETE after soft-delete child returns 204");

  db.close();
});

// ─── lt-expert-list-excludes-deleted ───────────────────────────────────────

/**
 * @description GET /api/empresa/experts lists only live experts (soft-deleted omitted).
 */
test("lt-expert-list-excludes-deleted: live + soft-deleted on A → GET list only live id", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-list@example.com",
    name: "Admin List",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-list-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });

  const live = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-list-live",
    nome: "Live Expert",
  });
  const deleted = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-list-deleted",
    nome: "Deleted Expert",
    deletedAt: "2026-01-01 00:00:00",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const ids = expertIdsFromList(await res.json());

  assert.ok(ids.has(live.id), "list includes live expert id");
  assert.equal(ids.has(deleted.id), false, "list excludes soft-deleted id");
  assert.equal(ids.size, 1, "response lists only the live expert id");

  db.close();
});

// ─── lt-expert-patch-unknown-key-400 ───────────────────────────────────────

/**
 * @description PATCH with unknown key returns 400 and leaves nome unchanged in DB.
 */
test("lt-expert-patch-unknown-key-400: PATCH {nome:'Ok', extra:1} → 400; nome unchanged in DB", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-patch-key@example.com",
    name: "Admin Patch Key",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-patch-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-patch-unknown",
    nome: "Keep Nome",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await patchJson(
    app,
    `${EXPERTS_PATH}/${expert.id}`,
    { nome: "Ok", extra: 1 },
    { Cookie: cookie },
  );
  assert.equal(res.status, 400, "unknown key returns 400");

  const row = expertRow(db, expert.id);
  assert.ok(row);
  assert.equal(row.nome, "Keep Nome", "nome unchanged in DB");

  db.close();
});
