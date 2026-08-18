/**
 * Locked flue2-signal-attributes contract — the D1 "turn context" bridge is deleted, the turn's
 * non-secret facts travel in the dispatched SIGNAL instead of a database row:
 *   { kind: 'signal', type: 'telegram.message', body: <user text>,
 *     attributes: { empresaId, expertId, actorUserId, surface, provider, modelId, dmBoundaryLine } }
 * That attribute list is closed and carries no key material. The Worker-side admission gate
 * (loadEmpresaLlmForBot) stays and stays fail-closed. Hermetic: node:sqlite :memory:,
 * PRAGMA foreign_keys=ON, every migrations/*.sql sorted by filename.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";
import {
  getDmActiveEmpresa,
  setDmPendingBoundary,
  upsertDmActiveEmpresa,
} from "../src/worker/services/telegram-dm-active-empresa.ts";
import { handleBotTurn } from "../src/worker/services/bot-turn-orchestrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "migrations");
const ORCHESTRATOR_SRC = resolve(
  REPO_ROOT,
  "src/worker/services/bot-turn-orchestrator.ts",
);

const TEST_ENCRYPTION_SECRET =
  "test-llm-key-encryption-secret-flue2-signal-attrs-hermetic";
const BOT_USERNAME = "GestaoBot";

// Existing pt-br copies, taken literally from bot-turn-orchestrator.ts.
const FAIL_UNLINKED =
  "Desculpe, você não está vinculado a esta empresa no Gestão. Use /vincular para conectar sua conta Telegram.";
const FAIL_LLM =
  "Configuração de LLM ausente ou inválida para esta empresa. Verifique as configurações de provedor e chave API.";
const FAIL_N0 =
  "Nenhuma empresa com membership ativa. Solicite acesso ou tente novamente mais tarde.";
const DM_BOUNDARY_LINE =
  "Atenção: resultados de ferramentas anteriores podem pertencer a outra empresa/tenant.";

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
 * @description Seed a minimal users row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-flue2-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Flue2 User";
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, "hash", "salt");
  return { id, email, name };
}

/**
 * @description Seed a minimal empresas row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string, deleted_at?: string | null }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-flue2-a";
  const nome = opts.nome ?? "Empresa Flue2 A";
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
  ).run(userId, String(telegramUserId));
}

/**
 * @description Seed a live expert row.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, id?: string, nome?: string }} opts
 */
function seedExpert(db, opts) {
  const id = opts.id ?? "expert-flue2-e";
  const nome = opts.nome ?? "Expert Flue2";
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, opts.empresaId, nome);
  return { id, nome, empresaId: opts.empresaId };
}

/**
 * @description Seed empresa_telegram_chats + expert_telegram_topics.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, expertId: string, chatId: string, messageThreadId: string }} opts
 */
