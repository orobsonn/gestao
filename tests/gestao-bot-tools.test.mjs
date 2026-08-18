/**
 * Locked gestao bot tools contract — createGestaoBotTools tenant closures.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Invokes tools by name via ToolDefinition.run({ data }) (Flue 2.x); the run resolves a
 * ToolRunEnvelope { output?, terminate? }. Helpers unwrap the envelope so the behavioural
 * assertions (tenant closure, DB effects, error branches) read the payload as before.
 * mocks sendNotify.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGestaoBotTools } from "../src/worker/agent/gestao-bot-tools.ts";
import {
  getDmActiveEmpresa,
  upsertDmActiveEmpresa,
} from "../src/worker/services/telegram-dm-active-empresa.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const DM_TOOL_NAMES = [
  "listar_tarefas",
  "criar_tarefa",
  "atualizar_tarefa",
  "excluir_tarefa",
  "notificar_usuario",
  "listar_membros",
  "listar_minhas_empresas",
  "definir_empresa_ativa",
];

const CAMPANHA_WRITE_NAMES = [
  "create_campanha",
  "criar_campanha",
  "atualizar_campanha",
  "excluir_campanha",
  "deletar_campanha",
];

/**
 * @description Open in-memory SQLite, enable FKs, apply every migrations/*.sql sorted by filename.
 * @returns {DatabaseSync}
 */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}

/**
 * @description Open in-memory SQLite WITHOUT enabling FKs, then apply migrations.
 * @returns {DatabaseSync}
 */
function openDbWithoutFk() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  applyMigrations(db);
  return db;
}

/**
 * @description Apply every migrations/*.sql sorted lexically.
 * @param {DatabaseSync} db
 */
function applyMigrations(db) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
    db.exec(sql);
  }
}

/**
 * @description Seed a minimal users row (dummy hash/salt — FK parent only).
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-tools-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Tools User";
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, "hash", "salt");
  return { id, email, name };
}

/**
 * @description Seed a minimal empresas row (active unless deleted_at set).
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string, deleted_at?: string | null }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-tools-a";
  const nome = opts.nome ?? "Empresa A";
  if (opts.deleted_at != null) {
    db.prepare(
      `INSERT INTO empresas (id, nome, deleted_at) VALUES (?, ?, ?)`,
    ).run(id, nome, opts.deleted_at);
  } else {
    db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  }
  return { id, nome };
}

/**
 * @description Seed empresa_membros link.
 * @param {DatabaseSync} db
 * @param {string} empresaId
 * @param {string} userId
 * @param {string} [papel]
 */
function seedMembro(db, empresaId, userId, papel = "membro") {
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, ?)`,
  ).run(`mem-${empresaId}-${userId}`, empresaId, userId, papel);
}

/**
 * @description Seed user_telegram_links row.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {string} telegramUserId
 */
function seedTelegramLink(db, userId, telegramUserId) {
  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(userId, telegramUserId);
}

/**
 * @description Seed a live expert row.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, id?: string, nome?: string }} opts
 */
function seedExpert(db, opts) {
  const id = opts.id ?? "expert-tools-e";
  const nome = opts.nome ?? "Expert E";
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, opts.empresaId, nome);
  return { id, nome, empresaId: opts.empresaId };
}

/**
 * @description Seed a campanha under expert (composite FK).
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   expertId: string,
 *   id?: string,
 *   nome?: string,
 *   status?: string,
 *   deletedAt?: string | null,
 * }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const status = opts.status ?? "aberta";
  const deletedAt = opts.deletedAt ?? null;
  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
       VALUES (?, ?, ?, ?, 'gratuito', ?)`,
    ).run(id, opts.empresaId, opts.expertId, nome, status);
  } else {
    db.prepare(
      `INSERT INTO campanhas
         (id, empresa_id, expert_id, nome, tipo, status, deleted_at)
       VALUES (?, ?, ?, ?, 'gratuito', ?, ?)`,
    ).run(id, opts.empresaId, opts.expertId, nome, status, deletedAt);
  }
  return {
    id,
    nome,
    status,
    empresaId: opts.empresaId,
    expertId: opts.expertId,
    deletedAt,
  };
}

/**
 * @description Seed a live tarefa under campanha.
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   campanhaId: string,
 *   createdBy: string,
 *   id?: string,
 *   titulo?: string,
 * }} opts
 */
function seedTarefa(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const titulo = opts.titulo ?? "Tarefa Seed";
  db.prepare(
    `INSERT INTO tarefas
       (id, empresa_id, campanha_id, titulo, notas, status, created_by)
     VALUES (?, ?, ?, ?, '', 'a_fazer', ?)`,
  ).run(id, opts.empresaId, opts.campanhaId, titulo, opts.createdBy);
  return {
    id,
    titulo,
    empresaId: opts.empresaId,
    campanhaId: opts.campanhaId,
    createdBy: opts.createdBy,
  };
}

