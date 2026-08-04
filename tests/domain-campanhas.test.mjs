/**
 * Locked campanhas tenant CRUD contract — admin writes, parent expert scope, soft-delete, isolation.
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
const CAMPANHAS_PATH = "/api/empresa/campanhas";

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
 *   dataInicio?: string | null,
 *   dataFim?: string | null,
 *   notas?: string,
 *   deletedAt?: string | null,
 * }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const tipo = opts.tipo ?? "gratuito";
  const status = opts.status ?? "aberta";
  const dataInicio = opts.dataInicio ?? null;
  const dataFim = opts.dataFim ?? null;
  const notas = opts.notas ?? "";
  const deletedAt = opts.deletedAt ?? null;

  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO campanhas
         (id, empresa_id, expert_id, nome, tipo, status, data_inicio, data_fim, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.empresaId,
      opts.expertId,
      nome,
      tipo,
      status,
      dataInicio,
      dataFim,
      notas,
    );
  } else {
    db.prepare(
      `INSERT INTO campanhas
         (id, empresa_id, expert_id, nome, tipo, status, data_inicio, data_fim, notas, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.empresaId,
      opts.expertId,
      nome,
      tipo,
      status,
      dataInicio,
      dataFim,
      notas,
      deletedAt,
    );
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
 * @description Seed a live tarefa under campanha (created_by FK to users required).
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   campanhaId: string,
 *   createdBy: string,
 *   id?: string,
 *   titulo?: string,
 *   deletedAt?: string | null,
 * }} opts
 */
function seedTarefa(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const titulo = opts.titulo ?? "Tarefa Seed";
  const deletedAt = opts.deletedAt ?? null;
  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO tarefas (id, empresa_id, campanha_id, titulo, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, opts.empresaId, opts.campanhaId, titulo, opts.createdBy);
  } else {
    db.prepare(
      `INSERT INTO tarefas (id, empresa_id, campanha_id, titulo, created_by, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.empresaId,
      opts.campanhaId,
      titulo,
      opts.createdBy,
      deletedAt,
    );
  }
  return {
    id,
    titulo,
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
 * @description Read campanha row by id (or null).
 * @param {DatabaseSync} db
 * @param {string} id
 */
function campanhaRow(db, id) {
  return (
    db
      .prepare(
        `SELECT id, empresa_id, expert_id, nome, tipo, status,
                data_inicio, data_fim, notas, deleted_at
         FROM campanhas WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

/**
 * @description Count campanhas rows for a given expert_id.
 * @param {DatabaseSync} db
 * @param {string} expertId
 */
function countCampanhasByExpert(db, expertId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM campanhas WHERE expert_id = ?`)
    .get(expertId);
  return Number(row.c);
}

/**
 * @description Count campanhas rows matching nome.
 * @param {DatabaseSync} db
 * @param {string} nome
 */
function countCampanhasByNome(db, nome) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM campanhas WHERE nome = ?`)
    .get(nome);
  return Number(row.c);
}

/**
 * @description Collect campanha ids from list response body (array or {campanhas:[]}).
 * @param {unknown} body
 * @returns {Set<string>}
 */
function campanhaIdsFromList(body) {
  assert.ok(body !== null && body !== undefined, "list body present");
  /** @type {unknown[]} */
  let items;
  if (Array.isArray(body)) {
    items = body;
  } else if (
    body &&
    typeof body === "object" &&
    Array.isArray(/** @type {{ campanhas?: unknown }} */ (body).campanhas)
  ) {
    items = /** @type {{ campanhas: unknown[] }} */ (body).campanhas;
  } else {
    assert.fail("list body must be array or {campanhas:[]}");
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const item of items) {
    assert.ok(item && typeof item === "object", "campanha entry is object");
    if (typeof /** @type {{ id?: unknown }} */ (item).id === "string") {
      ids.add(/** @type {{ id: string }} */ (item).id);
    }
  }
  return ids;
}

/**
 * @description Find campanha entry by id in list body.
 * @param {unknown} body
 * @param {string} id
 */
function findCampanhaInList(body, id) {
  assert.ok(body !== null && body !== undefined, "list body present");
  /** @type {unknown[]} */
  let items;
  if (Array.isArray(body)) {
    items = body;
  } else if (
    body &&
    typeof body === "object" &&
    Array.isArray(/** @type {{ campanhas?: unknown }} */ (body).campanhas)
  ) {
    items = /** @type {{ campanhas: unknown[] }} */ (body).campanhas;
  } else {
    assert.fail("list body must be array or {campanhas:[]}");
  }
  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      /** @type {{ id?: unknown }} */ (item).id === id
    ) {
      return item;
    }
  }
  return null;
}

