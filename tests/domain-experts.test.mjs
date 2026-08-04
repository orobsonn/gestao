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
const HOME_PATH = "/api/empresa/home";

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
 * @param {{
 *   empresaId: string,
 *   expertId: string,
 *   id?: string,
 *   nome?: string,
 *   tipo?: string,
 *   status?: string,
 * }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const tipo = opts.tipo ?? "gratuito";
  const status = opts.status ?? "aberta";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.empresaId, opts.expertId, nome, tipo, status);
  return {
    id,
    nome,
    tipo,
    status,
    empresaId: opts.empresaId,
    expertId: opts.expertId,
  };
}

/**
 * @description Seed a tarefa under campanha (created_by FK to users required).
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   campanhaId: string,
 *   createdBy: string,
 *   id?: string,
 *   titulo?: string,
 *   notas?: string,
 *   status?: string,
 *   prazo?: string | null,
 *   donoId?: string | null,
 *   deletedAt?: string | null,
 * }} opts
 */
function seedTarefa(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const titulo = opts.titulo ?? "Tarefa Seed";
  const notas = opts.notas ?? "";
  const status = opts.status ?? "a_fazer";
  const prazo = opts.prazo ?? null;
  const donoId = opts.donoId ?? null;
  const deletedAt = opts.deletedAt ?? null;

  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO tarefas
         (id, empresa_id, campanha_id, titulo, notas, status, prazo, dono_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.empresaId,
      opts.campanhaId,
      titulo,
      notas,
      status,
      prazo,
      donoId,
      opts.createdBy,
    );
  } else {
    db.prepare(
      `INSERT INTO tarefas
         (id, empresa_id, campanha_id, titulo, notas, status, prazo, dono_id, created_by, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.empresaId,
      opts.campanhaId,
      titulo,
      notas,
      status,
      prazo,
      donoId,
      opts.createdBy,
      deletedAt,
    );
  }
  return {
    id,
    titulo,
    notas,
    status,
    prazo,
    donoId,
    empresaId: opts.empresaId,
    campanhaId: opts.campanhaId,
    createdBy: opts.createdBy,
    deletedAt,
  };
}

/**
 * @description Evaluate a SQLite date/datetime expression against the open db.
 * @param {DatabaseSync} db
 * @param {string} expr
 * @returns {string}
 */
function sqlDate(db, expr) {
  const row = db.prepare(`SELECT ${expr} AS d`).get();
  assert.ok(row && typeof row.d === "string", `sqlDate(${expr})`);
  return row.d;
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
 * @description Collect expert entries from list response body (array or {experts:[]}).
 * @param {unknown} body
 * @returns {unknown[]}
 */
function expertsFromList(body) {
  assert.ok(body !== null && body !== undefined, "list body present");
  if (Array.isArray(body)) {
    return body;
  }
  if (body && typeof body === "object" && Array.isArray(body.experts)) {
    return body.experts;
  }
  assert.fail("list body must be array or {experts:[]}");
}

/**
 * @description Collect expert ids from list response body (array or {experts:[]}).
 * @param {unknown} body
 * @returns {Set<string>}
 */
function expertIdsFromList(body) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const item of expertsFromList(body)) {
    assert.ok(item && typeof item === "object", "expert entry is object");
    if (typeof item.id === "string") ids.add(item.id);
  }
  return ids;
}

/**
 * @description Find expert row by id in list body; fail if missing.
 * @param {unknown} body
 * @param {string} expertId
 */
function expertFromList(body, expertId) {
  for (const item of expertsFromList(body)) {
    assert.ok(item && typeof item === "object", "expert entry is object");
    if (
      item &&
      typeof item === "object" &&
      "id" in item &&
      item.id === expertId
    ) {
      return item;
    }
  }
  assert.fail(`expert ${expertId} missing from list`);
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

// ─── lt-expert-counts-abertas-atrasadas ────────────────────────────────────

/**
 * @description Expert open/late counts: open-future + open-late + feito → abertas=2, atrasadas=1.
 */
test("lt-expert-counts-abertas-atrasadas: open-future + open-late + feito → E.abertas===2 and E.atrasadas===1", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-ex-counts@example.com",
    name: "Membro Expert Counts",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-counts-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-counts-e",
    nome: "Expert Counts",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-ex-counts",
    nome: "Campanha Counts",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const future = sqlDate(db, `date('now', '+14 days')`);

  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-ex-counts-future",
    titulo: "Open Future",
    status: "a_fazer",
    prazo: future,
  });
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-ex-counts-late",
    titulo: "Open Late",
    status: "fazendo",
    prazo: yesterday,
  });
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-ex-counts-feito",
    titulo: "Done",
    status: "feito",
    prazo: yesterday,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET experts returns 200");
  const body = await res.json();
  const row = expertFromList(body, expert.id);

  assert.equal(row.abertas, 2, "abertas excludes feito; late is subset of open");
  assert.equal(row.atrasadas, 1, "only open-late increments atrasadas");

  db.close();
});

// ─── lt-expert-counts-ignore-campanha-status ───────────────────────────────

/**
 * @description Open task under campanha.status=encerrada still increments abertas/atrasadas.
 */
test("lt-expert-counts-ignore-campanha-status: open task under campanha.status=encerrada still increments abertas (and atrasadas if late)", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-ex-enc@example.com",
    name: "Membro Expert Encerrada",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-enc-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-enc-e",
    nome: "Expert Encerrada",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-ex-enc",
    nome: "Campanha Encerrada",
    status: "encerrada",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);

  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-ex-enc-late",
    titulo: "Open Late Under Encerrada",
    status: "a_fazer",
    prazo: yesterday,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET experts returns 200");
  const body = await res.json();
  const row = expertFromList(body, expert.id);

  assert.equal(
    row.abertas,
    1,
    "open task under encerrada campanha still increments abertas",
  );
  assert.equal(
    row.atrasadas,
    1,
    "late open task under encerrada campanha still increments atrasadas",
  );

  db.close();
});

// ─── lt-expert-counts-exclude-deleted-tarefa ───────────────────────────────

/**
 * @description Soft-deleted open tarefa does not increment abertas or atrasadas.
 */
test("lt-expert-counts-exclude-deleted-tarefa: only soft-deleted open tarefa → E.abertas===0 and E.atrasadas===0", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-ex-del-tar@example.com",
    name: "Membro Expert Del Tar",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-del-tar-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-del-tar-e",
    nome: "Expert Del Tar",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-ex-del-tar",
    nome: "Campanha Del Tar",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);

  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-ex-del-only",
    titulo: "Soft-deleted Open Late",
    status: "a_fazer",
    prazo: yesterday,
    deletedAt: "2026-01-01 00:00:00",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET experts returns 200");
  const body = await res.json();
  const row = expertFromList(body, expert.id);

  assert.equal(row.abertas, 0, "soft-deleted tarefa excluded from abertas");
  assert.equal(row.atrasadas, 0, "soft-deleted tarefa excluded from atrasadas");

  db.close();
});

// ─── lt-expert-counts-home-atrasadas-parity ────────────────────────────────

/**
 * @description Experts list atrasadas matches home charts.atrasadas_por_expert per expert_id (missing=0).
 */
test("lt-expert-counts-home-atrasadas-parity: experts atrasadas equals home charts.atrasadas_por_expert count per expert_id (missing=0)", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-parity@example.com",
    name: "Admin Expert Parity",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-parity-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: admin.id,
    papel: "admin",
  });

  const expertLate = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-parity-late",
    nome: "Expert With Late",
  });
  const expertClean = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-parity-clean",
    nome: "Expert Clean",
  });
  const expertMulti = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-parity-multi",
    nome: "Expert Multi Late",
  });

  const campLate = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertLate.id,
    id: "camp-ex-parity-late",
    nome: "Camp Late",
  });
  const campClean = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertClean.id,
    id: "camp-ex-parity-clean",
    nome: "Camp Clean",
  });
  const campMulti = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertMulti.id,
    id: "camp-ex-parity-multi",
    nome: "Camp Multi",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const future = sqlDate(db, `date('now', '+7 days')`);

  // expertLate: 1 late open
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campLate.id,
    createdBy: admin.id,
    id: "tar-ex-parity-late-1",
    titulo: "Late 1",
    status: "a_fazer",
    prazo: yesterday,
  });
  // expertClean: open future only (no late) — home chart omits; experts atrasadas=0
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campClean.id,
    createdBy: admin.id,
    id: "tar-ex-parity-clean-1",
    titulo: "Future Only",
    status: "a_fazer",
    prazo: future,
  });
  // expertMulti: 2 late open + 1 feito late (feito excluded)
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campMulti.id,
    createdBy: admin.id,
    id: "tar-ex-parity-multi-1",
    titulo: "Multi Late 1",
    status: "a_fazer",
    prazo: yesterday,
  });
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campMulti.id,
    createdBy: admin.id,
    id: "tar-ex-parity-multi-2",
    titulo: "Multi Late 2",
    status: "fazendo",
    prazo: yesterday,
  });
  seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campMulti.id,
    createdBy: admin.id,
    id: "tar-ex-parity-multi-feito",
    titulo: "Multi Feito Late",
    status: "feito",
    prazo: yesterday,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const expertsRes = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(expertsRes.status, 200, "GET experts returns 200");
  const expertsBody = await expertsRes.json();

  const homeRes = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(homeRes.status, 200, "GET home returns 200");
  const homeBody = await homeRes.json();
  assert.ok(homeBody && typeof homeBody === "object");
  assert.ok(homeBody.charts && typeof homeBody.charts === "object");
  assert.ok(
    Array.isArray(homeBody.charts.atrasadas_por_expert),
    "home charts.atrasadas_por_expert is array",
  );

  /** @type {Map<string, number>} */
  const homeByExpert = new Map();
  for (const entry of homeBody.charts.atrasadas_por_expert) {
    assert.ok(entry && typeof entry === "object");
    assert.equal(typeof entry.expert_id, "string");
    assert.equal(typeof entry.count, "number");
    homeByExpert.set(entry.expert_id, entry.count);
  }

  const experts = expertsFromList(expertsBody);
  assert.ok(experts.length >= 3, "list includes seeded experts");

  for (const item of experts) {
    assert.ok(item && typeof item === "object");
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.atrasadas, "number");
    const homeCount = homeByExpert.get(item.id) ?? 0;
    assert.equal(
      item.atrasadas,
      homeCount,
      `expert ${item.id} atrasadas matches home atrasadas_por_expert (missing=0)`,
    );
  }

  // Explicit expected anchors for the seed
  assert.equal(
    expertFromList(expertsBody, expertLate.id).atrasadas,
    1,
    "expertLate atrasadas===1",
  );
  assert.equal(
    expertFromList(expertsBody, expertClean.id).atrasadas,
    0,
    "expertClean atrasadas===0",
  );
  assert.equal(
    expertFromList(expertsBody, expertMulti.id).atrasadas,
    2,
    "expertMulti atrasadas===2",
  );

  db.close();
});

// ─── lt-expert-counts-tenant-isolation ─────────────────────────────────────

/**
 * @description Tasks only on empresa B never appear on A experts list or inflate A's counts.
 */
test("lt-expert-counts-tenant-isolation: tasks only on B + session A → no B expert; A experts abertas/atrasadas===0 for B work", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-ex-iso@example.com",
    name: "Admin Expert Iso",
  });
  const empA = seedEmpresa(db, { id: "emp-ex-iso-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-ex-iso-b", nome: "Empresa B" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: admin.id,
    papel: "admin",
  });
  seedMembership(db, {
    empresaId: empB.id,
    userId: admin.id,
    papel: "admin",
  });

  const expertA = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-iso-a",
    nome: "Expert A",
  });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-iso-b",
    nome: "Expert B",
  });

  // Campanha on A with no tasks — baseline zero counts
  seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertA.id,
    id: "camp-ex-iso-a",
    nome: "Campanha A Empty",
  });

  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-ex-iso-b",
    nome: "Campanha B Work",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const future = sqlDate(db, `date('now', '+3 days')`);

  seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: admin.id,
    id: "tar-ex-iso-b-late",
    titulo: "B Late",
    status: "a_fazer",
    prazo: yesterday,
  });
  seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: admin.id,
    id: "tar-ex-iso-b-open",
    titulo: "B Open",
    status: "fazendo",
    prazo: future,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await getJson(app, EXPERTS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET experts returns 200");
  const body = await res.json();
  const ids = expertIdsFromList(body);

  assert.equal(ids.has(expertB.id), false, "no expert row from B appears");
  assert.ok(ids.has(expertA.id), "A expert is listed");

  const rowA = expertFromList(body, expertA.id);
  assert.equal(rowA.abertas, 0, "A expert abertas===0 for B work");
  assert.equal(rowA.atrasadas, 0, "A expert atrasadas===0 for B work");

  for (const item of expertsFromList(body)) {
    assert.ok(item && typeof item === "object");
    assert.notEqual(
      item.id,
      expertB.id,
      "list must not include B expert id",
    );
  }

  db.close();
});