function seedTopicMap(db, opts) {
  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id) VALUES (?, ?)`,
  ).run(opts.empresaId, opts.chatId);
  db.prepare(
    `INSERT INTO expert_telegram_topics
      (expert_id, empresa_id, chat_id, message_thread_id)
     VALUES (?, ?, ?, ?)`,
  ).run(opts.expertId, opts.empresaId, opts.chatId, opts.messageThreadId);
}

/**
 * @description Seed empresa_llm_settings row directly.
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   provider?: string | null,
 *   ciphertext?: string | null,
 *   iv?: string | null,
 *   status?: string,
 * }} opts
 */
function seedLlmSettings(db, opts) {
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, api_key_ciphertext, api_key_iv, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.empresaId,
    opts.provider ?? null,
    opts.ciphertext ?? null,
    opts.iv ?? null,
    opts.status ?? "unvalidated",
  );
}

/**
 * @description Seed valid LLM settings with encryptLlmApiKey under TEST_ENCRYPTION_SECRET.
 * @param {DatabaseSync} db
 * @param {string} empresaId
 * @param {string} [plaintext]
 */
async function seedValidLlm(db, empresaId, plaintext) {
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    TEST_ENCRYPTION_SECRET,
    plaintext,
  );
  seedLlmSettings(db, {
    empresaId,
    provider: "openai",
    ciphertext: ciphertextHex,
    iv: ivHex,
    status: "valid",
  });
  return { ciphertextHex, ivHex, plaintext };
}

/**
 * @description Topic @mention update fragment (case-insensitive bot username via entities).
 * @param {{
 *   telegramUserId: string | number,
 *   chatId?: string | number,
 *   threadId?: string | number,
 *   text?: string,
 *   botUsername?: string,
 * }} opts
 */
function topicMentionUpdate(opts) {
  const bot = opts.botUsername ?? BOT_USERNAME;
  const mention = `@${bot}`;
  const rest = opts.text ?? " criar tarefa";
  const text = `${mention}${rest}`;
  const chatId = opts.chatId ?? -1001;
  const threadId = opts.threadId ?? 7;
  return {
    update_id: 900001,
    message: {
      message_id: 1,
      from: {
        id: Number(opts.telegramUserId) || opts.telegramUserId,
        is_bot: false,
        first_name: "Actor",
      },
      chat: {
        id: chatId,
        type: "supergroup",
        title: "Grupo",
        is_forum: true,
      },
      message_thread_id: threadId,
      text,
      entities: [
        {
          type: "mention",
          offset: 0,
          length: mention.length,
        },
      ],
      date: Math.floor(Date.now() / 1000),
    },
  };
}

/**
 * @description Private DM text update fragment.
 * @param {{ telegramUserId: string | number, text?: string }} opts
 */
function dmTextUpdate(opts) {
  const tgId = opts.telegramUserId;
  return {
    update_id: 900002,
    message: {
      message_id: 2,
      from: {
        id: Number(tgId) || tgId,
        is_bot: false,
        first_name: "DmUser",
      },
      chat: {
        id: Number(tgId) || tgId,
        type: "private",
        first_name: "DmUser",
      },
      text: opts.text ?? "oi",
      date: Math.floor(Date.now() / 1000),
    },
  };
}

/**
 * @description Extract the "dispatched message" (the signal object) from a captured
 * runAgentTurn call args object — the args' `message` field per the flue2 contract:
 * { kind: 'signal', type: 'telegram.message', body, attributes }.
 * @param {unknown} capturedArgs
 */
function dispatchedMessageOf(capturedArgs) {
  assert.ok(
    capturedArgs && typeof capturedArgs === "object",
    "runAgentTurn must be called with an args object",
  );
  const message = /** @type {{ message?: unknown }} */ (capturedArgs).message;
  assert.ok(
    message && typeof message === "object",
    "runAgentTurn args.message must be the dispatched signal object",
  );
  return /** @type {Record<string, unknown>} */ (message);
}

/**
 * @description Extract the `attributes` object off the dispatched signal message.
 * @param {unknown} capturedArgs
 */
function dispatchedAttributesOf(capturedArgs) {
  const message = dispatchedMessageOf(capturedArgs);
  const attributes = message.attributes;
  assert.ok(
    attributes && typeof attributes === "object",
    "dispatched signal message must carry an attributes object",
  );
  return /** @type {Record<string, unknown>} */ (attributes);
}

/**
 * @description Sum row counts across every table whose name contains "turn" (schema-agnostic
 * check for "no row was written to any turn table" after the D1 turn-context bridge is gone).
 * @param {DatabaseSync} db
 */
function anyTurnTableRowCount(db) {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%turn%'`,
    )
    .all();
  let total = 0;
  for (const t of tables) {
    const row = db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get();
    total += Number(row?.n ?? 0);
  }
  return total;
}

// ─── lt-flue2-turn-context-bridge-is-gone ──────────────────────────────────

/**
 * @description Fixes the contract that the D1 turn-context bridge no longer exists: no
 * telegram_agent_turn_context table after every migration is applied, and neither bridge module
 * file (turn-context-store.ts, turn-context-als.ts) exists on disk.
 */
test("lt-flue2-turn-context-bridge-is-gone: no telegram_agent_turn_context table; bridge modules absent from disk", () => {
  const db = openDb();

  const tableRow = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_agent_turn_context'`,
    )
    .get();
  assert.equal(
    tableRow,
    undefined,
    "telegram_agent_turn_context table must not exist after every migration is applied",
  );

  assert.equal(
    existsSync(resolve(REPO_ROOT, "src/worker/agent/turn-context-store.ts")),
    false,
    "src/worker/agent/turn-context-store.ts must not exist",
  );
  assert.equal(
    existsSync(resolve(REPO_ROOT, "src/worker/agent/turn-context-als.ts")),
    false,
    "src/worker/agent/turn-context-als.ts must not exist",
  );

  db.close();
});

// ─── lt-flue2-signal-attributes-carry-no-key ───────────────────────────────

/**
 * @description Fixes the contract that the dispatched signal's attributes carry the closed key
 * set (no dmBoundaryLine on a topic turn) and never the tenant's LLM API key material anywhere
 * in the captured runAgentTurn call — asserted on the key's VALUE, never on a field name.
 */