/**
 * @description List path under expert.
 * @param {string} expertId
 */
function listUnderExpertPath(expertId) {
  return `/api/empresa/experts/${expertId}/campanhas`;
}

// ─── lt-campanha-admin-create-list ─────────────────────────────────────────

/**
 * @description Admin POST campanha with optional fields persists them; list under expert includes matching id/fields.
 */
test("lt-campanha-admin-create-list: admin POST full body → 201 persists optional fields; GET under expert includes id+fields", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-create@example.com",
    name: "Admin Camp Create",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-create-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-create-e",
    nome: "Expert E",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const createBody = {
    expert_id: expert.id,
    nome: "C1",
    tipo: "lancamento_pago",
    status: "aberta",
    data_inicio: "2026-01-01",
    data_fim: "2026-02-01",
    notas: "n1",
  };

  const res = await postJson(app, CAMPANHAS_PATH, createBody, {
    Cookie: cookie,
  });
  assert.equal(res.status, 201, "create returns 201");
  const body = await res.json();
  assert.ok(body && typeof body === "object", "body is object");
  assert.equal(typeof body.id, "string");
  assert.ok(body.id.length > 0, "body includes id");

  const row = campanhaRow(db, body.id);
  assert.ok(row, "DB row exists");
  assert.equal(row.empresa_id, empA.id);
  assert.equal(row.expert_id, expert.id);
  assert.equal(row.nome, "C1");
  assert.equal(row.tipo, "lancamento_pago");
  assert.equal(row.status, "aberta");
  assert.equal(row.data_inicio, "2026-01-01");
  assert.equal(row.data_fim, "2026-02-01");
  assert.equal(row.notas, "n1");
  assert.equal(row.deleted_at, null);

  const listRes = await getJson(app, listUnderExpertPath(expert.id), {
    Cookie: cookie,
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  const entry = findCampanhaInList(listBody, body.id);
  assert.ok(entry, "list includes created id");
  assert.equal(/** @type {{ nome?: unknown }} */ (entry).nome, "C1");
  assert.equal(
    /** @type {{ tipo?: unknown }} */ (entry).tipo,
    "lancamento_pago",
  );
  assert.equal(/** @type {{ status?: unknown }} */ (entry).status, "aberta");
  assert.equal(
    /** @type {{ data_inicio?: unknown }} */ (entry).data_inicio,
    "2026-01-01",
  );
  assert.equal(
    /** @type {{ data_fim?: unknown }} */ (entry).data_fim,
    "2026-02-01",
  );
  assert.equal(/** @type {{ notas?: unknown }} */ (entry).notas, "n1");

  db.close();
});

// ─── lt-campanha-default-status-aberta ─────────────────────────────────────

/**
 * @description Admin create without status field persists status equals 'aberta'.
 */
test("lt-campanha-default-status-aberta: admin POST without status → persisted status equals 'aberta'", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-default@example.com",
    name: "Admin Camp Default",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-def-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-def-e",
    nome: "Expert Default",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await postJson(
    app,
    CAMPANHAS_PATH,
    {
      expert_id: expert.id,
      nome: "No Status",
      tipo: "gratuito",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 201, "create returns 201");
  const body = await res.json();
  assert.ok(body && typeof body === "object");
  assert.equal(typeof body.id, "string");

  const row = campanhaRow(db, body.id);
  assert.ok(row);
  assert.equal(row.status, "aberta", "persisted status equals 'aberta'");

  db.close();
});

// ─── lt-campanha-membro-create-403 ─────────────────────────────────────────

/**
 * @description Membro session cannot POST /api/empresa/campanhas (403; no row inserted).
 */
test("lt-campanha-membro-create-403: membro POST valid body → 403; no campanhas row inserted", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-camp-create@example.com",
    name: "Membro Camp Create",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-membro-c", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-membro-c",
    nome: "Expert Membro Create",
  });

  const nome = "Membro Nope Camp";
  assert.equal(countCampanhasByNome(db, nome), 0);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);

  const res = await postJson(
    app,
    CAMPANHAS_PATH,
    {
      expert_id: expert.id,
      nome,
      tipo: "gratuito",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 403, "membro create forbidden");
  const body = await res.json();
  assert.ok(body && typeof body === "object", "body is object");
  assert.ok("error" in body && body.error, "body.error is present");

  assert.equal(
    countCampanhasByNome(db, nome),
    0,
    "no campanhas row inserted",
  );

  db.close();
});