/**
 * @description Count tarefas rows, optionally filtered.
 * @param {DatabaseSync} db
 * @param {{ empresaId?: string, campanhaId?: string, titulo?: string }} [filter]
 */
function countTarefas(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.empresaId != null) {
    clauses.push("empresa_id = ?");
    params.push(filter.empresaId);
  }
  if (filter.campanhaId != null) {
    clauses.push("campanha_id = ?");
    params.push(filter.campanhaId);
  }
  if (filter.titulo != null) {
    clauses.push("titulo = ?");
    params.push(filter.titulo);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM tarefas ${where}`)
    .get(...params);
  return Number(row?.c ?? 0);
}

/**
 * @description Fetch latest tarefa by titulo (any deleted_at).
 * @param {DatabaseSync} db
 * @param {string} titulo
 */
function getTarefaByTitulo(db, titulo) {
  return db
    .prepare(
      `SELECT id, empresa_id, campanha_id, titulo, created_by, deleted_at
       FROM tarefas WHERE titulo = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(titulo);
}

/**
 * @description Fetch tarefa by id (includes soft-deleted).
 * @param {DatabaseSync} db
 * @param {string} id
 */
function getTarefaById(db, id) {
  return db
    .prepare(
      `SELECT id, empresa_id, campanha_id, titulo, created_by, deleted_at
       FROM tarefas WHERE id = ?`,
    )
    .get(id);
}

/**
 * @description Mock sendNotify that records calls.
 * @returns {{ calls: unknown[], fn: (...args: unknown[]) => Promise<void> }}
 */
function mockSendNotify() {
  /** @type {unknown[]} */
  const calls = [];
  return {
    calls,
    fn: async (...args) => {
      calls.push(args.length === 1 ? args[0] : args);
    },
  };
}

/**
 * @description Build tools from createGestaoBotTools with defaults.
 * @param {DatabaseSync | { prepare: Function }} db
 * @param {{
 *   empresa_id?: string,
 *   expert_id?: string | null,
 *   actor_user_id?: string,
 *   surface?: 'topic' | 'dm',
 *   sendNotify?: (...args: unknown[]) => Promise<void> | void,
 * }} [opts]
 */
function buildTools(db, opts = {}) {
  const sendNotify = opts.sendNotify ?? (async () => {});
  return createGestaoBotTools({
    empresa_id: opts.empresa_id ?? "emp-A",
    expert_id: opts.expert_id === undefined ? "expert-E" : opts.expert_id,
    actor_user_id: opts.actor_user_id ?? "user-actor",
    surface: opts.surface ?? "topic",
    db,
    sendNotify,
  });
}

/**
 * @description Collect tool names from factory return value (array or name-keyed).
 * @param {unknown} tools
 * @returns {string[]}
 */
function toolNames(tools) {
  assert.ok(tools != null, "createGestaoBotTools must return tools");
  if (Array.isArray(tools)) {
    return tools.map((t) => {
      assert.ok(t && typeof t === "object" && "name" in t);
      return String(/** @type {{ name: unknown }} */ (t).name);
    });
  }
  if (typeof tools === "object") {
    const vals = Object.values(/** @type {Record<string, unknown>} */ (tools));
    if (
      vals.length > 0 &&
      vals.every((t) => t && typeof t === "object" && "name" in t)
    ) {
      return vals.map((t) =>
        String(/** @type {{ name: unknown }} */ (t).name),
      );
    }
    return Object.keys(/** @type {Record<string, unknown>} */ (tools));
  }
  assert.fail("tools must be an array or object of ToolDefinitions");
}

/**
 * @description Find a tool by name from factory return value.
 * @param {unknown} tools
 * @param {string} name
 */
function getTool(tools, name) {
  if (Array.isArray(tools)) {
    const found = tools.find(
      (t) =>
        t &&
        typeof t === "object" &&
        "name" in t &&
        /** @type {{ name: unknown }} */ (t).name === name,
    );
    assert.ok(found, `tool ${name} must exist`);
    return /** @type {{ name: string, run: Function }} */ (found);
  }
  if (tools && typeof tools === "object") {
    const rec = /** @type {Record<string, unknown>} */ (tools);
    if (rec[name] && typeof rec[name] === "object") {
      const t = /** @type {{ name?: string, run?: Function }} */ (rec[name]);
      if (typeof t.run === "function") return /** @type {{ name: string, run: Function }} */ (t);
    }
    const found = Object.values(rec).find(
      (t) =>
        t &&
        typeof t === "object" &&
        "name" in t &&
        /** @type {{ name: unknown }} */ (t).name === name,
    );
    assert.ok(found, `tool ${name} must exist`);
    return /** @type {{ name: string, run: Function }} */ (found);
  }
  assert.fail(`tool ${name} not found`);
}

