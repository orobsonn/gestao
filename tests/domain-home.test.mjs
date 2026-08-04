/**
 * @description Locked GET /api/empresa/home + status-only PATCH updated_at contract.
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
const HOME_PATH = "/api/empresa/home";
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
 * @description Seed a tarefa under campanha; optional updatedAt override for feitas_7d fixtures.
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
 *   updatedAt?: string | null,
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
  const updatedAt = opts.updatedAt ?? null;

  if (deletedAt === null && updatedAt === null) {
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
  } else if (deletedAt === null && updatedAt !== null) {
    db.prepare(
      `INSERT INTO tarefas
         (id, empresa_id, campanha_id, titulo, notas, status, prazo, dono_id, created_by, updated_at)
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
      updatedAt,
    );
  } else if (deletedAt !== null && updatedAt === null) {
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
  } else {
    db.prepare(
      `INSERT INTO tarefas
         (id, empresa_id, campanha_id, titulo, notas, status, prazo, dono_id, created_by, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      updatedAt,
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
    updatedAt,
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
 * @description Read SQLite date/datetime expression as string.
 * @param {DatabaseSync} db
 * @param {string} expr SQL expression e.g. date('now','-1 day')
 */
function sqlDate(db, expr) {
  const row = db.prepare(`SELECT ${expr} AS d`).get();
  assert.ok(row && typeof row.d === "string", `sql date ${expr}`);
  return row.d;
}

/**
 * @description Read tarefa updated_at by id.
 * @param {DatabaseSync} db
 * @param {string} id
 */
function tarefaUpdatedAt(db, id) {
  const row = db
    .prepare(`SELECT updated_at FROM tarefas WHERE id = ?`)
    .get(id);
  return row ? String(row.updated_at) : null;
}

/**
 * @description Find chart bucket/key count in array of {bucket|key, count}.
 * @param {unknown} series
 * @param {string} field 'bucket' | 'key'
 * @param {string} name
 */
function chartCount(series, field, name) {
  assert.ok(Array.isArray(series), "chart series is array");
  const entry = series.find(
    (item) =>
      item &&
      typeof item === "object" &&
      /** @type {Record<string, unknown>} */ (item)[field] === name,
  );
  assert.ok(entry, `chart entry ${field}=${name}`);
  const count = /** @type {{ count?: unknown }} */ (entry).count;
  assert.equal(typeof count, "number", `count for ${name} is number`);
  return /** @type {number} */ (count);
}

// ─── lt-membro-fail-closed ─────────────────────────────────────────────────

/**
 * @description Membro home fail-closed: empresa KPIs zero, empty empresa lists/expert chart, meu_trabalho only own.
 */