test("lt-flue2-signal-attributes-carry-no-key: topic turn attributes are the closed key set and never leak the API key value", async () => {
  const db = openDb();
  const secretApiKey = "sk-live-tenant-a-1234567890";
  const emp = seedEmpresa(db, { id: "emp-flue2-nokey", nome: "Empresa Flue2 NoKey" });
  const expert = seedExpert(db, { id: "expert-flue2-nokey", empresaId: emp.id });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-5001",
    messageThreadId: "3",
  });
  const user = seedUser(db, { id: "user-flue2-nokey" });
  const tgId = "111001";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id, secretApiKey);

  /** @type {unknown[]} */
  const agentCalls = [];
  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: tgId,
      chatId: -5001,
      threadId: 3,
      text: " criar tarefa",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "ok";
    },
  });

  assert.ok(result, "handleBotTurn must resolve a result");
  assert.equal(agentCalls.length, 1, "runAgentTurn must be called exactly once");

  const captured = agentCalls[0];
  const attributes = dispatchedAttributesOf(captured);
  assert.deepEqual(
    Object.keys(attributes).sort(),
    ["actorUserId", "empresaId", "expertId", "modelId", "provider", "surface"],
    "dispatched attributes key set must be exactly {empresaId, expertId, actorUserId, surface, provider, modelId} on a topic turn (no dmBoundaryLine)",
  );

  const serialized = JSON.stringify(captured);
  assert.equal(
    serialized.includes(secretApiKey),
    false,
    "the captured runAgentTurn call must never contain the tenant's plaintext API key value",
  );

  db.close();
});

// ─── lt-flue2-dm-boundary-cleared-exactly-once ─────────────────────────────

/**
 * @description Fixes the contract that dmBoundaryLine is the existing pt-br boundary sentence on
 * the DM turn processed while pending_boundary=1, that pending_boundary is cleared to 0 by the
 * Worker afterwards, and that dmBoundaryLine is absent entirely (no key) on the very next DM turn
 * — the line is cleared exactly once.
 */
test("lt-flue2-dm-boundary-cleared-exactly-once: dmBoundaryLine present once then absent as a key on the next DM turn", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-flue2-boundary" });
  const tgId = "111002";
  seedTelegramLink(db, user.id, tgId);
  const emp = seedEmpresa(db, { id: "emp-flue2-boundary", nome: "Empresa Flue2 Boundary" });
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id, "sk-flue2-boundary-key");

  await upsertDmActiveEmpresa(db, user.id, emp.id);
  await setDmPendingBoundary(db, user.id, 1);
  const pinBefore = await getDmActiveEmpresa(db, user.id);
  assert.equal(pinBefore?.pending_boundary, 1, "fixture must start with pending_boundary=1");

  /** @type {unknown[]} */
  const firstCalls = [];
  await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId, text: "listar minhas tarefas" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      firstCalls.push(args);
      return "ok";
    },
  });

  assert.equal(firstCalls.length, 1, "first DM turn must reach runAgentTurn once");
  const firstAttributes = dispatchedAttributesOf(firstCalls[0]);
  assert.equal(
    firstAttributes.dmBoundaryLine,
    DM_BOUNDARY_LINE,
    "first DM turn's dispatched attributes.dmBoundaryLine must equal the existing pt-br boundary sentence",
  );

  const pinAfterFirst = await getDmActiveEmpresa(db, user.id);
  assert.equal(
    pinAfterFirst?.pending_boundary,
    0,
    "pending_boundary must be 0 in telegram_dm_active_empresa after the first turn",
  );

  /** @type {unknown[]} */
  const secondCalls = [];
  await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId, text: "e agora?" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      secondCalls.push(args);
      return "ok";
    },
  });

  assert.equal(secondCalls.length, 1, "second DM turn must reach runAgentTurn once");
  const secondAttributes = dispatchedAttributesOf(secondCalls[0]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(secondAttributes, "dmBoundaryLine"),
    false,
    "second DM turn's dispatched attributes must have NO dmBoundaryLine key at all",
  );

  db.close();
});

// ─── lt-flue2-invalid-llm-fails-closed ──────────────────────────────────────

/**
 * @description Fixes the fail-closed contract for an invalid LLM configuration: the reply equals
 * the existing FAIL_LLM pt-br copy, runAgentTurn is never called, and no row is written to any
 * turn table.
 */
test("lt-flue2-invalid-llm-fails-closed: invalid empresa_llm_settings.status → FAIL_LLM copy, runAgentTurn never called, no turn row", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-flue2-invalid-llm", nome: "Empresa Flue2 Invalid LLM" });
  const expert = seedExpert(db, { id: "expert-flue2-invalid-llm", empresaId: emp.id });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-5002",
    messageThreadId: "4",
  });
  const user = seedUser(db, { id: "user-flue2-invalid-llm" });
  const tgId = "111003";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    TEST_ENCRYPTION_SECRET,
    "sk-flue2-invalid-llm-key",
  );
  seedLlmSettings(db, {
    empresaId: emp.id,
    provider: "openai",
    ciphertext: ciphertextHex,
    iv: ivHex,
    status: "invalid",
  });

  const turnRowsBefore = anyTurnTableRowCount(db);
  /** @type {unknown[]} */
  const agentCalls = [];
  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: tgId,
      chatId: -5002,
      threadId: 4,
      text: " status",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "should-not-run";
    },
  });

  assert.equal(
    result.reply,
    FAIL_LLM,
    "reply must equal the existing FAIL_LLM pt-br copy",
  );
  assert.equal(agentCalls.length, 0, "runAgentTurn must never be called");
  assert.equal(
    anyTurnTableRowCount(db),
    turnRowsBefore,
    "no row must be written to any turn table",
  );

  db.close();
});