/**
 * @description Invoke a Flue 2.x ToolDefinition via run({ data }) and return the
 * resolved ToolRunEnvelope ({ output?, terminate? }).
 * @param {{ run: Function }} tool
 * @param {Record<string, unknown>} [data]
 */
async function invokeTool(tool, data = {}) {
  assert.equal(typeof tool.run, "function", "tool must expose run()");
  return tool.run({ data });
}

/**
 * @description Unwrap a Flue 2.x ToolRunEnvelope to its `output` payload. If the value
 * is not an envelope (no own `output`), return it as-is (defensive — keeps helpers
 * working against both shapes during the migration).
 * @param {unknown} result
 */
function payloadOf(result) {
  if (
    result !== null &&
    typeof result === "object" &&
    Object.hasOwn(/** @type {object} */ (result), "output")
  ) {
    return /** @type {{ output: unknown }} */ (result).output;
  }
  return result;
}

/**
 * @description Flatten a tool result (envelope or payload) to searchable text.
 * Stringifies the `output` payload, not the envelope wrapper.
 * @param {unknown} result
 */
function resultText(result) {
  const payload = payloadOf(result);
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/**
 * @description True when tool envelope signals terminal end-turn / stop. Under Flue 2.x
 * the terminal flag is `terminate: true` on the envelope (the beta `terminal: true`
 * payload key is gone). Reads the envelope, not the unwrapped payload.
 * @param {unknown} result
 */
function isTerminalStopResult(result) {
  if (result && typeof result === "object") {
    const r = /** @type {Record<string, unknown>} */ (result);
    if (r.terminate === true) return true;
    // Legacy envelope-level keys kept only as a defensive fallback; the 2.x
    // contract never sets these, so reaching them is a contract regression.
    if (r.terminal === true || r.end_turn === true || r.stop === true) {
      return true;
    }
  }
  return false;
}

/**
 * @description True when result indicates model must ask which campaign / none open.
 * Requires clear ask/require semantics — not mere presence of a status field.
 * Reads the envelope's `output` payload.
 * @param {unknown} result
 */
function indicatesAskCampaign(result) {
  const payload = payloadOf(result);
  if (payload && typeof payload === "object") {
    const status = /** @type {Record<string, unknown>} */ (payload).status;
    if (
      status === "need_campaign" ||
      status === "ask_campaign" ||
      status === "no_open_campaign"
    ) {
      return true;
    }
  }
  const text = resultText(result);
  return /pergunt|qual campanha|nenhuma aberta|informe a campanha|campanha.*(obrigat|required)/i.test(
    text,
  );
}

/**
 * @description True when result requires explicit campanha_id (DM no LD-6).
 * Requires campanha_id token AND an obligation/required cue. Reads the payload text.
 * @param {unknown} result
 */
function indicatesRequiresCampanhaId(result) {
  const text = resultText(result);
  return (
    /campanha_id/i.test(text) &&
    /(obrigat|required|informe|necessário|necessario|explicit)/i.test(text)
  );
}

/**
 * @description True when result is a not-found / reject without leaking foreign tenant data.
 * Reads the envelope's `output` payload for ok/error and stringifies the payload for text.
 * @param {unknown} result
 * @param {string} foreignEmpresaId
 */
function isRejectNoLeak(result, foreignEmpresaId) {
  const text = resultText(result);
  assert.ok(
    !text.includes(foreignEmpresaId),
    "reject must not leak foreign empresa id",
  );
  const payload = payloadOf(result);
  return (
    /n[aã]o\s+encontr|not\s*found|inv[aá]lid|rejeit|negad|erro|error|fail/i.test(
      text,
    ) ||
    (payload &&
      typeof payload === "object" &&
      (/** @type {Record<string, unknown>} */ (payload).ok === false ||
        /** @type {Record<string, unknown>} */ (payload).error != null))
  );
}

/**
 * @description Extract telegram_user_id + text from a sendNotify call payload.
 * @param {unknown} call
 * @returns {{ telegram_user_id?: string, text?: string }}
 */
function parseNotifyCall(call) {
  if (call == null) return {};
  if (Array.isArray(call)) {
    const [a, b] = call;
    if (a && typeof a === "object") {
      const o = /** @type {Record<string, unknown>} */ (a);
      return {
        telegram_user_id: String(
          o.telegram_user_id ?? o.telegramUserId ?? o.chat_id ?? "",
        ),
        text: String(o.text ?? o.message ?? b ?? ""),
      };
    }
    return {
      telegram_user_id: a != null ? String(a) : undefined,
      text: b != null ? String(b) : undefined,
    };
  }
  if (typeof call === "object") {
    const o = /** @type {Record<string, unknown>} */ (call);
    return {
      telegram_user_id: String(
        o.telegram_user_id ?? o.telegramUserId ?? o.chat_id ?? "",
      ),
      text: String(o.text ?? o.message ?? ""),
    };
  }
  return {};
}

/**
 * @description Wrap db.prepare to record SQL in order (spy surface for FK pragma).
 * @param {DatabaseSync} db
 * @returns {{ db: { prepare: Function }, sqlLog: string[] }}
 */
function spyDb(db) {
  /** @type {string[]} */
  const sqlLog = [];
  return {
    sqlLog,
    db: {
      prepare(sql) {
        const s = String(sql);
        sqlLog.push(s);
        const stmt = db.prepare(s);
        return {
          run: (...params) => stmt.run(...params),
          get: (...params) => stmt.get(...params),
          all: (...params) => (stmt.all ? stmt.all(...params) : []),
        };
      },
    },
  };
}

/**
 * @description Seed topic baseline: empresa A, expert E, actor member.
 * @param {DatabaseSync} db
 * @param {{ empresaId?: string, expertId?: string, actorId?: string }} [ids]
 */
function seedTopicBase(db, ids = {}) {
  const empresaId = ids.empresaId ?? "emp-A";
  const expertId = ids.expertId ?? "expert-E";
  const actorId = ids.actorId ?? "user-actor";
  seedEmpresa(db, { id: empresaId, nome: "Empresa A" });
  const actor = seedUser(db, { id: actorId, name: "Actor" });
  seedMembro(db, empresaId, actor.id);
  const expert = seedExpert(db, {
    id: expertId,
    empresaId,
    nome: "Expert E",
  });
  return { empresaId, expertId: expert.id, actorId: actor.id };
}

// ─── lt-topic-create-one-open-campanha ─────────────────────────────────────

/**
 * @description Topic criar_tarefa with exactly one live aberta campanha inserts tarefa bound to that campanha, closure empresa_id, created_by=actor, deleted_at NULL.
 */
test("lt-topic-create-one-open-campanha: 1 aberta → insert tarefa on that campanha", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  const camp = seedCampanha(db, {
    id: "camp-open-1",
    empresaId,
    expertId,
    nome: "Aberta Unica",
    status: "aberta",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  const before = countTarefas(db);
  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Revisar criativos",
  });
  const after = countTarefas(db);
  assert.equal(after, before + 1, "exactly one tarefas row must be inserted");

  const row = getTarefaByTitulo(db, "Revisar criativos");
  assert.ok(row, "tarefa with titulo Revisar criativos must exist");
  assert.equal(row.campanha_id, camp.id);
  assert.equal(row.empresa_id, empresaId);
  assert.equal(row.created_by, actorId);
  assert.equal(row.deleted_at, null);

  db.close();
});