test("lt-membro-fail-closed: membro GET /api/empresa/home → 200 papel=membro; empresa_abertas=[]; atrasadas_por_expert=[]; empresa KPIs 0; meu_trabalho only viewer dono", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    id: "user-home-membro-fc",
    email: "membro-home-fc@example.com",
    name: "Membro Home FC",
  });
  const other = await seedUser(db, {
    id: "user-home-other-fc",
    email: "other-home-fc@example.com",
    name: "Other Home FC",
  });
  const emp = seedEmpresa(db, { id: "emp-home-fc", nome: "Empresa Home FC" });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: other.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-home-fc",
    nome: "Expert FC",
  });
  const campanha = seedCampanha(db, {
    empresaId: emp.id,
    expertId: expert.id,
    id: "camp-home-fc",
    nome: "Campanha FC",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const today = sqlDate(db, `date('now')`);

  // Open tasks owned by other members (must not leak into membro empresa views)
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: other.id,
    id: "tar-home-fc-other-late",
    titulo: "Other Late",
    status: "a_fazer",
    prazo: yesterday,
    donoId: other.id,
  });
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: other.id,
    id: "tar-home-fc-other-today",
    titulo: "Other Today",
    status: "fazendo",
    prazo: today,
    donoId: other.id,
  });
  // Open task owned by viewer
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-home-fc-mine",
    titulo: "Mine Open",
    status: "a_fazer",
    prazo: today,
    donoId: membro.id,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const res = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET home returns 200");
  const body = await res.json();
  assert.ok(body && typeof body === "object", "body is object");

  assert.equal(body.papel, "membro", "body.papel==='membro'");
  assert.equal(body.viewer_user_id, membro.id, "viewer_user_id is session user");

  assert.ok(Array.isArray(body.empresa_abertas), "empresa_abertas is array");
  assert.deepEqual(body.empresa_abertas, [], "empresa_abertas equals []");

  assert.ok(body.charts && typeof body.charts === "object", "charts present");
  assert.ok(
    Array.isArray(body.charts.atrasadas_por_expert),
    "atrasadas_por_expert is array",
  );
  assert.deepEqual(
    body.charts.atrasadas_por_expert,
    [],
    "charts.atrasadas_por_expert equals []",
  );

  assert.ok(body.kpis && typeof body.kpis === "object", "kpis present");
  assert.equal(body.kpis.atrasadas_empresa, 0, "kpis.atrasadas_empresa===0");
  assert.equal(
    body.kpis.vencem_hoje_empresa,
    0,
    "kpis.vencem_hoje_empresa===0",
  );
  assert.equal(body.kpis.abertas_empresa, 0, "kpis.abertas_empresa===0");
  assert.equal(body.kpis.feitas_7d_empresa, 0, "kpis.feitas_7d_empresa===0");

  assert.ok(Array.isArray(body.meu_trabalho), "meu_trabalho is array");
  assert.ok(body.meu_trabalho.length >= 1, "meu_trabalho has viewer tasks");
  for (const item of body.meu_trabalho) {
    assert.ok(item && typeof item === "object", "meu_trabalho entry object");
    assert.equal(
      item.dono_id,
      body.viewer_user_id,
      "every meu_trabalho[].dono_id equals viewer_user_id",
    );
  }

  db.close();
});

// ─── lt-membro-late-first-and-personal-charts ──────────────────────────────

/**
 * @description Membro late-first ordering and personal-only urgencia/status chart scope.
 */
