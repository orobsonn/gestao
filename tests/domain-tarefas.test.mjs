/**
 * Locked tarefas tenant CRUD contract — any member writes, parent campanha scope, soft-delete, isolation.
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
const TAREFAS_PATH = "/api/empresa/tarefas";

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
 * @description Seed a campanha under expert (composite FK expert_id+empresa_id).
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   expertId: string,
 *   id?: string,
 *   nome?: string,
 *   tipo?: string,
 *   status?: string,
 *   deletedAt?: string | null,
 * }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const tipo = opts.tipo ?? "gratuito";
  const status = opts.status ?? "aberta";
  const deletedAt = opts.deletedAt ?? null;

  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.empresaId, opts.expertId, nome, tipo, status);
  } else {
    db.prepare(
      `INSERT INTO campanhas
         (id, empresa_id, expert_id, nome, tipo, status, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.empresaId, opts.expertId, nome, tipo, status, deletedAt);
  }
  return {
    id,
    nome,
    tipo,
    status,
    empresaId: opts.empresaId,
    expertId: opts.expertId,
    deletedAt,
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
 * @description Read tarefa row by id (or null).
 * @param {DatabaseSync} db
 * @param {string} id
 */
function tarefaRow(db, id) {
  return (
    db
      .prepare(
        `SELECT id, empresa_id, campanha_id, titulo, notas, status,
                prazo, dono_id, created_by, deleted_at
         FROM tarefas WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

/**
 * @description Count tarefas rows for a given campanha_id.
 * @param {DatabaseSync} db
 * @param {string} campanhaId
 */
function countTarefasByCampanha(db, campanhaId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM tarefas WHERE campanha_id = ?`)
    .get(campanhaId);
  return Number(row.c);
}

/**
 * @description Count tarefas rows matching titulo.
 * @param {DatabaseSync} db
 * @param {string} titulo
 */
function countTarefasByTitulo(db, titulo) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM tarefas WHERE titulo = ?`)
    .get(titulo);
  return Number(row.c);
}

/**
 * @description Collect tarefa ids from list response body (array or {tarefas:[]}).
 * @param {unknown} body
 * @returns {Set<string>}
 */
function tarefaIdsFromList(body) {
  assert.ok(body !== null && body !== undefined, "list body present");
  /** @type {unknown[]} */
  let items;
  if (Array.isArray(body)) {
    items = body;
  } else if (
    body &&
    typeof body === "object" &&
    Array.isArray(/** @type {{ tarefas?: unknown }} */ (body).tarefas)
  ) {
    items = /** @type {{ tarefas: unknown[] }} */ (body).tarefas;
  } else {
    assert.fail("list body must be array or {tarefas:[]}");
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const item of items) {
    assert.ok(item && typeof item === "object", "tarefa entry is object");
    if (typeof /** @type {{ id?: unknown }} */ (item).id === "string") {
      ids.add(/** @type {{ id: string }} */ (item).id);
    }
  }
  return ids;
}

/**
 * @description List path under campanha.
 * @param {string} campanhaId
 */
function listUnderCampanhaPath(campanhaId) {
  return `/api/empresa/campanhas/${campanhaId}/tarefas`;
}

// ─── lt-tarefa-membro-create-default-status ────────────────────────────────

/**
 * @description Membro POST tarefa without prazo/status defaults status a_fazer, prazo NULL, created_by=session user, empresa_id=A.
 */
test("lt-tarefa-membro-create-default-status: membro POST {campanha_id, titulo:'T1'} without prazo/status → 201 status a_fazer; DB prazo NULL created_by=session empresa_id=A", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-create@example.com",
    name: "Membro Tar Create",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-create-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-create-e",
    nome: "Expert Create",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-tar-create-c",
    nome: "Campanha C",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await postJson(
    app,
    TAREFAS_PATH,
    {
      campanha_id: campanha.id,
      titulo: "T1",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 201, "create returns 201");
  const body = await res.json();
  assert.ok(body && typeof body === "object", "body is object");
  assert.equal(typeof body.id, "string");
  assert.ok(body.id.length > 0, "body includes id");
  assert.equal(body.status, "a_fazer", "body.status='a_fazer'");

  const row = tarefaRow(db, body.id);
  assert.ok(row, "DB row exists");
  assert.equal(row.status, "a_fazer");
  assert.equal(row.prazo, null, "DB prazo IS NULL");
  assert.equal(row.created_by, membro.id, "created_by equals session user id");
  assert.equal(row.empresa_id, empA.id, "empresa_id=A");
  assert.equal(row.campanha_id, campanha.id);
  assert.equal(row.titulo, "T1");
  assert.equal(row.deleted_at, null);

  db.close();
});

// ─── lt-tarefa-parent-other-tenant-404 ─────────────────────────────────────

/**
 * @description Membro on A cannot create tarefa under campanha owned by B (404 Not found; no insert).
 */
test("lt-tarefa-parent-other-tenant-404: campanha of B + membro A → POST 404 Not found; no tarefas row for that campanha_id", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-parent-b@example.com",
    name: "Membro Parent B",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-par-b-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-tar-par-b-b", nome: "Empresa B" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-tar-owned-by-b",
    nome: "Expert B Parent",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-owned-by-b-parent",
    nome: "Campanha B Parent",
  });

  const beforeCount = countTarefasByCampanha(db, campB.id);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await postJson(
    app,
    TAREFAS_PATH,
    {
      campanha_id: campB.id,
      titulo: "Cross Parent Tarefa",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Not found");

  assert.equal(
    countTarefasByCampanha(db, campB.id),
    beforeCount,
    "no tarefas row inserted for that campanha_id",
  );

  db.close();
});

// ─── lt-tarefa-parent-soft-deleted-404 ─────────────────────────────────────

/**
 * @description POST tarefa under soft-deleted same-tenant campanha returns 404 and no insert.
 */
test("lt-tarefa-parent-soft-deleted-404: soft-deleted campanha on A → POST 404; no insert", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-parent-del@example.com",
    name: "Membro Parent Del",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-par-del-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-par-del-e",
    nome: "Expert Parent Del",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-soft-deleted-parent",
    nome: "Deleted Campanha",
    deletedAt: "2026-01-01 00:00:00",
  });

  const titulo = "Under Deleted Campanha";
  assert.equal(countTarefasByTitulo(db, titulo), 0);
  const beforeCount = countTarefasByCampanha(db, campanha.id);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await postJson(
    app,
    TAREFAS_PATH,
    {
      campanha_id: campanha.id,
      titulo,
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Not found");

  assert.equal(countTarefasByTitulo(db, titulo), 0, "no insert");
  assert.equal(
    countTarefasByCampanha(db, campanha.id),
    beforeCount,
    "no insert for campanha_id",
  );

  db.close();
});

// ─── lt-tarefa-list-under-foreign-or-deleted-campanha-404 ──────────────────

/**
 * @description GET list under B's campanhaId and under soft-deleted same-tenant campanha both return 404 Not found without foreign ids.
 */
test("lt-tarefa-list-under-foreign-or-deleted-campanha-404: GET under B campanha + soft-deleted A campanha → both 404 Not found; no foreign ids", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-list-404@example.com",
    name: "Membro List 404",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-list-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-tar-list-b", nome: "Empresa B" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });

  // User for created_by on B's tarefa (FK)
  const userB = await seedUser(db, {
    email: "user-b-tar-list@example.com",
    name: "User B List",
  });

  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-tar-list-foreign-b",
    nome: "Expert B List",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-foreign-secret-tar",
    nome: "Secret Camp B",
  });
  const tarB = seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: userB.id,
    id: "tar-foreign-secret",
    titulo: "Secret Tarefa B",
  });

  const expertA = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-list-del-a",
    nome: "Expert A List",
  });
  const campDel = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertA.id,
    id: "camp-list-deleted-a",
    nome: "Campanha A Deleted",
    deletedAt: "2026-01-01 00:00:00",
  });
  const tarUnderDel = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campDel.id,
    createdBy: membro.id,
    id: "tar-under-deleted-camp",
    titulo: "Tarefa Under Deleted",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const foreignRes = await getJson(app, listUnderCampanhaPath(campB.id), {
    Cookie: cookie,
  });
  assert.equal(foreignRes.status, 404, "foreign campanha list returns 404");
  const foreignBody = await foreignRes.json();
  assert.deepEqual(foreignBody, { error: "Not found" });
  const foreignSerialized = JSON.stringify(foreignBody);
  assert.equal(
    foreignSerialized.includes(tarB.id),
    false,
    "JSON has no foreign tarefa ids",
  );
  assert.equal(foreignSerialized.includes("Secret Tarefa B"), false);

  const deletedRes = await getJson(app, listUnderCampanhaPath(campDel.id), {
    Cookie: cookie,
  });
  assert.equal(
    deletedRes.status,
    404,
    "soft-deleted campanha list returns 404",
  );
  const deletedBody = await deletedRes.json();
  assert.deepEqual(deletedBody, { error: "Not found" });
  const deletedSerialized = JSON.stringify(deletedBody);
  assert.equal(
    deletedSerialized.includes(tarUnderDel.id),
    false,
    "JSON has no tarefa ids under deleted campanha",
  );

  db.close();
});

// ─── lt-tarefa-patch-dono-status-notas ─────────────────────────────────────

/**
 * @description Membro PATCH dono_id/status/notas on live tarefa updates DB fields.
 */
test("lt-tarefa-patch-dono-status-notas: membro PATCH {dono_id:M, status:'fazendo', notas:'x'} → 200/204; DB dono_id=M status fazendo notas x", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-patch@example.com",
    name: "Membro Tar Patch",
  });
  const memberM = await seedUser(db, {
    email: "member-m-tar@example.com",
    name: "Member M",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-patch-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  seedMembership(db, {
    empresaId: empA.id,
    userId: memberM.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-patch-e",
    nome: "Expert Patch",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-tar-patch-c",
    nome: "Campanha Patch",
  });
  const tarefa = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-patch-dono",
    titulo: "Patch Target",
    notas: "before",
    status: "a_fazer",
  });

  const before = tarefaRow(db, tarefa.id);
  assert.ok(before);
  assert.equal(before.dono_id, null);
  assert.equal(before.status, "a_fazer");
  assert.equal(before.notas, "before");

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);
  const path = `${TAREFAS_PATH}/${tarefa.id}`;

  const res = await patchJson(
    app,
    path,
    { dono_id: memberM.id, status: "fazendo", notas: "x" },
    { Cookie: cookie },
  );
  assert.ok(
    res.status === 200 || res.status === 204,
    `PATCH returns 200 or 204, got ${res.status}`,
  );

  const after = tarefaRow(db, tarefa.id);
  assert.ok(after);
  assert.equal(after.dono_id, memberM.id, "dono_id=M");
  assert.equal(after.status, "fazendo", "status='fazendo'");
  assert.equal(after.notas, "x", "notas='x'");

  db.close();
});

// ─── lt-tarefa-dono-outside-empresa-400 ────────────────────────────────────

/**
 * @description POST or PATCH with dono_id of user outside active empresa returns 400 and does not set dono_id.
 */
test("lt-tarefa-dono-outside-empresa-400: user U no membership on A → PATCH/POST dono_id=U → 400; dono_id not set to U", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-dono-out@example.com",
    name: "Membro Dono Out",
  });
  const userU = await seedUser(db, {
    email: "user-u-outside@example.com",
    name: "User U Outside",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-dono-a", nome: "Empresa A" });
  // userU has NO membership on A
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-dono-e",
    nome: "Expert Dono",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-tar-dono-c",
    nome: "Campanha Dono",
  });
  const tarefa = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-dono-outside",
    titulo: "Dono Outside Target",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const postRes = await postJson(
    app,
    TAREFAS_PATH,
    {
      campanha_id: campanha.id,
      titulo: "With Outside Dono",
      dono_id: userU.id,
    },
    { Cookie: cookie },
  );
  assert.equal(postRes.status, 400, "POST dono_id outside empresa returns 400");

  // If a row was somehow created, dono_id must not be U
  const postCreated = db
    .prepare(`SELECT id, dono_id FROM tarefas WHERE titulo = ?`)
    .get("With Outside Dono");
  if (postCreated) {
    assert.notEqual(
      postCreated.dono_id,
      userU.id,
      "POST dono_id not set to U",
    );
  }

  const before = tarefaRow(db, tarefa.id);
  assert.ok(before);
  assert.equal(before.dono_id, null);

  const patchRes = await patchJson(
    app,
    `${TAREFAS_PATH}/${tarefa.id}`,
    { dono_id: userU.id },
    { Cookie: cookie },
  );
  assert.equal(
    patchRes.status,
    400,
    "PATCH dono_id outside empresa returns 400",
  );

  const after = tarefaRow(db, tarefa.id);
  assert.ok(after);
  assert.notEqual(after.dono_id, userU.id, "dono_id not set to U");
  assert.equal(after.dono_id, null, "dono_id remains unset");

  db.close();
});

// ─── lt-tarefa-delete-idempotent-and-isolation ─────────────────────────────

/**
 * @description DELETE live tarefa is 204 idempotent; list/GET omit; never-existed and cross-tenant DELETE 404 Not found; B deleted_at unchanged.
 */
test("lt-tarefa-delete-idempotent-and-isolation: DELETE×2 → 204; list omits; GET 404; never-existed+B DELETE 404 Not found; B deleted_at unchanged", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-del@example.com",
    name: "Membro Tar Del",
  });
  const userB = await seedUser(db, {
    email: "user-b-tar-del@example.com",
    name: "User B Del",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-del-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-tar-del-b", nome: "Empresa B" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });

  const expertA = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-del-a",
    nome: "Expert A Del",
  });
  const campA = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertA.id,
    id: "camp-tar-del-a",
    nome: "Campanha A Del",
  });
  const tarefaA = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campA.id,
    createdBy: membro.id,
    id: "tar-del-live-a",
    titulo: "To Delete A",
  });

  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-tar-del-b",
    nome: "Expert B Del",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-tar-del-b",
    nome: "Campanha B Del",
  });
  const tarefaB = seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: userB.id,
    id: "tar-del-live-b",
    titulo: "Tarefa B Keep",
  });

  const beforeB = tarefaRow(db, tarefaB.id);
  assert.ok(beforeB);
  assert.equal(beforeB.deleted_at, null);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);
  const pathA = `${TAREFAS_PATH}/${tarefaA.id}`;

  const del1 = await deleteReq(app, pathA, { Cookie: cookie });
  assert.equal(del1.status, 204, "first DELETE returns 204");

  const del2 = await deleteReq(app, pathA, { Cookie: cookie });
  assert.equal(del2.status, 204, "second DELETE returns 204");

  const listRes = await getJson(app, listUnderCampanhaPath(campA.id), {
    Cookie: cookie,
  });
  assert.equal(listRes.status, 200);
  const listIds = tarefaIdsFromList(await listRes.json());
  assert.equal(listIds.has(tarefaA.id), false, "list under campanha omits id");

  const getRes = await getJson(app, pathA, { Cookie: cookie });
  assert.equal(getRes.status, 404, "GET after delete returns 404");

  const neverId = "00000000-0000-4000-8000-000000000099";
  const neverRes = await deleteReq(app, `${TAREFAS_PATH}/${neverId}`, {
    Cookie: cookie,
  });
  assert.equal(neverRes.status, 404, "never-existed UUID DELETE returns 404");
  const neverBody = await neverRes.json();
  assert.deepEqual(neverBody, { error: "Not found" });

  const crossRes = await deleteReq(app, `${TAREFAS_PATH}/${tarefaB.id}`, {
    Cookie: cookie,
  });
  assert.equal(crossRes.status, 404, "tarefa id of B DELETE returns 404");
  const crossBody = await crossRes.json();
  assert.equal(
    crossBody.error,
    "Not found",
    "identical body.error='Not found'",
  );
  assert.deepEqual(
    crossBody,
    { error: "Not found" },
    "same error body shape as never-existed",
  );

  const afterB = tarefaRow(db, tarefaB.id);
  assert.ok(afterB);
  assert.equal(afterB.deleted_at, null, "B deleted_at unchanged");

  db.close();
});

// ─── lt-tarefa-cross-tenant-get-patch-404 ──────────────────────────────────

/**
 * @description Session on A cannot GET/PATCH tarefa of B (404 Not found; no foreign titulo/notas).
 */
test("lt-tarefa-cross-tenant-get-patch-404: tarefa of B + session A → GET/PATCH 404 Not found; no titulo/notas from B", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-xget@example.com",
    name: "Membro Cross Get",
  });
  const userB = await seedUser(db, {
    email: "user-b-tar-xget@example.com",
    name: "User B Cross",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-x-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-tar-x-b", nome: "Empresa B" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-tar-x-b",
    nome: "Expert B Cross",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-tar-x-b",
    nome: "Campanha B Cross",
  });
  const tarB = seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: userB.id,
    id: "tar-owned-by-b",
    titulo: "Secret Tarefa B",
    notas: "secret-notas-b",
  });

  const before = tarefaRow(db, tarB.id);
  assert.ok(before);
  assert.equal(before.titulo, "Secret Tarefa B");
  assert.equal(before.notas, "secret-notas-b");
  assert.equal(before.deleted_at, null);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);
  const path = `${TAREFAS_PATH}/${tarB.id}`;

  const getRes = await getJson(app, path, { Cookie: cookie });
  assert.equal(getRes.status, 404, "GET cross-tenant 404");
  const getBody = await getRes.json();
  assert.equal(getBody.error, "Not found");
  assert.equal("titulo" in getBody, false, "JSON has no foreign titulo");
  assert.equal("notas" in getBody, false, "JSON has no foreign notas");
  const getSerialized = JSON.stringify(getBody);
  assert.equal(getSerialized.includes("Secret Tarefa B"), false);
  assert.equal(getSerialized.includes("secret-notas-b"), false);

  const patchRes = await patchJson(
    app,
    path,
    { titulo: "Hijacked", notas: "leaked" },
    { Cookie: cookie },
  );
  assert.equal(patchRes.status, 404, "PATCH cross-tenant 404");
  const patchBody = await patchRes.json();
  assert.equal(patchBody.error, "Not found");
  assert.equal("titulo" in patchBody, false);
  assert.equal("notas" in patchBody, false);
  const patchSerialized = JSON.stringify(patchBody);
  assert.equal(patchSerialized.includes("Secret Tarefa B"), false);
  assert.equal(patchSerialized.includes("secret-notas-b"), false);

  const after = tarefaRow(db, tarB.id);
  assert.ok(after);
  assert.equal(after.titulo, "Secret Tarefa B", "B row titulo unchanged");
  assert.equal(after.notas, "secret-notas-b", "B row notas unchanged");
  assert.equal(after.deleted_at, null, "B row deleted_at unchanged");

  db.close();
});

// ─── lt-tarefa-patch-unknown-and-clear-prazo ────────────────────────────────

/**
 * @description PATCH unknown key → 400; PATCH {prazo:null} clears prazo in DB.
 */
test("lt-tarefa-patch-unknown-and-clear-prazo: PATCH unknown key → 400; PATCH {prazo:null} → DB prazo IS NULL", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-prazo@example.com",
    name: "Membro Tar Prazo",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-prazo-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-prazo-e",
    nome: "Expert Prazo",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-tar-prazo-c",
    nome: "Campanha Prazo",
  });
  const tarefa = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-prazo-clear",
    titulo: "Prazo Target",
    prazo: "2026-06-15",
  });

  const before = tarefaRow(db, tarefa.id);
  assert.ok(before);
  assert.equal(before.prazo, "2026-06-15");

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);
  const path = `${TAREFAS_PATH}/${tarefa.id}`;

  const unknownRes = await patchJson(
    app,
    path,
    { extra: 1 },
    { Cookie: cookie },
  );
  assert.equal(unknownRes.status, 400, "PATCH unknown key returns 400");

  const mid = tarefaRow(db, tarefa.id);
  assert.ok(mid);
  assert.equal(mid.prazo, "2026-06-15", "prazo unchanged after unknown key");

  const clearRes = await patchJson(
    app,
    path,
    { prazo: null },
    { Cookie: cookie },
  );
  assert.ok(
    clearRes.status === 200 || clearRes.status === 204,
    `clear prazo PATCH returns 200 or 204, got ${clearRes.status}`,
  );

  const after = tarefaRow(db, tarefa.id);
  assert.ok(after);
  assert.equal(after.prazo, null, "DB prazo IS NULL");

  db.close();
});

// ─── lt-tarefa-list-excludes-deleted ───────────────────────────────────────

/**
 * @description GET list under campanha returns only live tarefa ids (soft-deleted omitted).
 */
test("lt-tarefa-list-excludes-deleted: live + soft-deleted on same campanha → GET list only live ids", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-list@example.com",
    name: "Membro Tar List",
  });
  const empA = seedEmpresa(db, { id: "emp-tar-list-ex-a", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-tar-list-ex-e",
    nome: "Expert List Ex",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-tar-list-ex-c",
    nome: "Campanha List Ex",
  });

  const live = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-list-live",
    titulo: "Live Tarefa",
  });
  const deleted = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-list-deleted",
    titulo: "Deleted Tarefa",
    deletedAt: "2026-01-01 00:00:00",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await getJson(app, listUnderCampanhaPath(campanha.id), {
    Cookie: cookie,
  });
  assert.equal(res.status, 200);
  const ids = tarefaIdsFromList(await res.json());

  assert.ok(ids.has(live.id), "list includes live tarefa id");
  assert.equal(ids.has(deleted.id), false, "list excludes soft-deleted id");
  assert.equal(ids.size, 1, "only live ids returned");

  db.close();
});