// ─── lt-topic-create-one-aberta-plus-encerrada-auto ─────────────────────────

/**
 * @description Topic criar_tarefa with one aberta + one encerrada binds only the aberta campanha (LD-6 ignores encerrada).
 */
test("lt-topic-create-one-aberta-plus-encerrada-auto: binds aberta only", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  const aberta = seedCampanha(db, {
    id: "camp-aberta",
    empresaId,
    expertId,
    nome: "Aberta",
    status: "aberta",
  });
  seedCampanha(db, {
    id: "camp-encerrada",
    empresaId,
    expertId,
    nome: "Encerrada",
    status: "encerrada",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Revisar criativos",
  });

  const row = getTarefaByTitulo(db, "Revisar criativos");
  assert.ok(row, "tarefa must be inserted");
  assert.equal(row.campanha_id, aberta.id, "must bind aberta campanha only");
  assert.notEqual(row.campanha_id, "camp-encerrada");

  db.close();
});

// ─── lt-topic-create-zero-open-asks ─────────────────────────────────────────

/**
 * @description Topic criar_tarefa with zero live aberta campanhas inserts nothing and asks which campaign / none open.
 */
test("lt-topic-create-zero-open-asks: 0 aberta → no insert, ask", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  seedCampanha(db, {
    id: "camp-enc-only",
    empresaId,
    expertId,
    status: "encerrada",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  const before = countTarefas(db);
  const result = await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Revisar criativos",
  });
  assert.equal(countTarefas(db), before, "no tarefas row must be inserted");
  assert.ok(
    indicatesAskCampaign(result),
    "tool result must indicate model must ask which campaign or that none is open",
  );

  db.close();
});

// ─── lt-topic-create-multi-open-asks ────────────────────────────────────────

/**
 * @description Topic criar_tarefa with two live aberta campanhas inserts nothing and asks which campaign.
 */