test("lt-membro-late-first-and-personal-charts: membro with late+future own tasks → meu_trabalho[0] atrasada first; charts only dono=viewer", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    id: "user-home-membro-late",
    email: "membro-home-late@example.com",
    name: "Membro Home Late",
  });
  const other = await seedUser(db, {
    id: "user-home-other-late",
    email: "other-home-late@example.com",
    name: "Other Home Late",
  });
  const emp = seedEmpresa(db, {
    id: "emp-home-late",
    nome: "Empresa Home Late",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: other.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-home-late",
    nome: "Expert Late",
  });
  const campanha = seedCampanha(db, {
    empresaId: emp.id,
    expertId: expert.id,
    id: "camp-home-late",
    nome: "Campanha Late",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const future = sqlDate(db, `date('now', '+14 days')`);

  const mineLate = seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-home-late-mine-late",
    titulo: "Z Mine Late",
    status: "a_fazer",
    prazo: yesterday,
    donoId: membro.id,
  });
  const mineFuture = seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: membro.id,
    id: "tar-home-late-mine-future",
    titulo: "A Mine Future",
    status: "fazendo",
    prazo: future,
    donoId: membro.id,
  });
  // Other member open late — must not inflate membro charts
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: other.id,
    id: "tar-home-late-other",
    titulo: "Other Late Many",
    status: "a_fazer",
    prazo: yesterday,
    donoId: other.id,
  });
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: other.id,
    id: "tar-home-late-other-2",
    titulo: "Other Future",
    status: "a_fazer",
    prazo: future,
    donoId: other.id,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const res = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET home returns 200");
  const body = await res.json();
  assert.ok(body && typeof body === "object");
  assert.equal(body.papel, "membro");

  assert.ok(Array.isArray(body.meu_trabalho), "meu_trabalho is array");
  assert.ok(
    body.meu_trabalho.length >= 2,
    "meu_trabalho has both own open tasks",
  );

  const first = body.meu_trabalho[0];
  assert.ok(first && typeof first === "object");
  assert.equal(first.atrasada, true, "meu_trabalho[0].atrasada===true");
  assert.equal(first.id, mineLate.id, "late task is first");

  const ids = body.meu_trabalho.map((/** @type {{ id: string }} */ t) => t.id);
  const lateIdx = ids.indexOf(mineLate.id);
  const futureIdx = ids.indexOf(mineFuture.id);
  assert.ok(lateIdx >= 0, "late task in meu_trabalho");
  assert.ok(futureIdx >= 0, "future task in meu_trabalho");
  assert.ok(
    lateIdx < futureIdx,
    "late task appears before the non-late task",
  );

  // charts.urgencia / status reflect only dono=viewer (2 open own: 1 atrasada, 1 depois)
  assert.ok(body.charts && typeof body.charts === "object");
  assert.ok(Array.isArray(body.charts.urgencia), "charts.urgencia is array");
  assert.ok(Array.isArray(body.charts.status), "charts.status is array");

  const urgAtrasadas = chartCount(body.charts.urgencia, "bucket", "atrasadas");
  const urgHoje = chartCount(body.charts.urgencia, "bucket", "hoje");
  const urgSemana = chartCount(body.charts.urgencia, "bucket", "semana");
  const urgDepois = chartCount(body.charts.urgencia, "bucket", "depois");

  assert.equal(
    urgAtrasadas,
    1,
    "urgencia atrasadas count = 1 (viewer only, not other members)",
  );
  assert.equal(urgHoje, 0, "urgencia hoje = 0 for viewer scope");
  assert.equal(urgSemana, 0, "urgencia semana = 0 for viewer scope");
  assert.equal(
    urgDepois,
    1,
    "urgencia depois = 1 (viewer future only, not other members)",
  );

  const stAtrasada = chartCount(body.charts.status, "key", "atrasada");
  const stAFazer = chartCount(body.charts.status, "key", "a_fazer");
  const stFazendo = chartCount(body.charts.status, "key", "fazendo");
  const stFeito = chartCount(body.charts.status, "key", "feito");

  assert.equal(
    stAtrasada,
    1,
    "status atrasada = 1 (viewer late only)",
  );
  // mine future is fazendo + not late → fazendo; no non-late a_fazer for viewer
  assert.equal(stAFazer, 0, "status a_fazer non-late viewer = 0");
  assert.equal(stFazendo, 1, "status fazendo non-late viewer = 1");
  assert.equal(stFeito, 0, "status feito viewer = 0");

  // Sanity: if other members leaked, atrasadas would be >= 2
  assert.ok(
    urgAtrasadas < 2,
    "charts must not include other members' late tasks",
  );

  db.close();
});

// ─── lt-admin-kpis-charts-both-lists ───────────────────────────────────────

/**
 * @description Admin home returns empresa KPIs/charts, both lists, and personal meu_trabalho only.
 */