// ─── lt-campanha-membro-patch-delete-403 ───────────────────────────────────

/**
 * @description Membro cannot PATCH or DELETE a live campanha of active empresa (403; row unchanged).
 */
test("lt-campanha-membro-patch-delete-403: membro PATCH+DELETE live campanha → both 403 body.error; nome/deleted_at unchanged", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-camp-write@example.com",
    name: "Membro Camp Write",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-membro-w", nome: "Empresa A" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-membro-w",
    nome: "Expert Membro Write",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-membro-guard",
    nome: "Original Nome",
  });

  const before = campanhaRow(db, campanha.id);
  assert.ok(before);
  assert.equal(before.nome, "Original Nome");
  assert.equal(before.deleted_at, null);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, empA.id);
  const path = `${CAMPANHAS_PATH}/${campanha.id}`;

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

  const after = campanhaRow(db, campanha.id);
  assert.ok(after);
  assert.equal(after.nome, "Original Nome", "nome unchanged");
  assert.equal(after.deleted_at, null, "deleted_at unchanged");

  db.close();
});

// ─── lt-campanha-parent-other-tenant-404 ───────────────────────────────────

/**
 * @description Admin on A cannot create campanha under expert owned by B (404 Not found; count unchanged).
 */
test("lt-campanha-parent-other-tenant-404: admin A + expert of B → POST 404 Not found; COUNT for expert_id unchanged", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-parent-b@example.com",
    name: "Admin Parent B",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-par-b-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-camp-par-b-b", nome: "Empresa B" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-owned-by-b-parent",
    nome: "Expert B Parent",
  });

  const beforeCount = countCampanhasByExpert(db, expertB.id);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await postJson(
    app,
    CAMPANHAS_PATH,
    {
      expert_id: expertB.id,
      nome: "Cross Parent",
      tipo: "gratuito",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Not found");

  assert.equal(
    countCampanhasByExpert(db, expertB.id),
    beforeCount,
    "COUNT campanhas for that expert_id stays unchanged",
  );

  db.close();
});

// ─── lt-campanha-parent-soft-deleted-404 ───────────────────────────────────

/**
 * @description POST campanha under soft-deleted same-tenant expert returns 404 and no insert.
 */
test("lt-campanha-parent-soft-deleted-404: soft-deleted expert on A → POST 404; no insert", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-parent-del@example.com",
    name: "Admin Parent Del",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-par-del-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-soft-deleted-parent",
    nome: "Deleted Expert",
    deletedAt: "2026-01-01 00:00:00",
  });

  const nome = "Under Deleted Expert";
  assert.equal(countCampanhasByNome(db, nome), 0);
  const beforeCount = countCampanhasByExpert(db, expert.id);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await postJson(
    app,
    CAMPANHAS_PATH,
    {
      expert_id: expert.id,
      nome,
      tipo: "gratuito",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Not found");

  assert.equal(countCampanhasByNome(db, nome), 0, "no insert");
  assert.equal(
    countCampanhasByExpert(db, expert.id),
    beforeCount,
    "no insert for expert_id",
  );

  db.close();
});

// ─── lt-campanha-list-under-foreign-or-deleted-expert-404 ──────────────────

/**
 * @description GET list under B's expertId and under soft-deleted same-tenant expert both return 404 Not found without foreign ids.
 */
test("lt-campanha-list-under-foreign-or-deleted-expert-404: GET under B expert + soft-deleted A expert → both 404 Not found; no foreign ids", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-list-404@example.com",
    name: "Admin List 404",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-list-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-camp-list-b", nome: "Empresa B" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });

  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-list-foreign-b",
    nome: "Expert B List",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-foreign-secret",
    nome: "Secret Camp B",
  });

  const expertDel = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-list-deleted-a",
    nome: "Expert A Deleted",
    deletedAt: "2026-01-01 00:00:00",
  });
  const campUnderDel = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertDel.id,
    id: "camp-under-deleted-ex",
    nome: "Camp Under Deleted",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const foreignRes = await getJson(app, listUnderExpertPath(expertB.id), {
    Cookie: cookie,
  });
  assert.equal(foreignRes.status, 404, "foreign expert list returns 404");
  const foreignBody = await foreignRes.json();
  assert.deepEqual(foreignBody, { error: "Not found" });
  const foreignSerialized = JSON.stringify(foreignBody);
  assert.equal(
    foreignSerialized.includes(campB.id),
    false,
    "JSON has no foreign campanha ids",
  );
  assert.equal(foreignSerialized.includes("Secret Camp B"), false);

  const deletedRes = await getJson(app, listUnderExpertPath(expertDel.id), {
    Cookie: cookie,
  });
  assert.equal(deletedRes.status, 404, "soft-deleted expert list returns 404");
  const deletedBody = await deletedRes.json();
  assert.deepEqual(deletedBody, { error: "Not found" });
  const deletedSerialized = JSON.stringify(deletedBody);
  assert.equal(
    deletedSerialized.includes(campUnderDel.id),
    false,
    "JSON has no campanha ids under deleted expert",
  );

  db.close();
});