test("lt-topic-create-multi-open-asks: 2 aberta → no insert, ask", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  seedCampanha(db, {
    id: "camp-a1",
    empresaId,
    expertId,
    nome: "A1",
    status: "aberta",
  });
  seedCampanha(db, {
    id: "camp-a2",
    empresaId,
    expertId,
    nome: "A2",
    status: "aberta",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  const before = countTarefas(db);
  const result = await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Revisar criativos",
  });
  assert.equal(countTarefas(db), before, "no tarefas row must be inserted");
  assert.ok(
    indicatesAskCampaign(result),
    "tool result must indicate model must ask which campaign",
  );

  db.close();
});

// ─── lt-dm-create-without-campanha-rejects ──────────────────────────────────

/**
 * @description DM criar_tarefa without campanha_id inserts nothing and requires explicit campanha_id (no LD-6).
 */
test("lt-dm-create-without-campanha-rejects: dm no campanha_id → no insert", async () => {
  const db = openDb();
  const empresaId = "emp-A";
  const actorId = "user-actor";
  seedEmpresa(db, { id: empresaId });
  seedUser(db, { id: actorId });
  seedMembro(db, empresaId, actorId);
  const expert = seedExpert(db, { id: "expert-E", empresaId });
  seedCampanha(db, {
    id: "camp-dm-open",
    empresaId,
    expertId: expert.id,
    status: "aberta",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: null,
    actor_user_id: actorId,
    surface: "dm",
  });
  const before = countTarefas(db);
  const result = await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Revisar criativos",
  });
  assert.equal(countTarefas(db), before, "no tarefas row must be inserted");
  assert.ok(
    indicatesRequiresCampanhaId(result),
    "tool result must require explicit campanha_id",
  );

  db.close();
});

// ─── lt-dm-tools-matrix-no-listar-campanhas ─────────────────────────────────

/**
 * @description DM tool name list includes task/notify/membros/empresas tools and excludes listar_campanhas.
 */
test("lt-dm-tools-matrix-no-listar-campanhas: dm tools matrix", async () => {
  const db = openDb();
  seedEmpresa(db, { id: "emp-A" });
  seedUser(db, { id: "user-actor" });
  seedMembro(db, "emp-A", "user-actor");

  const tools = buildTools(db, {
    empresa_id: "emp-A",
    expert_id: null,
    actor_user_id: "user-actor",
    surface: "dm",
  });
  const names = toolNames(tools);

  for (const required of DM_TOOL_NAMES) {
    assert.ok(
      names.includes(required),
      `dm tools must include ${required}, got: ${names.join(",")}`,
    );
  }
  assert.ok(
    !names.includes("listar_campanhas"),
    "dm tools must NOT include listar_campanhas",
  );

  db.close();
});

// ─── lt-no-create-campanha-tool ─────────────────────────────────────────────

/**
 * @description Neither topic nor dm tool lists contain create_campanha / criar_campanha or campanha write tools.
 */
test("lt-no-create-campanha-tool: no campanha write tool on topic/dm", async () => {
  const db = openDb();
  seedEmpresa(db, { id: "emp-A" });
  seedUser(db, { id: "user-actor" });
  seedMembro(db, "emp-A", "user-actor");
  seedExpert(db, { id: "expert-E", empresaId: "emp-A" });

  const topicTools = buildTools(db, {
    empresa_id: "emp-A",
    expert_id: "expert-E",
    actor_user_id: "user-actor",
    surface: "topic",
  });
  const dmTools = buildTools(db, {
    empresa_id: "emp-A",
    expert_id: null,
    actor_user_id: "user-actor",
    surface: "dm",
  });

  for (const [label, tools] of [
    ["topic", topicTools],
    ["dm", dmTools],
  ]) {
    const names = toolNames(tools);
    for (const banned of CAMPANHA_WRITE_NAMES) {
      assert.ok(
        !names.includes(banned),
        `${label} tools must not include ${banned}`,
      );
    }
    assert.ok(
      !names.some((n) => /campanha/i.test(n) && /cri(ar|ate)|write|insert|add|nova/i.test(n)),
      `${label} tools must not include any campanha write tool name, got: ${names.join(",")}`,
    );
  }

  db.close();
});

// ─── lt-excluir-tarefa-soft-deletes ─────────────────────────────────────────

/**
 * @description excluir_tarefa soft-deletes: row remains with deleted_at IS NOT NULL; PK not hard-deleted.
 */