test("lt-admin-kpis-charts-both-lists: admin GET home → papel=admin; seeded KPIs; four urgencia+status buckets; empresa_abertas>=1; meu_trabalho only viewer open", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    id: "user-home-admin-kpis",
    email: "admin-home-kpis@example.com",
    name: "Admin Home KPIs",
  });
  const member = await seedUser(db, {
    id: "user-home-member-kpis",
    email: "member-home-kpis@example.com",
    name: "Member Home KPIs",
  });
  const emp = seedEmpresa(db, {
    id: "emp-home-kpis",
    nome: "Empresa Home KPIs",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: admin.id,
    papel: "admin",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: member.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-home-kpis",
    nome: "Expert KPIs",
  });
  const campanha = seedCampanha(db, {
    empresaId: emp.id,
    expertId: expert.id,
    id: "camp-home-kpis",
    nome: "Campanha KPIs",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const today = sqlDate(db, `date('now')`);
  const future = sqlDate(db, `date('now', '+3 days')`);
  const recentUpdated = sqlDate(db, `datetime('now', '-2 days')`);

  // Open empresa task not owned by admin
  const otherOpen = seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: member.id,
    id: "tar-home-kpis-other-open",
    titulo: "Other Open Empresa",
    status: "a_fazer",
    prazo: yesterday,
    donoId: member.id,
  });
  // Personal open tasks for admin
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: admin.id,
    id: "tar-home-kpis-admin-today",
    titulo: "Admin Today",
    status: "fazendo",
    prazo: today,
    donoId: admin.id,
  });
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: admin.id,
    id: "tar-home-kpis-admin-future",
    titulo: "Admin Future",
    status: "a_fazer",
    prazo: future,
    donoId: admin.id,
  });
  // Live feito with updated_at within 7 days
  seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: member.id,
    id: "tar-home-kpis-feito-7d",
    titulo: "Feito Recent",
    status: "feito",
    prazo: null,
    donoId: member.id,
    updatedAt: recentUpdated,
  });

  // Seeded definitions (empresa-wide open live):
  // open: otherOpen (late), admin today, admin future → abertas_empresa = 3
  // atrasadas_empresa = 1 (otherOpen)
  // vencem_hoje_empresa = 1 (admin today)
  // minhas_abertas = 2 (admin today + future)
  // feitas_7d_empresa = 1
  const expectedAtrasadasEmpresa = 1;
  const expectedVencemHojeEmpresa = 1;
  const expectedMinhasAbertas = 2;
  const expectedFeitas7dEmpresa = 1;

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET home returns 200");
  const body = await res.json();
  assert.ok(body && typeof body === "object");

  assert.equal(body.papel, "admin", "body.papel==='admin'");
  assert.equal(body.viewer_user_id, admin.id);

  assert.ok(body.kpis && typeof body.kpis === "object");
  assert.equal(
    typeof body.kpis.atrasadas_empresa,
    "number",
    "kpis.atrasadas_empresa is number",
  );
  assert.equal(
    typeof body.kpis.vencem_hoje_empresa,
    "number",
    "kpis.vencem_hoje_empresa is number",
  );
  assert.equal(
    typeof body.kpis.minhas_abertas,
    "number",
    "kpis.minhas_abertas is number",
  );
  assert.equal(
    typeof body.kpis.feitas_7d_empresa,
    "number",
    "kpis.feitas_7d_empresa is number",
  );

  assert.equal(
    body.kpis.atrasadas_empresa,
    expectedAtrasadasEmpresa,
    "kpis.atrasadas_empresa matches seed",
  );
  assert.equal(
    body.kpis.vencem_hoje_empresa,
    expectedVencemHojeEmpresa,
    "kpis.vencem_hoje_empresa matches seed",
  );
  assert.equal(
    body.kpis.minhas_abertas,
    expectedMinhasAbertas,
    "kpis.minhas_abertas matches seed",
  );
  assert.equal(
    body.kpis.feitas_7d_empresa,
    expectedFeitas7dEmpresa,
    "kpis.feitas_7d_empresa matches seed",
  );

  assert.ok(body.charts && typeof body.charts === "object");
  assert.ok(Array.isArray(body.charts.urgencia), "charts.urgencia is array");
  assert.equal(
    body.charts.urgencia.length,
    4,
    "charts.urgencia has four buckets",
  );
  const urgBuckets = body.charts.urgencia.map(
    (/** @type {{ bucket: string }} */ e) => e.bucket,
  );
  assert.deepEqual(
    [...urgBuckets].sort(),
    ["atrasadas", "depois", "hoje", "semana"].sort(),
    "urgencia buckets atrasadas|hoje|semana|depois",
  );
  for (const entry of body.charts.urgencia) {
    assert.equal(typeof entry.count, "number", "urgencia count is number");
  }

  assert.ok(Array.isArray(body.charts.status), "charts.status is array");
  assert.equal(body.charts.status.length, 4, "charts.status has four keys");
  const statusKeys = body.charts.status.map(
    (/** @type {{ key: string }} */ e) => e.key,
  );
  assert.deepEqual(
    [...statusKeys].sort(),
    ["a_fazer", "atrasada", "fazendo", "feito"].sort(),
    "status keys atrasada|a_fazer|fazendo|feito",
  );
  for (const entry of body.charts.status) {
    assert.equal(typeof entry.count, "number", "status count is number");
  }

  assert.ok(Array.isArray(body.empresa_abertas), "empresa_abertas is array");
  assert.ok(
    body.empresa_abertas.length >= 1,
    "empresa_abertas length >= 1",
  );
  const empresaIds = new Set(
    body.empresa_abertas.map((/** @type {{ id: string }} */ t) => t.id),
  );
  assert.ok(
    empresaIds.has(otherOpen.id),
    "empresa_abertas includes non-admin-owned open task",
  );

  assert.ok(Array.isArray(body.meu_trabalho), "meu_trabalho is array");
  for (const item of body.meu_trabalho) {
    assert.equal(
      item.dono_id,
      admin.id,
      "meu_trabalho contains only dono=viewer",
    );
    assert.notEqual(item.status, "feito", "meu_trabalho is open-only");
  }
  const meuIds = body.meu_trabalho.map(
    (/** @type {{ id: string }} */ t) => t.id,
  );
  assert.ok(!meuIds.includes(otherOpen.id), "other open not in meu_trabalho");

  db.close();
});

