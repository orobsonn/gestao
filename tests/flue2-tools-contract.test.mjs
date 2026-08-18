/**
 * Locked Flue 2.x tool envelope contract — createGestaoBotTools run({ data }) shape.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Pins: a tool run({ data }) resolves an envelope OWNING an `output` property
 * (Object.hasOwn, not merely !== undefined); the DM terminal handoff uses
 * `terminate: true` with NO bare `terminal` key (the beta shape must be gone,
 * not merely accompanied); and every tool across the DM ∪ topic union (the
 * factory is surface-conditional — no single call returns all 9) resolves a
 * string or an object owning `output`, never a bare object and never a
 * TypeError from reading an undefined `data`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGestaoBotTools } from "../src/worker/agent/gestao-bot-tools.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

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
 * @description Seed a minimal empresas row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-tools-a";
  const nome = opts.nome ?? "Empresa A";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
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
 * @param {{ empresaId: string, expertId: string, id?: string, nome?: string, status?: string }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const status = opts.status ?? "aberta";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, ?, 'gratuito', ?)`,
  ).run(id, opts.empresaId, opts.expertId, nome, status);
  return {
    id,
    nome,
    status,
    empresaId: opts.empresaId,
    expertId: opts.expertId,
  };
}

/**
 * @description Seed a live tarefa under campanha.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, campanhaId: string, createdBy: string, id?: string, titulo?: string }} opts
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
 * @description Mock sendNotify that records calls and never performs network I/O.
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
 * @param {DatabaseSync} db
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
 * @description Find a tool by name in a ToolDefinition[] returned by createGestaoBotTools.
 * @param {Array<{ name: string, run: Function }>} tools
 * @param {string} name
 */
function getTool(tools, name) {
  const found = tools.find((t) => t && t.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
}

// Bridges lt-flue2-tool-envelope-criar-tarefa's seeded db/tools into the next
// test, per the assertion's own wording ("Given that same seeded DB AFTER the
// insert above"). node:test runs top-level tests in this file serially, in
// definition order, so this hand-off is safe.
let sharedDb = null;
let sharedTools = null;

// ─── lt-flue2-tool-envelope-criar-tarefa ────────────────────────────────────

/**
 * @description criar_tarefa's run({ data: { titulo } }) resolves an envelope owning an `output` property and inserts a tarefas row scoped to closure empresa_id.
 */
test("lt-flue2-tool-envelope-criar-tarefa: run({ data }) resolves envelope owning output; row persisted", async () => {
  const db = openDb();
  const empresaId = "emp-A";
  seedEmpresa(db, { id: empresaId });
  const actor = seedUser(db, { id: "user-actor" });
  seedMembro(db, empresaId, actor.id);
  const expert = seedExpert(db, { id: "expert-E", empresaId });
  seedCampanha(db, {
    id: "camp-open-1",
    empresaId,
    expertId: expert.id,
    status: "aberta",
  });

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expert.id,
    actor_user_id: actor.id,
    surface: "topic",
  });
  const criarTarefa = getTool(tools, "criar_tarefa");
  const envelope = await criarTarefa.run({ data: { titulo: "Comprar cafe" } });

  assert.ok(
    envelope !== null && typeof envelope === "object",
    "criar_tarefa must resolve an object envelope",
  );
  assert.ok(
    Object.hasOwn(envelope, "output"),
    "envelope must own an output property (Flue 2.x shape)",
  );

  const row = getTarefaByTitulo(db, "Comprar cafe");
  assert.ok(row, "a tarefas row with titulo Comprar cafe must exist");
  assert.equal(row.titulo, "Comprar cafe", "row titulo must be Comprar cafe");
  assert.equal(
    row.empresa_id,
    empresaId,
    "row empresa_id must be closure empresa_id emp-A",
  );

  sharedDb = db;
  sharedTools = tools;
});

// ─── lt-flue2-tool-envelope-listar-tarefas ──────────────────────────────────

/**
 * @description listar_tarefas' run({ data: {} }), invoked after the criar_tarefa insert above on the same DB, resolves an envelope whose JSON-stringified output contains the inserted titulo.
 */
test("lt-flue2-tool-envelope-listar-tarefas: run({ data: {} }) output JSON contains inserted titulo", async () => {
  assert.ok(
    sharedDb !== null && sharedTools !== null,
    "lt-flue2-tool-envelope-criar-tarefa must run first and hand off its seeded db/tools",
  );
  const listarTarefas = getTool(sharedTools, "listar_tarefas");
  const envelope = await listarTarefas.run({ data: {} });

  assert.ok(
    envelope !== null && typeof envelope === "object",
    "listar_tarefas must resolve an object envelope",
  );
  assert.ok(
    Object.hasOwn(envelope, "output"),
    "envelope must own an output property (Flue 2.x shape)",
  );
  const text = JSON.stringify(envelope.output);
  assert.ok(
    text.includes("Comprar cafe"),
    "JSON-stringified output must contain Comprar cafe",
  );

  sharedDb.close();
  sharedDb = null;
  sharedTools = null;
});