test("lt-excluir-tarefa-soft-deletes: soft delete keeps PK", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  const camp = seedCampanha(db, {
    id: "camp-del",
    empresaId,
    expertId,
    status: "aberta",
  });
  const tarefa = seedTarefa(db, {
    id: "tar-soft-1",
    empresaId,
    campanhaId: camp.id,
    createdBy: actorId,
    titulo: "Para excluir",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  await invokeTool(getTool(tools, "excluir_tarefa"), { id: tarefa.id });

  const row = getTarefaById(db, tarefa.id);
  assert.ok(row, "row must still exist (no hard DELETE of PK)");
  assert.notEqual(row.deleted_at, null, "deleted_at must be IS NOT NULL");
  assert.equal(
    countTarefas(db, { empresaId }),
    1,
    "row count by PK presence remains 1",
  );

  db.close();
});

// ─── lt-notify-unlinked-informs ─────────────────────────────────────────────

/**
 * @description notificar_usuario for same-empresa member without telegram link does not call sendNotify and informs no link.
 */
test("lt-notify-unlinked-informs: no sendNotify when target unlinked", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  const target = seedUser(db, { id: "user-target-unlinked", name: "Target" });
  seedMembro(db, empresaId, target.id);
  // deliberately no user_telegram_links for target

  const notify = mockSendNotify();
  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
    sendNotify: notify.fn,
  });
  const result = await invokeTool(getTool(tools, "notificar_usuario"), {
    user_id: target.id,
    mensagem: "oi",
  });

  assert.equal(notify.calls.length, 0, "sendNotify must not be called");
  const text = resultText(result).toLowerCase();
  assert.ok(
    /telegram|v[ií]ncul|link|n[aã]o\s+(est[aá]|tem)|sem\s+link|unlinked|not\s+linked/i.test(
      text,
    ),
    "tool result must inform that the user has no Telegram link",
  );

  db.close();
});

// ─── lt-notify-linked-sends ─────────────────────────────────────────────────

/**
 * @description notificar_usuario for same-empresa member with telegram link tg-9 calls sendNotify once with tg-9 and text containing oi.
 */
test("lt-notify-linked-sends: sendNotify once with tg-9 and oi", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  const target = seedUser(db, { id: "user-target-linked", name: "Target" });
  seedMembro(db, empresaId, target.id);
  seedTelegramLink(db, target.id, "tg-9");

  const notify = mockSendNotify();
  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
    sendNotify: notify.fn,
  });
  await invokeTool(getTool(tools, "notificar_usuario"), {
    user_id: target.id,
    mensagem: "oi",
  });

  assert.equal(notify.calls.length, 1, "sendNotify must be called once");
  const parsed = parseNotifyCall(notify.calls[0]);
  assert.equal(
    parsed.telegram_user_id,
    "tg-9",
    "sendNotify must receive telegram_user_id tg-9",
  );
  assert.ok(
    String(parsed.text ?? "").includes("oi"),
    "sendNotify text must contain oi",
  );

  db.close();
});

// ─── lt-tools-ignore-model-empresa-id ───────────────────────────────────────

/**
 * @description listar_tarefas / criar_tarefa ignore model-supplied empresa_id=B; only closure empresa A is used.
 */
test("lt-tools-ignore-model-empresa-id: only closure empresa A", async () => {
  const db = openDb();
  const empresaA = "emp-A";
  const empresaB = "emp-B";
  const actorId = "user-actor";
  seedEmpresa(db, { id: empresaA, nome: "A" });
  seedEmpresa(db, { id: empresaB, nome: "B" });
  seedUser(db, { id: actorId });
  seedMembro(db, empresaA, actorId);
  seedMembro(db, empresaB, actorId);
  const expertA = seedExpert(db, { id: "expert-A", empresaId: empresaA });
  const expertB = seedExpert(db, { id: "expert-B", empresaId: empresaB });
  const campA = seedCampanha(db, {
    id: "camp-A",
    empresaId: empresaA,
    expertId: expertA.id,
    status: "aberta",
  });
  const campB = seedCampanha(db, {
    id: "camp-B",
    empresaId: empresaB,
    expertId: expertB.id,
    status: "aberta",
  });
  seedTarefa(db, {
    id: "tar-A",
    empresaId: empresaA,
    campanhaId: campA.id,
    createdBy: actorId,
    titulo: "Tarefa A only",
  });
  seedTarefa(db, {
    id: "tar-B",
    empresaId: empresaB,
    campanhaId: campB.id,
    createdBy: actorId,
    titulo: "Tarefa B only",
  });

  const tools = buildTools(db, {
    empresa_id: empresaA,
    expert_id: expertA.id,
    actor_user_id: actorId,
    surface: "topic",
  });

  const listResult = await invokeTool(getTool(tools, "listar_tarefas"), {
    empresa_id: empresaB,
  });
  const listText = resultText(listResult);
  assert.ok(
    !listText.includes("Tarefa B only"),
    "listar_tarefas must not return empresa B rows",
  );
  assert.ok(
    listText.includes("Tarefa A only") || listText.includes("tar-A"),
    "listar_tarefas must scope to empresa A",
  );

  const beforeB = countTarefas(db, { empresaId: empresaB });
  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Nova sob A",
    campanha_id: campA.id,
    empresa_id: empresaB,
  });
  assert.equal(
    countTarefas(db, { empresaId: empresaB }),
    beforeB,
    "criar_tarefa must not create rows under empresa B",
  );
  const created = getTarefaByTitulo(db, "Nova sob A");
  assert.ok(created, "tarefa must be created under closure empresa");
  assert.equal(created.empresa_id, empresaA);

  db.close();
});