// ─── lt-tenant-isolation-home ──────────────────────────────────────────────

/**
 * @description Home payload never leaks tarefa ids or aggregates from another empresa.
 */
test("lt-tenant-isolation-home: active on A while B has open tarefas → no B ids in lists; aggregates scoped to A only", async () => {
  const db = openDb();
  const user = await seedUser(db, {
    id: "user-home-iso",
    email: "user-home-iso@example.com",
    name: "User Home Iso",
  });
  const empA = seedEmpresa(db, { id: "emp-home-iso-a", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-home-iso-b", nome: "Empresa B" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: user.id,
    papel: "admin",
  });
  seedMembership(db, {
    empresaId: empB.id,
    userId: user.id,
    papel: "admin",
  });

  const expertA = seedExpert(db, {
    empresaId: empA.id,
    id: "ex-home-iso-a",
    nome: "Expert A",
  });
  const expertB = seedExpert(db, {
    empresaId: empB.id,
    id: "ex-home-iso-b",
    nome: "Expert B",
  });
  const campA = seedCampanha(db, {
    empresaId: empA.id,
    expertId: expertA.id,
    id: "camp-home-iso-a",
    nome: "Campanha A",
  });
  const campB = seedCampanha(db, {
    empresaId: empB.id,
    expertId: expertB.id,
    id: "camp-home-iso-b",
    nome: "Campanha B",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const today = sqlDate(db, `date('now')`);
  const recentUpdated = sqlDate(db, `datetime('now', '-1 day')`);

  const taskA1 = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campA.id,
    createdBy: user.id,
    id: "tar-home-iso-a-1",
    titulo: "Task A1",
    status: "a_fazer",
    prazo: yesterday,
    donoId: user.id,
  });
  const taskA2 = seedTarefa(db, {
    empresaId: empA.id,
    campanhaId: campA.id,
    createdBy: user.id,
    id: "tar-home-iso-a-2",
    titulo: "Task A2",
    status: "fazendo",
    prazo: today,
    donoId: user.id,
  });
  // Distinct open tarefas on B (and a recent feito) — must never appear when active on A
  const taskB1 = seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: user.id,
    id: "tar-home-iso-b-1",
    titulo: "Task B1 Late",
    status: "a_fazer",
    prazo: yesterday,
    donoId: user.id,
  });
  const taskB2 = seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: user.id,
    id: "tar-home-iso-b-2",
    titulo: "Task B2",
    status: "a_fazer",
    prazo: today,
    donoId: user.id,
  });
  seedTarefa(db, {
    empresaId: empB.id,
    campanhaId: campB.id,
    createdBy: user.id,
    id: "tar-home-iso-b-feito",
    titulo: "Task B Feito",
    status: "feito",
    donoId: user.id,
    updatedAt: recentUpdated,
  });

  const bIds = new Set([taskB1.id, taskB2.id, "tar-home-iso-b-feito"]);

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, user.id, empA.id);

  const res = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET home returns 200");
  const body = await res.json();
  assert.ok(body && typeof body === "object");

  assert.ok(Array.isArray(body.meu_trabalho));
  assert.ok(Array.isArray(body.empresa_abertas));

  for (const item of body.meu_trabalho) {
    assert.ok(!bIds.has(item.id), `meu_trabalho must not include B id ${item.id}`);
  }
  for (const item of body.empresa_abertas) {
    assert.ok(
      !bIds.has(item.id),
      `empresa_abertas must not include B id ${item.id}`,
    );
  }

  const returnedIds = new Set([
    ...body.meu_trabalho.map((/** @type {{ id: string }} */ t) => t.id),
    ...body.empresa_abertas.map((/** @type {{ id: string }} */ t) => t.id),
  ]);
  assert.ok(returnedIds.has(taskA1.id) || returnedIds.has(taskA2.id), "A tasks present");

  // Aggregates scoped to A only: A has 1 late + 1 today open, 0 feitas_7d
  assert.equal(body.kpis.atrasadas_empresa, 1, "atrasadas_empresa scoped to A");
  assert.equal(
    body.kpis.vencem_hoje_empresa,
    1,
    "vencem_hoje_empresa scoped to A",
  );
  assert.equal(body.kpis.abertas_empresa, 2, "abertas_empresa scoped to A");
  assert.equal(
    body.kpis.feitas_7d_empresa,
    0,
    "feitas_7d_empresa must not count B feito",
  );

  const urgAtrasadas = chartCount(body.charts.urgencia, "bucket", "atrasadas");
  assert.equal(urgAtrasadas, 1, "chart atrasadas scoped to A (not B's late)");

  db.close();
});

