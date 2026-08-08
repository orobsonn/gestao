/**
 * Locked D1 turn-token bridge + gestao-bot agent sandbox/FK/terminal-stop contract.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 *
 * Expected production exports (executor creates):
 *   insertTurnContext, consumeTurnContext from ../src/worker/agent/turn-context-store.ts
 *   createAgentSecretGuard, isTerminalToolResult, runAgentToolCallsUntilStop,
 *     gestaoBotAgent (or default / agent config with sandbox.tools)
 *     from ../.flue/agents/gestao-bot.ts
 *   createGestaoBotTools from ../src/worker/agent/gestao-bot-tools.ts (exists)
 *   decryptLlmApiKey from ../src/worker/services/llm-key-crypto.ts
 *
 * No bot_token column in telegram_agent_turn_context (env botToken only — task-2 sniper).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGestaoBotTools } from "../src/worker/agent/gestao-bot-tools.ts";
import {
  consumeTurnContext,
  insertTurnContext,
} from "../src/worker/agent/turn-context-store.ts";
import { decryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";
import {
  gestaoBotAgent,
  isTerminalToolResult,
  runAgentToolCallsUntilStop,
} from "../.flue/agents/gestao-bot.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const TEST_ENCRYPTION_SECRET =
  "test-llm-key-encryption-secret-turn-bridge-hermetic";
const PLAINTEXT_ROUNDTRIP = "sk-test-roundtrip";

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
 * @description Seed a minimal users row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-bridge-u";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Bridge User";
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
  const id = opts.id ?? "emp-bridge-a";
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
  const id = opts.id ?? "expert-bridge-e";
  const nome = opts.nome ?? "Expert E";
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, opts.empresaId, nome);
  return { id, nome, empresaId: opts.empresaId };
}

/**
 * @description Seed a campanha under expert.
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   expertId: string,
 *   id?: string,
 *   nome?: string,
 *   status?: string,
 * }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Bridge";
  const status = opts.status ?? "aberta";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, ?, 'gratuito', ?)`,
  ).run(id, opts.empresaId, opts.expertId, nome, status);
  return { id, nome, status, empresaId: opts.empresaId, expertId: opts.expertId };
}

/**
 * @description Extract turn_token from insertTurnContext return value.
 * @param {unknown} inserted
 */