// ─── lt-criar-tarefa-campanha-cross-tenant-rejects ──────────────────────────

/**
 * @description criar_tarefa with live campanha owned by empresa B under closure A inserts nothing and rejects without leaking B.
 */
test("lt-criar-tarefa-campanha-cross-tenant-rejects: foreign campanha_id rejected", async () => {
  const db = openDb();
  const empresaA = "emp-A";
  const empresaB = "emp-B";
  const actorId = "user-actor";
  seedEmpresa(db, { id: empresaA });
  seedEmpresa(db, { id: empresaB });
  seedUser(db, { id: actorId });
  seedMembro(db, empresaA, actorId);
  const expertA = seedExpert(db, { id: "expert-A", empresaId: empresaA });
  const expertB = seedExpert(db, { id: "expert-B", empresaId: empresaB });
  seedCampanha(db, {
    id: "camp-A-open",
    empresaId: empresaA,
    expertId: expertA.id,
    status: "aberta",
  });
  const campB = seedCampanha(db, {
    id: "camp-B-foreign",
    empresaId: empresaB,
    expertId: expertB.id,
    status: "aberta",
  });

  for (const surface of /** @type {const} */ (["topic", "dm"])) {
    const tools = buildTools(db, {
      empresa_id: empresaA,
      expert_id: surface === "topic" ? expertA.id : null,
      actor_user_id: actorId,
      surface,
    });
    const before = countTarefas(db);
    const result = await invokeTool(getTool(tools, "criar_tarefa"), {
      titulo: `Cross tenant ${surface}`,
      campanha_id: campB.id,
    });
    assert.equal(
      countTarefas(db),
      before,
      `${surface}: no tarefas row must be inserted for foreign campanha`,
    );
    assert.ok(
      isRejectNoLeak(result, empresaB),
      `${surface}: result must be not-found/reject without leaking B`,
    );
  }

  db.close();
});

// ─── lt-topic-criar-tarefa-cross-expert-campanha-rejects ────────────────────

/**
 * @description Topic criar_tarefa with live campanha under same empresa but other expert rejects (pt-br) with no insert.
 */
test("lt-topic-criar-tarefa-cross-expert-campanha-rejects: cross-expert campanha rejected", async () => {
  const db = openDb();
  const empresaId = "emp-A";
  const actorId = "user-actor";
  seedEmpresa(db, { id: empresaId });
  seedUser(db, { id: actorId });
  seedMembro(db, empresaId, actorId);
  const e1 = seedExpert(db, { id: "expert-E1", empresaId, nome: "E1" });
  const e2 = seedExpert(db, { id: "expert-E2", empresaId, nome: "E2" });
  const campE2 = seedCampanha(db, {
    id: "camp-E2",
    empresaId,
    expertId: e2.id,
    status: "aberta",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: e1.id,
    actor_user_id: actorId,
    surface: "topic",
  });
  const before = countTarefas(db);
  const result = await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Cross expert",
    campanha_id: campE2.id,
  });
  assert.equal(countTarefas(db), before, "no tarefas row must be inserted");
  const text = resultText(result);
  const payload = payloadOf(result);
  const looksReject =
    /n[aã]o\s+encontr|inv[aá]lid|n[aã]o\s+pertence|campanha|expert|rejeit|erro|not\s*found|fail/i.test(
      text,
    ) ||
    (payload &&
      typeof payload === "object" &&
      (/** @type {Record<string, unknown>} */ (payload).ok === false ||
        /** @type {Record<string, unknown>} */ (payload).error != null));
  assert.ok(looksReject, "tool result must be reject/not-found");
  // #ac-topic-camp.1 — pt-br reject copy (accented tokens or common pt words)
  assert.ok(
    /[áàâãéêíóôõúç]|n[aã]o|campanha|inv[aá]lido|encontrad|pertence|dessa?\s+expert/i.test(
      text,
    ),
    "tool result must be pt-br reject (#ac-topic-camp.1)",
  );

  db.close();
});

// ─── lt-criar-tarefa-soft-deleted-campanha-rejects ──────────────────────────

/**
 * @description criar_tarefa with soft-deleted campanha under closure empresa inserts nothing.
 */