// ─── lt-campanha-invalid-tipo-400 ──────────────────────────────────────────

/**
 * @description Admin POST with tipo='invalido' returns 400 with body.error present.
 */
test("lt-campanha-invalid-tipo-400: admin POST tipo='invalido' → 400 body.error present", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-tipo@example.com",
    name: "Admin Camp Tipo",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-tipo-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-tipo-e",
    nome: "Expert Tipo",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);

  const res = await postJson(
    app,
    CAMPANHAS_PATH,
    {
      expert_id: expert.id,
      nome: "Bad Tipo",
      tipo: "invalido",
    },
    { Cookie: cookie },
  );
  assert.equal(res.status, 400, "invalid tipo returns 400");
  const body = await res.json();
  assert.ok(body && typeof body === "object");
  assert.ok("error" in body && body.error, "body.error is present");

  db.close();
});

// ─── lt-campanha-cross-tenant-get-patch-delete-404 ─────────────────────────

/**
 * @description Admin on A cannot GET/PATCH/DELETE campanha of B (404 Not found; B row unchanged; no foreign fields).
 */
test("lt-campanha-cross-tenant-get-patch-delete-404: campanha of B + admin A → GET/PATCH/DELETE 404 Not found; B unchanged; no foreign fields", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-xwrite@example.com",
    name: "Admin Camp Cross",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-x-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-camp-x-b", nome: "Empresa B" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-camp-x-b",
    nome: "Expert B Cross",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-owned-by-b",
    nome: "Secret Campanha B",
    tipo: "perpetuo",
  });

  const before = campanhaRow(db, campB.id);
  assert.ok(before);
  assert.equal(before.nome, "Secret Campanha B");
  assert.equal(before.tipo, "perpetuo");
  assert.equal(before.deleted_at, null);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);
  const path = `${CAMPANHAS_PATH}/${campB.id}`;

  const getRes = await getJson(app, path, { Cookie: cookie });
  assert.equal(getRes.status, 404, "GET cross-tenant 404");
  const getBody = await getRes.json();
  assert.equal(getBody.error, "Not found");
  assert.equal("nome" in getBody, false, "JSON has no foreign nome");
  assert.equal("tipo" in getBody, false, "JSON has no foreign tipo");
  const getSerialized = JSON.stringify(getBody);
  assert.equal(getSerialized.includes("Secret Campanha B"), false);
  assert.equal(getSerialized.includes("perpetuo"), false);

  const patchRes = await patchJson(
    app,
    path,
    { nome: "Hijacked" },
    { Cookie: cookie },
  );
  assert.equal(patchRes.status, 404, "PATCH cross-tenant 404");
  const patchBody = await patchRes.json();
  assert.equal(patchBody.error, "Not found");
  assert.equal("nome" in patchBody, false);
  assert.equal("tipo" in patchBody, false);

  const delRes = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(delRes.status, 404, "DELETE cross-tenant 404");
  const delBody = await delRes.json();
  assert.equal(delBody.error, "Not found");
  assert.equal("nome" in delBody, false);
  assert.equal("tipo" in delBody, false);

  const after = campanhaRow(db, campB.id);
  assert.ok(after);
  assert.equal(after.nome, "Secret Campanha B", "B row nome unchanged");
  assert.equal(after.tipo, "perpetuo", "B row tipo unchanged");
  assert.equal(after.deleted_at, null, "B row deleted_at unchanged");

  db.close();
});

// ─── lt-campanha-delete-409-and-tombstone ──────────────────────────────────

/**
 * @description DELETE campanha with live tarefa child returns 409 Has children; after soft-delete tarefa, DELETE 204 idempotent; never-existed UUID 404.
 * Child check via SQL SELECT tarefa deleted_at IS NULL (not HTTP).
 */