// ─── lt-feitas-7d-status-patch-only ────────────────────────────────────────

/**
 * @description Feitas 7d / updated_at bump only on real status change; titulo-only and no-op status=feito leave both unchanged.
 */
test("lt-feitas-7d-status-patch-only: old feito → PATCH titulo keeps updated_at + feitas_7d; no-op status=feito still unchanged; real transition to feito bumps and includes in feitas_7d", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    id: "user-home-feitas",
    email: "admin-home-feitas@example.com",
    name: "Admin Home Feitas",
  });
  const emp = seedEmpresa(db, {
    id: "emp-home-feitas",
    nome: "Empresa Home Feitas",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: admin.id,
    papel: "admin",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-home-feitas",
    nome: "Expert Feitas",
  });
  const campanha = seedCampanha(db, {
    empresaId: emp.id,
    expertId: expert.id,
    id: "camp-home-feitas",
    nome: "Campanha Feitas",
  });

  const oldUpdated = sqlDate(db, `datetime('now', '-10 days')`);
  const tarefa = seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: admin.id,
    id: "tar-home-feitas-old",
    titulo: "Old Feito",
    status: "feito",
    prazo: null,
    donoId: admin.id,
    updatedAt: oldUpdated,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  // Baseline: excluded from feitas_7d_*
  const home0 = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(home0.status, 200, "baseline GET home 200");
  const body0 = await home0.json();
  assert.equal(
    body0.kpis.feitas_7d_empresa,
    0,
    "old feito excluded from feitas_7d_empresa",
  );
  assert.equal(
    body0.kpis.minhas_feitas_7d,
    0,
    "old feito excluded from minhas_feitas_7d",
  );
  const updatedBefore = tarefaUpdatedAt(db, tarefa.id);
  assert.equal(updatedBefore, oldUpdated, "seeded old updated_at");

  // 1) PATCH titulo only — must not bump updated_at or feitas_7d
  const patchTitulo = await patchJson(
    app,
    `${TAREFAS_PATH}/${tarefa.id}`,
    { titulo: "novo" },
    { Cookie: cookie },
  );
  assert.ok(
    patchTitulo.status === 200 || patchTitulo.status === 204,
    `PATCH titulo returns 200/204, got ${patchTitulo.status}`,
  );

  const updatedAfterTitulo = tarefaUpdatedAt(db, tarefa.id);
  assert.equal(
    updatedAfterTitulo,
    oldUpdated,
    "row updated_at unchanged after titulo-only PATCH",
  );

  const home1 = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(home1.status, 200);
  const body1 = await home1.json();
  assert.equal(
    body1.kpis.feitas_7d_empresa,
    body0.kpis.feitas_7d_empresa,
    "feitas_7d_empresa unchanged after titulo PATCH",
  );
  assert.equal(
    body1.kpis.minhas_feitas_7d,
    body0.kpis.minhas_feitas_7d,
    "minhas_feitas_7d unchanged after titulo PATCH",
  );

  // 2) PATCH status=feito no-op (already feito) — updated_at still unchanged, feitas_7d still 0
  const patchNoopStatus = await patchJson(
    app,
    `${TAREFAS_PATH}/${tarefa.id}`,
    { status: "feito" },
    { Cookie: cookie },
  );
  assert.ok(
    patchNoopStatus.status === 200 || patchNoopStatus.status === 204,
    `PATCH no-op status=feito returns 200/204, got ${patchNoopStatus.status}`,
  );

  const updatedAfterNoop = tarefaUpdatedAt(db, tarefa.id);
  assert.equal(
    updatedAfterNoop,
    oldUpdated,
    "row updated_at still unchanged after no-op status=feito PATCH",
  );

  const home2 = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(home2.status, 200);
  const body2 = await home2.json();
  assert.equal(
    body2.kpis.feitas_7d_empresa,
    0,
    "feitas_7d_empresa still 0 after no-op status=feito",
  );
  assert.equal(
    body2.kpis.minhas_feitas_7d,
    0,
    "minhas_feitas_7d still 0 after no-op status=feito",
  );

  // 3) Real transition: a_fazer → feito bumps updated_at and includes in feitas_7d
  const patchOpen = await patchJson(
    app,
    `${TAREFAS_PATH}/${tarefa.id}`,
    { status: "a_fazer" },
    { Cookie: cookie },
  );
  assert.ok(
    patchOpen.status === 200 || patchOpen.status === 204,
    `PATCH status=a_fazer returns 200/204, got ${patchOpen.status}`,
  );

  const patchFeito = await patchJson(
    app,
    `${TAREFAS_PATH}/${tarefa.id}`,
    { status: "feito" },
    { Cookie: cookie },
  );
  assert.ok(
    patchFeito.status === 200 || patchFeito.status === 204,
    `PATCH status=feito (real transition) returns 200/204, got ${patchFeito.status}`,
  );

  const updatedAfterTransition = tarefaUpdatedAt(db, tarefa.id);
  assert.ok(updatedAfterTransition, "updated_at present after real status transition");
  assert.notEqual(
    updatedAfterTransition,
    oldUpdated,
    "updated_at changed after real status transition to feito",
  );

  // datetime('now')-class recent: date(updated_at) >= date('now','-7 days')
  const isRecent = db
    .prepare(
      `SELECT CASE WHEN date(?) >= date('now', '-7 days') THEN 1 ELSE 0 END AS ok`,
    )
    .get(updatedAfterTransition);
  assert.equal(
    Number(isRecent.ok),
    1,
    "updated_at is datetime('now')-class recent (within 7d window)",
  );

  const home3 = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(home3.status, 200);
  const body3 = await home3.json();
  assert.equal(
    body3.kpis.feitas_7d_empresa,
    1,
    "GET home includes tarefa in feitas_7d_empresa after real transition to feito",
  );
  assert.equal(
    body3.kpis.minhas_feitas_7d,
    1,
    "GET home includes tarefa in minhas_feitas_7d after real transition to feito",
  );

  db.close();
});