test("lt-criar-tarefa-soft-deleted-campanha-rejects: deleted campanha no insert", async () => {
  const db = openDb();
  const { empresaId, expertId, actorId } = seedTopicBase(db);
  const camp = seedCampanha(db, {
    id: "camp-tombstone",
    empresaId,
    expertId,
    status: "aberta",
    deletedAt: "2026-01-01 00:00:00",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  const before = countTarefas(db);
  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "Sobre tumba",
    campanha_id: camp.id,
  });
  assert.equal(countTarefas(db), before, "no tarefas row must be inserted");

  db.close();
});

// ─── lt-tools-await-fk-pragma-before-sql ────────────────────────────────────

/**
 * @description Mutating tool awaits enableForeignKeysAsync (PRAGMA foreign_keys=ON) before INSERT; subsequent PRAGMA read is ON.
 */
test("lt-tools-await-fk-pragma-before-sql: enableForeignKeysAsync before INSERT", async () => {
  const raw = openDbWithoutFk();
  const fkBefore = raw.prepare("PRAGMA foreign_keys").get();
  assert.equal(
    Number(/** @type {{ foreign_keys?: number }} */ (fkBefore)?.foreign_keys ?? 0),
    0,
    "db must start with foreign_keys OFF",
  );

  const { empresaId, expertId, actorId } = seedTopicBase(raw);
  seedCampanha(raw, {
    id: "camp-fk",
    empresaId,
    expertId,
    status: "aberta",
  });

  const { db: wrapped, sqlLog } = spyDb(raw);
  /** @type {number | null} */
  let enableFkCallOrder = null;
  /** @type {number | null} */
  let insertOrder = null;
  const orderDb = {
    prepare(sql) {
      const s = String(sql);
      const idx = sqlLog.length;
      if (/PRAGMA\s+foreign_keys\s*=\s*ON/i.test(s)) {
        enableFkCallOrder = idx;
      }
      if (/INSERT\s+INTO\s+tarefas/i.test(s)) {
        insertOrder = idx;
      }
      return wrapped.prepare(s);
    },
  };

  // Also spy enableForeignKeysAsync via SQL effect (production calls it on closure db).
  const tools = buildTools(orderDb, {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorId,
    surface: "topic",
  });
  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "FK pragma task",
  });

  assert.notEqual(
    enableFkCallOrder,
    null,
    "enableForeignKeysAsync / PRAGMA foreign_keys=ON must run on db",
  );
  assert.notEqual(insertOrder, null, "INSERT INTO tarefas must run");
  assert.ok(
    /** @type {number} */ (enableFkCallOrder) <
      /** @type {number} */ (insertOrder),
    "enableForeignKeysAsync must be awaited before the INSERT",
  );

  const fkAfter = raw.prepare("PRAGMA foreign_keys").get();
  assert.equal(
    Number(/** @type {{ foreign_keys?: number }} */ (fkAfter)?.foreign_keys ?? 0),
    1,
    "subsequent PRAGMA foreign_keys read must be ON",
  );

  raw.close();
});

// ─── lt-definir-empresa-ativa-sets-pin-and-pending-boundary ─────────────────

/**
 * @description DM definir_empresa_ativa for B sets pin empresa_id=B, pending_boundary=1, and returns terminal end-turn/stop result.
 */
test("lt-definir-empresa-ativa-sets-pin-and-pending-boundary: pin B + pending_boundary=1 + terminal", async () => {
  const db = openDb();
  const userId = "user-U";
  const empA = "emp-A";
  const empB = "emp-B";
  seedEmpresa(db, { id: empA, nome: "Empresa A" });
  seedEmpresa(db, { id: empB, nome: "Empresa B" });
  seedUser(db, { id: userId, name: "U" });
  seedMembro(db, empA, userId);
  seedMembro(db, empB, userId);
  await upsertDmActiveEmpresa(db, userId, empA);

  const tools = buildTools(db, {
    empresa_id: empA,
    expert_id: null,
    actor_user_id: userId,
    surface: "dm",
  });
  const result = await invokeTool(getTool(tools, "definir_empresa_ativa"), {
    empresa_id: empB,
  });

  const pin = await getDmActiveEmpresa(db, userId);
  assert.ok(pin, "telegram_dm_active_empresa row must exist for U");
  assert.equal(pin.empresa_id, empB, "pin empresa_id must be B");
  assert.equal(pin.pending_boundary, 1, "pending_boundary must be 1");

  // Direct table read mirrors assertion wording
  const row = db
    .prepare(
      `SELECT user_id, empresa_id, pending_boundary
       FROM telegram_dm_active_empresa WHERE user_id = ?`,
    )
    .get(userId);
  assert.ok(row);
  assert.equal(row.user_id, userId);
  assert.equal(row.empresa_id, empB);
  assert.equal(row.pending_boundary, 1);

  assert.ok(
    isTerminalStopResult(result),
    "tool result must be terminal (signals end-turn / stop)",
  );

  db.close();
});