test("lt-campanha-delete-409-and-tombstone: live tarefa → 409 Has children; after soft-delete tarefa → DELETE 204×2; never-existed UUID 404", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-409@example.com",
    name: "Admin Camp 409",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-409-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-409-e",
    nome: "Expert 409",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-with-tarefa",
    nome: "Parent Campanha",
  });
  // Seed tarefa needs user for created_by FK
  const tarefa = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campanha.id,
    createdBy: admin.id,
    id: "tar-live-child",
    titulo: "Live Child Tarefa",
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);
  const path = `${CAMPANHAS_PATH}/${campanha.id}`;

  const blocked = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(blocked.status, 409, "DELETE with live tarefa returns 409");
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error, "Has children");

  const childAfter = db
    .prepare(`SELECT id, deleted_at FROM tarefas WHERE id = ?`)
    .get(tarefa.id);
  assert.ok(childAfter);
  assert.equal(
    childAfter.deleted_at,
    null,
    "SELECT tarefa by id still has deleted_at IS NULL",
  );

  db.prepare(
    `UPDATE tarefas SET deleted_at = datetime('now') WHERE id = ?`,
  ).run(tarefa.id);

  const del1 = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(del1.status, 204, "DELETE after soft-delete tarefa returns 204");

  const del2 = await deleteReq(app, path, { Cookie: cookie });
  assert.equal(del2.status, 204, "second DELETE returns 204");

  const neverId = "00000000-0000-4000-8000-000000000099";
  const neverRes = await deleteReq(app, `${CAMPANHAS_PATH}/${neverId}`, {
    Cookie: cookie,
  });
  assert.equal(neverRes.status, 404, "never-existed UUID DELETE returns 404");
  const neverBody = await neverRes.json();
  assert.deepEqual(neverBody, { error: "Not found" });

  db.close();
});

// ─── lt-campanha-patch-allowlist ───────────────────────────────────────────

/**
 * @description PATCH expert_id or unknown key → 400; PATCH {notas:'z', data_inicio:null} clears date and sets notas.
 */
test("lt-campanha-patch-allowlist: PATCH expert_id/unknown → 400; PATCH {notas:'z', data_inicio:null} → notas='z' data_inicio NULL", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-camp-patch@example.com",
    name: "Admin Camp Patch",
  });
  const empA = seedEmpresa(db, { id: "emp-camp-patch-a", nome: "Empresa A" });
  seedMembership(db, { empresaId: empA.id, userId: admin.id, papel: "admin" });
  const expert = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-camp-patch-e",
    nome: "Expert Patch",
  });
  const campanha = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expert.id,
    id: "camp-patch-allow",
    nome: "Patch Target",
    dataInicio: "2026-03-01",
    notas: "before",
  });

  const before = campanhaRow(db, campanha.id);
  assert.ok(before);
  assert.equal(before.data_inicio, "2026-03-01");
  assert.equal(before.notas, "before");
  assert.equal(before.expert_id, expert.id);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, empA.id);
  const path = `${CAMPANHAS_PATH}/${campanha.id}`;

  const reparentRes = await patchJson(
    app,
    path,
    { expert_id: "x" },
    { Cookie: cookie },
  );
  assert.equal(reparentRes.status, 400, "PATCH expert_id returns 400");

  const unknownRes = await patchJson(
    app,
    path,
    { extra: 1 },
    { Cookie: cookie },
  );
  assert.equal(unknownRes.status, 400, "PATCH unknown key returns 400");

  const mid = campanhaRow(db, campanha.id);
  assert.ok(mid);
  assert.equal(mid.expert_id, expert.id, "expert_id unchanged after forbidden patches");
  assert.equal(mid.notas, "before");
  assert.equal(mid.data_inicio, "2026-03-01");

  const okRes = await patchJson(
    app,
    path,
    { notas: "z", data_inicio: null },
    { Cookie: cookie },
  );
  assert.ok(
    okRes.status === 200 || okRes.status === 204,
    `allowlist PATCH returns 200 or 204, got ${okRes.status}`,
  );

  const after = campanhaRow(db, campanha.id);
  assert.ok(after);
  assert.equal(after.notas, "z", "notas='z'");
  assert.equal(after.data_inicio, null, "data_inicio is NULL in DB");
  assert.equal(after.expert_id, expert.id, "expert_id still unchanged");

  db.close();
});