// ─── lt-atrasada-definition ────────────────────────────────────────────────

/**
 * @description Atrasada = open + prazo < today; vence hoje = open + prazo = today (admin KPIs + buckets).
 */
test("lt-atrasada-definition: yesterday prazo → atrasada true + atrasadas KPI/bucket; today prazo → atrasada false + vencem_hoje KPI/bucket", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    id: "user-home-atrasada",
    email: "admin-home-atrasada@example.com",
    name: "Admin Home Atrasada",
  });
  const emp = seedEmpresa(db, {
    id: "emp-home-atrasada",
    nome: "Empresa Home Atrasada",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: admin.id,
    papel: "admin",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-home-atrasada",
    nome: "Expert Atrasada",
  });
  const campanha = seedCampanha(db, {
    empresaId: emp.id,
    expertId: expert.id,
    id: "camp-home-atrasada",
    nome: "Campanha Atrasada",
  });

  const yesterday = sqlDate(db, `date('now', '-1 day')`);
  const today = sqlDate(db, `date('now')`);

  const lateTask = seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: admin.id,
    id: "tar-home-atrasada-yest",
    titulo: "Prazo Yesterday",
    status: "a_fazer",
    prazo: yesterday,
    donoId: admin.id,
  });
  const todayTask = seedTarefa(db, {
    empresaId: emp.id,
    campanhaId: campanha.id,
    createdBy: admin.id,
    id: "tar-home-atrasada-today",
    titulo: "Prazo Today",
    status: "a_fazer",
    prazo: today,
    donoId: admin.id,
  });

  const app = createEmpresaApp(db);
  const { cookie } = await sessionFor(db, admin.id, emp.id);

  const res = await getJson(app, HOME_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET home returns 200");
  const body = await res.json();
  assert.ok(body && typeof body === "object");
  assert.equal(body.papel, "admin");

  /** @type {Map<string, { id: string, atrasada: boolean }>} */
  const byId = new Map();
  for (const list of [body.meu_trabalho, body.empresa_abertas]) {
    assert.ok(Array.isArray(list));
    for (const item of list) {
      if (item && typeof item.id === "string") {
        byId.set(item.id, item);
      }
    }
  }

  const lateRow = byId.get(lateTask.id);
  assert.ok(lateRow, "yesterday task appears in home lists");
  assert.equal(lateRow.atrasada, true, "yesterday task atrasada===true");

  const todayRow = byId.get(todayTask.id);
  assert.ok(todayRow, "today task appears in home lists");
  assert.equal(todayRow.atrasada, false, "today task atrasada===false");

  assert.equal(
    body.kpis.atrasadas_empresa,
    1,
    "yesterday increments kpis.atrasadas_empresa",
  );
  assert.equal(
    body.kpis.vencem_hoje_empresa,
    1,
    "today increments kpis.vencem_hoje_empresa",
  );

  const urgAtrasadas = chartCount(body.charts.urgencia, "bucket", "atrasadas");
  const urgHoje = chartCount(body.charts.urgencia, "bucket", "hoje");
  assert.equal(urgAtrasadas, 1, "yesterday increments urgency bucket atrasadas");
  assert.equal(urgHoje, 1, "today increments urgency bucket hoje");

  db.close();
});