// ─── lt-flue2-terminate-replaces-terminal ───────────────────────────────────

/**
 * @description DM definir_empresa_ativa's run({ data: { empresa_id } }) for a member resolves an envelope with terminate === true, owning an `output` property, and owning NO `terminal` property — the beta { terminal: true } shape is gone, not merely accompanied.
 */
test("lt-flue2-terminate-replaces-terminal: envelope.terminate === true, no bare terminal key", async () => {
  const db = openDb();
  const empresaId = "emp-A";
  seedEmpresa(db, { id: empresaId });
  const actor = seedUser(db, { id: "user-dm" });
  seedMembro(db, empresaId, actor.id);

  const tools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: null,
    actor_user_id: actor.id,
    surface: "dm",
  });
  const definirEmpresaAtiva = getTool(tools, "definir_empresa_ativa");
  const envelope = await definirEmpresaAtiva.run({
    data: { empresa_id: empresaId },
  });

  assert.ok(
    envelope !== null && typeof envelope === "object",
    "definir_empresa_ativa must resolve an object envelope",
  );
  assert.equal(
    envelope.terminate,
    true,
    "envelope.terminate must be true",
  );
  assert.ok(
    Object.hasOwn(envelope, "output"),
    "envelope must own an output property",
  );
  assert.equal(
    Object.hasOwn(envelope, "terminal"),
    false,
    "envelope must NOT own a terminal property — the beta { terminal: true } shape must be gone",
  );

  db.close();
});

// ─── lt-flue2-every-tool-returns-an-envelope ────────────────────────────────

/**
 * @description The union of the DM and topic tool sets returned by createGestaoBotTools (surface-conditional; no single call returns all 9) has 9 distinct tools by name, and every tool — invoked exactly once via run({ data: <minimal valid input> }) — resolves a string or an object owning an `output` property, never a bare object without output and never a TypeError from reading an undefined data.
 */
test("lt-flue2-every-tool-returns-an-envelope: DM ∪ topic union (9 tools) each resolves string|{output}", async () => {
  const db = openDb();
  const empresaId = "emp-A";
  seedEmpresa(db, { id: empresaId });
  const actor = seedUser(db, { id: "user-actor" });
  seedMembro(db, empresaId, actor.id);
  const target = seedUser(db, { id: "user-target", name: "Target" });
  seedMembro(db, empresaId, target.id);
  const expert = seedExpert(db, { id: "expert-E", empresaId });
  const campanha = seedCampanha(db, {
    id: "camp-union-open",
    empresaId,
    expertId: expert.id,
    status: "aberta",
  });
  const tarefaAtualizar = seedTarefa(db, {
    id: "tar-union-atualizar",
    empresaId,
    campanhaId: campanha.id,
    createdBy: actor.id,
    titulo: "Para atualizar",
  });
  const tarefaExcluir = seedTarefa(db, {
    id: "tar-union-excluir",
    empresaId,
    campanhaId: campanha.id,
    createdBy: actor.id,
    titulo: "Para excluir",
  });

  const notify = mockSendNotify();
  const topicTools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: expert.id,
    actor_user_id: actor.id,
    surface: "topic",
    sendNotify: notify.fn,
  });
  const dmTools = buildTools(db, {
    empresa_id: empresaId,
    expert_id: null,
    actor_user_id: actor.id,
    surface: "dm",
    sendNotify: notify.fn,
  });

  /** @type {Map<string, { name: string, run: Function }>} */
  const union = new Map();
  for (const tool of [...topicTools, ...dmTools]) {
    if (!union.has(tool.name)) union.set(tool.name, tool);
  }
  assert.equal(
    union.size,
    9,
    `union of DM and topic tool sets must have 9 distinct tools, got: ${[...union.keys()].join(",")}`,
  );

  /** @type {Record<string, Record<string, unknown>>} */
  const minimalInput = {
    listar_tarefas: {},
    criar_tarefa: { titulo: "Tarefa uniao" },
    atualizar_tarefa: { id: tarefaAtualizar.id, status: "fazendo" },
    excluir_tarefa: { id: tarefaExcluir.id },
    notificar_usuario: { user_id: target.id, mensagem: "oi" },
    listar_membros: {},
    listar_campanhas: {},
    listar_minhas_empresas: {},
    definir_empresa_ativa: { empresa_id: empresaId },
  };

  for (const [name, tool] of union) {
    assert.ok(
      Object.hasOwn(minimalInput, name),
      `test must define a minimal input for tool ${name}`,
    );
    const data = minimalInput[name];

    let result;
    try {
      result = await tool.run({ data });
    } catch (err) {
      assert.ok(
        !(err instanceof TypeError),
        `${name}: run({ data }) must not throw a TypeError from reading an undefined data (got: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw err;
    }

    const isValidEnvelope =
      typeof result === "string" ||
      (result !== null &&
        typeof result === "object" &&
        Object.hasOwn(result, "output"));
    assert.ok(
      isValidEnvelope,
      `${name}: run({ data }) must resolve a string or an object owning output, got: ${JSON.stringify(result)}`,
    );
  }

  db.close();
});