function turnTokenOf(inserted) {
  if (typeof inserted === "string") return inserted;
  if (inserted && typeof inserted === "object") {
    const o = /** @type {Record<string, unknown>} */ (inserted);
    const t = o.turn_token ?? o.turnToken ?? o.token;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return null;
}

/**
 * @description Normalize consumeTurnContext result to a plain fields object or fail marker.
 * @param {unknown} result
 */
function normalizeConsume(result) {
  if (result == null) {
    return { ok: false, reason: "not_found" };
  }
  if (typeof result === "object") {
    const o = /** @type {Record<string, unknown>} */ (result);
    if (o.ok === false) {
      return {
        ok: false,
        reason: String(o.reason ?? o.error ?? "not_found"),
      };
    }
    // ok:true wrapper or bare fields
    const fields =
      o.ok === true && o.turn && typeof o.turn === "object"
        ? /** @type {Record<string, unknown>} */ (o.turn)
        : o.ok === true && o.context && typeof o.context === "object"
          ? /** @type {Record<string, unknown>} */ (o.context)
          : o;
    return {
      ok: true,
      empresa_id: String(fields.empresa_id ?? fields.empresaId ?? ""),
      expert_id:
        fields.expert_id === undefined && fields.expertId === undefined
          ? null
          : fields.expert_id ?? fields.expertId ?? null,
      actor_user_id: String(
        fields.actor_user_id ?? fields.actorUserId ?? fields.userId ?? "",
      ),
      surface: String(fields.surface ?? ""),
      provider: String(fields.provider ?? ""),
      apiKey: String(fields.apiKey ?? fields.api_key ?? ""),
      message: String(fields.message ?? ""),
      dm_boundary_line:
        fields.dm_boundary_line ?? fields.dmBoundaryLine ?? null,
    };
  }
  return { ok: false, reason: "not_found" };
}

/**
 * @description Find tool by name from createGestaoBotTools return value.
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
  assert.fail("tools must be an array of ToolDefinitions");
}

/**
 * @description Invoke tool via run({ input }).
 * @param {{ run: Function }} tool
 * @param {Record<string, unknown>} [input]
 */
async function invokeTool(tool, input = {}) {
  return tool.run({ input });
}

/**
 * @description Resolve sandbox.tools from agent export/config.
 * @param {unknown} agent
 */
function resolveSandboxTools(agent) {
  assert.ok(agent != null, "gestaoBotAgent export must exist");
  /** @type {unknown} */
  let sandbox = null;
  if (typeof agent === "object") {
    const a = /** @type {Record<string, unknown>} */ (agent);
    sandbox =
      a.sandbox ??
      (a.config && typeof a.config === "object"
        ? /** @type {Record<string, unknown>} */ (a.config).sandbox
        : null) ??
      (a.options && typeof a.options === "object"
        ? /** @type {Record<string, unknown>} */ (a.options).sandbox
        : null) ??
      (a.definition && typeof a.definition === "object"
        ? /** @type {Record<string, unknown>} */ (a.definition).sandbox
        : null);
  }
  assert.ok(
    sandbox && typeof sandbox === "object",
    "agent must expose sandbox config",
  );
  const tools = /** @type {Record<string, unknown>} */ (sandbox).tools;
  return tools;
}

// ─── lt-agent-tools-from-turn-bridge ───────────────────────────────────────

/**
 * @description Simulated DO boundary: insertTurnContext + consumeTurnContext → createGestaoBotTools from DO-local context; criar_tarefa persists empresa_id=A created_by=U only.
 */
test("lt-agent-tools-from-turn-bridge: consume turn → tools closure A/U → criar_tarefa empresa_id=A created_by=U", async () => {
  const db = openDb();
  const empA = seedEmpresa(db, { id: "emp-A", nome: "Empresa A" });
  const userU = seedUser(db, { id: "user-U", name: "User U" });
  seedMembro(db, empA.id, userU.id);
  const expert = seedExpert(db, { id: "expert-E", empresaId: empA.id });
  const camp = seedCampanha(db, {
    id: "camp-A1",
    empresaId: empA.id,
    expertId: expert.id,
    status: "aberta",
  });

  // Worker-side: insert turn context (gated fields in D1; POST body would be {message} only)
  const inserted = await insertTurnContext(db, {
    empresaId: empA.id,
    expertId: null,
    actorUserId: userU.id,
    surface: "dm",
    provider: "openai",
    apiKey: "sk-test-bridge-tools",
    message: "criar tarefa via bridge",
    encryptionSecret: TEST_ENCRYPTION_SECRET,
  });
  const token = turnTokenOf(inserted);
  assert.ok(token, "insertTurnContext must return turn_token");

  // DO-side: consume turn token (single-use load)
  const consumed = normalizeConsume(
    await consumeTurnContext(db, token, TEST_ENCRYPTION_SECRET),
  );
  assert.equal(consumed.ok, true, "consumeTurnContext must load turn fields");
  assert.equal(consumed.empresa_id, empA.id);
  assert.equal(consumed.actor_user_id, userU.id);

  // Build tools from DO-local context (not from model body)
  const tools = createGestaoBotTools({
    empresa_id: consumed.empresa_id,
    expert_id:
      consumed.expert_id == null || consumed.expert_id === ""
        ? null
        : String(consumed.expert_id),
    actor_user_id: consumed.actor_user_id,
    surface: /** @type {'dm'} */ ("dm"),
    db,
    sendNotify: async () => {},
  });

  const titulo = "Tarefa via turn bridge";
  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo,
    campanha_id: camp.id,
  });

  const row = db
    .prepare(
      `SELECT empresa_id, created_by, titulo, deleted_at
       FROM tarefas WHERE titulo = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(titulo);
  assert.ok(row, "criar_tarefa must persist a tarefas row");
  assert.equal(row.empresa_id, empA.id, "empresa_id must be A only");
  assert.equal(row.created_by, userU.id, "created_by must be U only");
  assert.equal(row.deleted_at, null);

  // No row under a foreign empresa
  const foreign = db
    .prepare(`SELECT count(*) AS n FROM tarefas WHERE empresa_id != ?`)
    .get(empA.id);
  assert.equal(Number(foreign?.n ?? 0), 0, "no tarefas under non-A empresa");

  db.close();
});

// ─── lt-turn-token-single-use-no-replay ────────────────────────────────────

/**
 * @description consumeTurnContext is single-use: first returns fields and deletes row; second is not-found/expired with count=0.
 */
test("lt-turn-token-single-use-no-replay: first consume returns fields+deletes; second not-found count=0", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-replay-a" });
  const user = seedUser(db, { id: "user-replay-1" });

  const inserted = await insertTurnContext(db, {
    empresaId: emp.id,
    expertId: null,
    actorUserId: user.id,
    surface: "dm",
    provider: "openai",
    apiKey: "sk-test-replay",
    message: "msg replay",
    encryptionSecret: TEST_ENCRYPTION_SECRET,
  });
  const token = turnTokenOf(inserted);
  assert.ok(token, "insertTurnContext must return turn_token");

  const first = normalizeConsume(
    await consumeTurnContext(db, token, TEST_ENCRYPTION_SECRET),
  );
  assert.equal(first.ok, true, "first consume must return turn fields");
  assert.equal(first.empresa_id, emp.id);
  assert.equal(first.actor_user_id, user.id);
  assert.equal(first.message, "msg replay");

  const countAfterFirst = db
    .prepare(
      `SELECT count(*) AS n FROM telegram_agent_turn_context WHERE turn_token = ?`,
    )
    .get(token);
  assert.equal(
    Number(countAfterFirst?.n ?? -1),
    0,
    "row must be deleted after first consume",
  );

  const second = normalizeConsume(
    await consumeTurnContext(db, token, TEST_ENCRYPTION_SECRET),
  );
  assert.equal(second.ok, false, "second consume must fail");
  assert.ok(
    /not[_-]?found|expired|missing|invalid|gone/i.test(String(second.reason)),
    `second consume reason must be not-found/expired, got: ${second.reason}`,
  );

  const countFinal = db
    .prepare(`SELECT count(*) AS n FROM telegram_agent_turn_context`)
    .get();
  assert.equal(
    Number(countFinal?.n ?? -1),
    0,
    "SELECT count must be 0 after replay attempt",
  );

  db.close();
});

// ─── lt-turn-context-key-roundtrip ─────────────────────────────────────────

/**
 * @description insertTurnContext stores non-empty ciphertext+iv (≠ plaintext); consumeTurnContext decrypts to original sk-test-roundtrip.
 */
test("lt-turn-context-key-roundtrip: ciphertext+iv at rest; decrypt yields sk-test-roundtrip", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-roundtrip-a" });
  const user = seedUser(db, { id: "user-roundtrip-1" });

  const inserted = await insertTurnContext(db, {
    empresaId: emp.id,
    expertId: null,
    actorUserId: user.id,
    surface: "topic",
    provider: "anthropic",
    apiKey: PLAINTEXT_ROUNDTRIP,
    message: "roundtrip message",
    encryptionSecret: TEST_ENCRYPTION_SECRET,
  });
  const token = turnTokenOf(inserted);
  assert.ok(token, "insertTurnContext must return turn_token");

  // Inspect D1 row BEFORE consume (consume deletes)
  const row = db
    .prepare(
      `SELECT api_key_ciphertext, api_key_iv, message
       FROM telegram_agent_turn_context WHERE turn_token = ?`,
    )
    .get(token);
  assert.ok(row, "D1 row must exist after insert");
  assert.equal(typeof row.api_key_ciphertext, "string");
  assert.equal(typeof row.api_key_iv, "string");
  assert.ok(
    row.api_key_ciphertext.length > 0,
    "api_key_ciphertext must be non-empty TEXT",
  );
  assert.ok(row.api_key_iv.length > 0, "api_key_iv must be non-empty TEXT");
  assert.notEqual(
    row.api_key_ciphertext,
    PLAINTEXT_ROUNDTRIP,
    "ciphertext must not equal plaintext apiKey",
  );

  // Direct decrypt of stored pair must yield original (encryptLlmApiKey contract)
  const direct = await decryptLlmApiKey(
    TEST_ENCRYPTION_SECRET,
    row.api_key_ciphertext,
    row.api_key_iv,
  );
  assert.equal(direct, PLAINTEXT_ROUNDTRIP);

  const consumed = normalizeConsume(
    await consumeTurnContext(db, token, TEST_ENCRYPTION_SECRET),
  );
  assert.equal(consumed.ok, true);
  assert.equal(
    consumed.apiKey,
    PLAINTEXT_ROUNDTRIP,
    "consumeTurnContext must decrypt to original plaintext sk-test-roundtrip",
  );

  db.close();
});

// ─── lt-sandbox-tools-empty ────────────────────────────────────────────────

/**
 * @description gestao-bot defineAgent sandbox.tools is a function that returns [] without bash/write/edit.
 */
test("lt-sandbox-tools-empty: sandbox.tools is () => [] without bash/write/edit", () => {
  const sandboxTools = resolveSandboxTools(gestaoBotAgent);
  assert.equal(
    typeof sandboxTools,
    "function",
    "sandbox.tools must be a function (factory)",
  );

  const list = sandboxTools();
  assert.ok(Array.isArray(list), "sandbox.tools() must return an array");
  assert.equal(list.length, 0, "sandbox.tools() must return []");

  const names = list.map((t) => {
    if (t && typeof t === "object" && "name" in t) {
      return String(/** @type {{ name: unknown }} */ (t).name);
    }
    return String(t);
  });
  for (const forbidden of ["bash", "write", "edit"]) {
    assert.equal(
      names.includes(forbidden),
      false,
      `sandbox tools must not include ${forbidden}`,
    );
  }
});

// ─── lt-agent-path-enables-fk-pragma ───────────────────────────────────────

/**
 * @description After turn context is loaded, tools path awaits enableForeignKeysAsync (PRAGMA foreign_keys=ON) on env.DB before INSERT.
 */
test("lt-agent-path-enables-fk-pragma: enableForeignKeysAsync awaited on env.DB before criar_tarefa INSERT", async () => {
  const raw = openDbWithoutFk();
  const fkBefore = raw.prepare("PRAGMA foreign_keys").get();
  assert.equal(
    Number(
      /** @type {{ foreign_keys?: number }} */ (fkBefore)?.foreign_keys ?? 0,
    ),
    0,
    "db must start with foreign_keys OFF",
  );

  const emp = seedEmpresa(raw, { id: "emp-fk-a" });
  const user = seedUser(raw, { id: "user-fk-1" });
  seedMembro(raw, emp.id, user.id);
  const expert = seedExpert(raw, { id: "expert-fk-e", empresaId: emp.id });
  seedCampanha(raw, {
    id: "camp-fk-1",
    empresaId: emp.id,
    expertId: expert.id,
    status: "aberta",
  });

  const inserted = await insertTurnContext(raw, {
    empresaId: emp.id,
    expertId: expert.id,
    actorUserId: user.id,
    surface: "topic",
    provider: "openai",
    apiKey: "sk-test-fk-path",
    message: "fk path",
    encryptionSecret: TEST_ENCRYPTION_SECRET,
  });
  const token = turnTokenOf(inserted);
  assert.ok(token);

  // Turn context loaded (DO-side)
  const consumed = normalizeConsume(
    await consumeTurnContext(raw, token, TEST_ENCRYPTION_SECRET),
  );
  assert.equal(consumed.ok, true);

  /** @type {string[]} */
  const sqlLog = [];
  /** @type {number | null} */
  let enableFkCallOrder = null;
  /** @type {number | null} */
  let insertOrder = null;

  const spyDb = {
    prepare(sql) {
      const s = String(sql);
      const idx = sqlLog.length;
      sqlLog.push(s);
      if (/PRAGMA\s+foreign_keys\s*=\s*ON/i.test(s)) {
        enableFkCallOrder = idx;
      }
      if (/INSERT\s+INTO\s+tarefas/i.test(s)) {
        insertOrder = idx;
      }
      const stmt = raw.prepare(s);
      return {
        run: (...params) => stmt.run(...params),
        get: (...params) => stmt.get(...params),
        all: (...params) => (stmt.all ? stmt.all(...params) : []),
      };
    },
  };

  // Agent/tools path after turn context loaded — build tools from DO-local context with spy db (env.DB)
  const tools = createGestaoBotTools({
    empresa_id: consumed.empresa_id,
    expert_id: String(consumed.expert_id ?? expert.id),
    actor_user_id: consumed.actor_user_id,
    surface: "topic",
    db: spyDb,
    sendNotify: async () => {},
  });

  await invokeTool(getTool(tools, "criar_tarefa"), {
    titulo: "FK agent path task",
  });

  assert.notEqual(
    enableFkCallOrder,
    null,
    "enableForeignKeysAsync / PRAGMA foreign_keys=ON must run on env.DB",
  );
  assert.notEqual(insertOrder, null, "INSERT INTO tarefas must run");
  assert.ok(
    /** @type {number} */ (enableFkCallOrder) <
      /** @type {number} */ (insertOrder),
    "enableForeignKeysAsync must be awaited before the INSERT",
  );

  const fkAfter = raw.prepare("PRAGMA foreign_keys").get();
  assert.equal(
    Number(
      /** @type {{ foreign_keys?: number }} */ (fkAfter)?.foreign_keys ?? 0,
    ),
    1,
    "subsequent PRAGMA foreign_keys read must be ON",
  );

  raw.close();
});

// ─── lt-agent-stops-after-definir-empresa-ativa-terminal ────────────────────

/**
 * @description DM turn: after definir_empresa_ativa terminal stop result, no second tool call runs in the same turn (tool-terminal-stop).
 */
test("lt-agent-stops-after-definir-empresa-ativa-terminal: no second tool after definir_empresa_ativa terminal", async () => {
  const db = openDb();
  const empA = seedEmpresa(db, { id: "emp-A", nome: "Empresa A" });
  const empB = seedEmpresa(db, { id: "emp-B", nome: "Empresa B" });
  const user = seedUser(db, { id: "user-U", name: "U" });
  seedMembro(db, empA.id, user.id);
  seedMembro(db, empB.id, user.id);
  const expertB = seedExpert(db, { id: "expert-B", empresaId: empB.id });
  const campB = seedCampanha(db, {
    id: "camp-B1",
    empresaId: empB.id,
    expertId: expertB.id,
    status: "aberta",
  });

  // Pin currently on A (switch target B)
  db.prepare(
    `INSERT INTO telegram_dm_active_empresa (user_id, empresa_id, pending_boundary)
     VALUES (?, ?, 0)`,
  ).run(user.id, empA.id);

  const tools = createGestaoBotTools({
    empresa_id: empA.id,
    expert_id: null,
    actor_user_id: user.id,
    surface: "dm",
    db,
    sendNotify: async () => {},
  });

  /** @type {string[]} */
  const invoked = [];
  const wrapped = (Array.isArray(tools) ? tools : []).map((t) => {
    assert.ok(t && typeof t === "object" && "name" in t && "run" in t);
    const tool = /** @type {{ name: string, run: Function }} */ (t);
    return {
      name: tool.name,
      run: async (args) => {
        invoked.push(tool.name);
        return tool.run(args);
      },
    };
  });

  // Production turn loop must stop after terminal tool result (dm_switch_end_turn_mechanism=tool-terminal-stop)
  assert.equal(
    typeof runAgentToolCallsUntilStop,
    "function",
    "runAgentToolCallsUntilStop must be exported from gestao-bot agent module",
  );
  assert.equal(
    typeof isTerminalToolResult,
    "function",
    "isTerminalToolResult must be exported from gestao-bot agent module",
  );

  await runAgentToolCallsUntilStop({
    tools: wrapped,
    calls: [
      { name: "definir_empresa_ativa", input: { empresa_id: empB.id } },
      // Would-be second tool in the same turn — must NOT execute
      {
        name: "criar_tarefa",
        input: { titulo: "nao-deve-rodar", campanha_id: campB.id },
      },
    ],
  });

  assert.deepEqual(
    invoked,
    ["definir_empresa_ativa"],
    "only definir_empresa_ativa may run; no second tool after terminal stop",
  );

  const orphanTask = db
    .prepare(`SELECT count(*) AS n FROM tarefas WHERE titulo = ?`)
    .get("nao-deve-rodar");
  assert.equal(
    Number(orphanTask?.n ?? 0),
    0,
    "criar_tarefa must not run after definir_empresa_ativa terminal",
  );

  // Terminal predicate recognizes the real tool result
  const directTools = createGestaoBotTools({
    empresa_id: empB.id,
    expert_id: null,
    actor_user_id: user.id,
    surface: "dm",
    db,
    sendNotify: async () => {},
  });
  // Already switched to B; calling again for B still terminal
  const terminalResult = await invokeTool(
    getTool(directTools, "definir_empresa_ativa"),
    { empresa_id: empB.id },
  );
  assert.equal(
    isTerminalToolResult(terminalResult),
    true,
    "isTerminalToolResult must be true for definir_empresa_ativa terminal stop result",
  );

  db.close();
});