// ─── lt-flue2-unlinked-user-fails-closed ────────────────────────────────────

/**
 * @description Fixes the fail-closed contract for a DM from a telegram user with no
 * user_telegram_links row: the reply equals the existing FAIL_UNLINKED pt-br copy and
 * runAgentTurn is never called.
 */
test("lt-flue2-unlinked-user-fails-closed: DM from unlinked telegram user → FAIL_UNLINKED copy, runAgentTurn never called", async () => {
  const db = openDb();
  const tgId = "111004";

  /** @type {unknown[]} */
  const agentCalls = [];
  const result = await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId, text: "oi" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "should-not-run";
    },
  });

  assert.equal(
    result.reply,
    FAIL_UNLINKED,
    "reply must equal the existing FAIL_UNLINKED pt-br copy",
  );
  assert.equal(agentCalls.length, 0, "runAgentTurn must never be called");

  db.close();
});

// ─── lt-flue2-dm-session-id-is-empresa-scoped ───────────────────────────────

/**
 * @description Fixes the contract that a DM sessionId is empresa-scoped: it starts with
 * 'dm2:<empresaId>:' and contains neither the legacy 'dm:' form nor 'topic:'.
 */
test("lt-flue2-dm-session-id-is-empresa-scoped: DM sessionId starts with dm2:<empresaId>: and has no dm:/topic: substrings", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-flue2-session" });
  const tgId = "111005";
  seedTelegramLink(db, user.id, tgId);
  const emp = seedEmpresa(db, { id: "emp-A", nome: "Empresa A" });
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id, "sk-flue2-session-key");
  await upsertDmActiveEmpresa(db, user.id, emp.id);

  /** @type {Record<string, unknown>[]} */
  const agentCalls = [];
  await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId, text: "oi" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(/** @type {Record<string, unknown>} */ (args ?? {}));
      return "ok";
    },
  });

  assert.equal(agentCalls.length, 1, "runAgentTurn must be called exactly once");
  const sessionId = String(agentCalls[0].sessionId ?? "");
  assert.ok(
    sessionId.startsWith("dm2:emp-A:"),
    `sessionId must start with 'dm2:emp-A:', got: ${sessionId}`,
  );
  assert.equal(
    sessionId.includes("dm:"),
    false,
    `sessionId must not contain the legacy 'dm:' substring, got: ${sessionId}`,
  );
  assert.equal(
    sessionId.includes("topic:"),
    false,
    `sessionId must not contain 'topic:', got: ${sessionId}`,
  );

  db.close();
});

// ─── lt-flue2-no-membership-fails-closed-and-clears-pin ─────────────────────

/**
 * @description Fixes the fail-closed contract for a linked telegram user whose live membership
 * list is empty: the reply equals the existing FAIL_N0 pt-br copy, runAgentTurn is never called,
 * and the telegram_dm_active_empresa row for that user is cleared.
 */
test("lt-flue2-no-membership-fails-closed-and-clears-pin: linked user with empty live membership → FAIL_N0 copy, runAgentTurn never called, pin cleared", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-flue2-n0" });
  const tgId = "111006";
  seedTelegramLink(db, user.id, tgId);
  const emp = seedEmpresa(db, { id: "emp-flue2-n0", nome: "Empresa Flue2 N0" });
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id, "sk-flue2-n0-key");
  await upsertDmActiveEmpresa(db, user.id, emp.id);

  // Soft-delete the empresa so the live-membership predicate fails, leaving the user with zero
  // live memberships even though a stale pin exists.
  db.prepare(`UPDATE empresas SET deleted_at = datetime('now') WHERE id = ?`).run(
    emp.id,
  );

  const pinBefore = await getDmActiveEmpresa(db, user.id);
  assert.ok(pinBefore, "fixture must start with a pin present");

  /** @type {unknown[]} */
  const agentCalls = [];
  const result = await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId, text: "oi" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "should-not-run";
    },
  });

  assert.equal(
    result.reply,
    FAIL_N0,
    "reply must equal the existing FAIL_N0 pt-br copy",
  );
  assert.equal(agentCalls.length, 0, "runAgentTurn must never be called");
  assert.equal(
    await getDmActiveEmpresa(db, user.id),
    null,
    "telegram_dm_active_empresa row for the user must be cleared",
  );

  db.close();
});
