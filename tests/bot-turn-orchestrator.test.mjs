/**
 * Locked bot-turn-orchestrator contract — handleBotTurn gates before agent.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 *
 * Expected production export (executor creates):
 *   handleBotTurn from ../src/worker/services/bot-turn-orchestrator.ts
 *
 * Input shape:
 *   handleBotTurn({
 *     db,
 *     update, // telegram update fragment
 *     botUsername,
 *     llmKeyEncryptionSecret,
 *     botToken?,
 *     runAgentTurn, // injectable mock
 *     insertTurnContext?, // optional inject; default real
 *     send?,
 *   }) → { reply: string }
 *
 * Does NOT call createGestaoBotTools. Writes turn row then runAgentTurn({sessionId,message,turnToken}).
 * apiKey only via insertTurnContext / turn-token path — never Flue JSON body.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { insertTurnContext as realInsertTurnContext } from "../src/worker/agent/turn-context-store.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";
import {
  getDmActiveEmpresa,
  setDmPendingBoundary,
  upsertDmActiveEmpresa,
} from "../src/worker/services/telegram-dm-active-empresa.ts";
import { handleBotTurn } from "../src/worker/services/bot-turn-orchestrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const ORCHESTRATOR_SRC = resolve(
  __dirname,
  "../src/worker/services/bot-turn-orchestrator.ts",
);

const TEST_ENCRYPTION_SECRET =
  "test-llm-key-encryption-secret-bot-turn-orch-hermetic";
const PLAINTEXT_KEY = "sk-test-orch-plaintext-key-xyz";
const BOT_USERNAME = "GestaoBot";

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
  const id = opts.id ?? "user-orch-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Orch User";
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
  const id = opts.id ?? "emp-orch-a";
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
  ).run(userId, String(telegramUserId));
}

/**
 * @description Seed a live expert row.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, id?: string, nome?: string }} opts
 */
function seedExpert(db, opts) {
  const id = opts.id ?? "expert-orch-e";
  const nome = opts.nome ?? "Expert E";
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
  ).run(
    opts.expertId,
    opts.empresaId,
    opts.chatId,
    opts.messageThreadId,
  );
}

/**
 * @description Seed empresa_llm_settings (valid has_key by default).
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
async function seedValidLlm(db, empresaId, plaintext = PLAINTEXT_KEY) {
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
 * @description Seed a live campanha + optional tarefa under expert.
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   expertId: string,
 *   createdBy: string,
 *   campanhaId?: string,
 *   tarefaId?: string,
 *   titulo?: string,
 * }} opts
 */
function seedCampanhaAndTarefa(db, opts) {
  const campanhaId = opts.campanhaId ?? crypto.randomUUID();
  const titulo = opts.titulo ?? "Tarefa seed orch";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, 'Camp Orch', 'gratuito', 'aberta')`,
  ).run(campanhaId, opts.empresaId, opts.expertId);
  const tarefaId = opts.tarefaId ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO tarefas
       (id, empresa_id, campanha_id, titulo, notas, status, created_by)
     VALUES (?, ?, ?, ?, '', 'a_fazer', ?)`,
  ).run(tarefaId, opts.empresaId, campanhaId, titulo, opts.createdBy);
  return { campanhaId, tarefaId, titulo };
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
 * @param {{
 *   telegramUserId: string | number,
 *   text?: string,
 * }} opts
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
 * @description Count rows in telegram_agent_turn_context.
 * @param {DatabaseSync} db
 */
function countTurnContext(db) {
  const row = db
    .prepare(`SELECT count(*) AS n FROM telegram_agent_turn_context`)
    .get();
  return Number(row?.n ?? 0);
}

/**
 * @description Count tarefas rows.
 * @param {DatabaseSync} db
 */
function countTarefas(db) {
  const row = db.prepare(`SELECT count(*) AS n FROM tarefas`).get();
  return Number(row?.n ?? 0);
}

/**
 * @description True when string looks like non-empty pt-br copy.
 * @param {unknown} value
 */
function isNonEmptyPtBr(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (t.length === 0) return false;
  return (
    /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(t) ||
    /\b(n[aã]o|v[ií]ncul|empresa|llm|chave|configur|escolh|list|membro|recus|inv[aá]lid|ativo|ativa|troca|tente|desculpe|erro|indispon|falha|pin|selecion)\b/i.test(
      t,
    )
  );
}

/**
 * @description True when reply mentions missing/invalid LLM configuration in pt-br without secret material.
 * @param {string} reply
 * @param {string} [secretMaterial]
 */
function isLlmFailClosedPtBr(reply, secretMaterial = PLAINTEXT_KEY) {
  if (!isNonEmptyPtBr(reply)) return false;
  const mentionsLlm =
    /\b(llm|chave|api\s*key|openai|anthropic|configura|provedor|modelo)\b/i.test(
      reply,
    ) ||
    /n[aã]o\s+(est[aá]|foi)\s+(configur|valid)/i.test(reply) ||
    /inv[aá]lid/i.test(reply) ||
    /ausente|faltando|missing/i.test(reply);
  if (!mentionsLlm) return false;
  if (reply.includes(secretMaterial)) return false;
  if (reply.includes(TEST_ENCRYPTION_SECRET)) return false;
  if (/sk-[a-z0-9_-]{8,}/i.test(reply)) return false;
  return true;
}

/**
 * @description Wrap db.prepare to count SELECT/reads against empresa_llm_settings (decrypt/gate path).
 * @param {DatabaseSync} db
 * @returns {{ db: DatabaseSync, llmReads: () => number }}
 */
function spyLlmSettingsReads(db) {
  let reads = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (
      typeof sql === "string" &&
      /empresa_llm_settings/i.test(sql) &&
      /^\s*select/i.test(sql.trim())
    ) {
      reads += 1;
    }
    return origPrepare(sql);
  };
  return {
    db,
    llmReads: () => reads,
  };
}

/**
 * @description Extract reply string from handleBotTurn result.
 * @param {unknown} result
 */
function replyOf(result) {
  assert.ok(result && typeof result === "object", "handleBotTurn must return object");
  const r = /** @type {{ reply?: unknown }} */ (result).reply;
  assert.equal(typeof r, "string", "result.reply must be string");
  return /** @type {string} */ (r);
}

/**
 * @description Normalize insertTurnContext call args to a plain fields object.
 * @param {unknown[]} callArgs — (db, input) or (input)
 */
function normalizeInsertArgs(callArgs) {
  const input =
    callArgs.length >= 2
      ? callArgs[1]
      : callArgs[0] && typeof callArgs[0] === "object" && !("prepare" in /** @type {object} */ (callArgs[0]))
        ? callArgs[0]
        : callArgs[1] ?? callArgs[0];
  assert.ok(input && typeof input === "object", "insertTurnContext input must be object");
  const o = /** @type {Record<string, unknown>} */ (input);
  return {
    empresaId: String(o.empresaId ?? o.empresa_id ?? ""),
    expertId: o.expertId ?? o.expert_id ?? null,
    actorUserId: String(o.actorUserId ?? o.actor_user_id ?? o.userId ?? ""),
    surface: String(o.surface ?? ""),
    provider: String(o.provider ?? ""),
    apiKey: o.apiKey ?? o.api_key,
    message: String(o.message ?? ""),
    encryptionSecret: o.encryptionSecret ?? o.llmKeyEncryptionSecret,
    dmBoundaryLine: o.dmBoundaryLine ?? o.dm_boundary_line ?? null,
  };
}

// ─── lt-orch-unlinked-no-agent ─────────────────────────────────────────────

/**
 * @description Mapped topic @mention from unlinked telegram user: no agent, no tarefas insert, no turn_context, pt-br fail-closed reply.
 */
test("lt-orch-unlinked-no-agent: unlinked topic @mention → runAgentTurn=0, no tarefas/turn_context, pt-br reply", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-unlinked-a", nome: "Empresa Unlinked" });
  const expert = seedExpert(db, {
    id: "expert-unlinked-e",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-1001",
    messageThreadId: "7",
  });
  await seedValidLlm(db, emp.id);

  const tarefasBefore = countTarefas(db);
  /** @type {unknown[]} */
  const agentCalls = [];
  const runAgentTurn = async (args) => {
    agentCalls.push(args);
    return "should-not-run";
  };

  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: "999001",
      chatId: -1001,
      threadId: 7,
      text: " criar tarefa X",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn,
  });

  const reply = replyOf(result);
  assert.equal(agentCalls.length, 0, "runAgentTurn call count must be 0");
  assert.equal(
    countTarefas(db),
    tarefasBefore,
    "no tarefas INSERT must occur",
  );
  assert.equal(
    countTurnContext(db),
    0,
    "no telegram_agent_turn_context row must be inserted",
  );
  assert.ok(
    isNonEmptyPtBr(reply),
    `reply must be non-empty pt-br fail-closed copy, got: ${reply}`,
  );

  db.close();
});

// ─── lt-orch-invalid-llm-no-agent ──────────────────────────────────────────

/**
 * @description Linked member on mapped topic but empresa LLM status not valid: no agent, no turn row, pt-br LLM copy without secrets.
 */
test("lt-orch-invalid-llm-no-agent: linked member + invalid LLM → runAgentTurn=0, no turn_context, pt-br LLM copy, no secrets", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-bad-llm", nome: "Empresa Bad LLM" });
  const expert = seedExpert(db, {
    id: "expert-bad-llm",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-1002",
    messageThreadId: "11",
  });
  const user = seedUser(db, { id: "user-bad-llm" });
  const tgId = "888002";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  // status invalid — has ciphertext but not valid
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    TEST_ENCRYPTION_SECRET,
    PLAINTEXT_KEY,
  );
  seedLlmSettings(db, {
    empresaId: emp.id,
    provider: "openai",
    ciphertext: ciphertextHex,
    iv: ivHex,
    status: "invalid",
  });

  /** @type {unknown[]} */
  const agentCalls = [];
  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: tgId,
      chatId: -1002,
      threadId: 11,
      botUsername: "gestaobot", // case-insensitive mention match
      text: " listar tarefas",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "nope";
    },
  });

  const reply = replyOf(result);
  assert.equal(agentCalls.length, 0, "runAgentTurn call count must be 0");
  assert.equal(
    countTurnContext(db),
    0,
    "no turn_context row must be inserted",
  );
  assert.ok(
    isLlmFailClosedPtBr(reply, PLAINTEXT_KEY),
    `reply must mention missing/invalid LLM in pt-br without secret material, got: ${reply}`,
  );
  assert.equal(
    reply.includes(PLAINTEXT_KEY),
    false,
    "reply must not contain plaintext api key",
  );
  assert.equal(
    reply.includes(TEST_ENCRYPTION_SECRET),
    false,
    "reply must not contain encryption secret",
  );
  assert.equal(
    reply.includes(ciphertextHex),
    false,
    "reply must not leak ciphertext",
  );

  db.close();
});

// ─── lt-orch-dm-multi-unpinned-no-decrypt-agent ────────────────────────────

/**
 * @description DM linked user with two live memberships and no pin: no agent, no decrypt, list empresas ORDER BY nome COLLATE NOCASE, id.
 */
test("lt-orch-dm-multi-unpinned-no-decrypt-agent: N>1 unpinned DM → no agent/decrypt/turn_row; list nome NOCASE then id", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-dm-multi" });
  const tgId = "777003";
  seedTelegramLink(db, user.id, tgId);

  // Order by nome COLLATE NOCASE, id → Alpha (a-1), beta (b-2), Zeta (z-0)
  // Seed out of order to prove sort is not insertion order.
  const empZ = seedEmpresa(db, { id: "emp-z-0", nome: "Zeta Co" });
  const empB = seedEmpresa(db, { id: "emp-b-2", nome: "beta Co" });
  const empA = seedEmpresa(db, { id: "emp-a-1", nome: "Alpha Co" });
  seedMembro(db, empZ.id, user.id);
  seedMembro(db, empB.id, user.id);
  seedMembro(db, empA.id, user.id);

  await seedValidLlm(db, empA.id);
  await seedValidLlm(db, empB.id, "sk-other-b");
  await seedValidLlm(db, empZ.id, "sk-other-z");

  const { db: spyDb, llmReads } = spyLlmSettingsReads(db);

  /** @type {unknown[]} */
  const agentCalls = [];
  const result = await handleBotTurn({
    db: spyDb,
    update: dmTextUpdate({ telegramUserId: tgId, text: "oi, listar tarefas" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "nope";
    },
  });

  const reply = replyOf(result);
  assert.equal(agentCalls.length, 0, "runAgentTurn call count must be 0");
  assert.equal(
    llmReads(),
    0,
    "loadEmpresaLlmForBot/decrypt must not be invoked (no empresa_llm_settings SELECT)",
  );
  assert.equal(
    countTurnContext(db),
    0,
    "no turn_context row must be inserted",
  );

  // Reply lists empresas for disambiguation — all three nomes present
  assert.ok(
    reply.includes(empA.nome) || reply.includes(empA.id),
    "reply must list Alpha Co (or id)",
  );
  assert.ok(
    reply.includes(empB.nome) || reply.includes(empB.id),
    "reply must list beta Co (or id)",
  );
  assert.ok(
    reply.includes(empZ.nome) || reply.includes(empZ.id),
    "reply must list Zeta Co (or id)",
  );

  // Ordered by nome COLLATE NOCASE then id: Alpha, beta, Zeta
  const idxA = reply.indexOf(empA.nome);
  const idxB = reply.indexOf(empB.nome);
  const idxZ = reply.indexOf(empZ.nome);
  if (idxA >= 0 && idxB >= 0 && idxZ >= 0) {
    assert.ok(
      idxA < idxB && idxB < idxZ,
      `empresas must be ordered by nome COLLATE NOCASE then id; got positions A=${idxA} B=${idxB} Z=${idxZ} in: ${reply}`,
    );
  } else {
    // Fallback: ids in same order if nomes not echoed literally
    const idA = reply.indexOf(empA.id);
    const idB = reply.indexOf(empB.id);
    const idZ = reply.indexOf(empZ.id);
    assert.ok(idA >= 0 && idB >= 0 && idZ >= 0, "reply must include empresa ids when nomes absent");
    assert.ok(
      idA < idB && idB < idZ,
      `empresa ids must follow nome NOCASE order; got A=${idA} B=${idB} Z=${idZ}`,
    );
  }

  assert.equal(
    await getDmActiveEmpresa(db, user.id),
    null,
    "no pin must be written on unpinned multi list",
  );

  db.close();
});

// ─── lt-orch-dm-bootstrap-pin-confirm-only ─────────────────────────────────

/**
 * @description DM N>1 awaiting pin + valid selector (exact id | unique nome | 1-based index): pin persisted, confirm only, no agent/decrypt.
 */
test("lt-orch-dm-bootstrap-pin-confirm-only: valid selector → pin + pt-br confirm only; runAgentTurn=0; no decrypt", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-dm-boot" });
  const tgId = "777004";
  seedTelegramLink(db, user.id, tgId);

  const empZ = seedEmpresa(db, { id: "emp-boot-z", nome: "Zulu Boot" });
  const empA = seedEmpresa(db, { id: "emp-boot-a", nome: "Alpha Boot" });
  seedMembro(db, empZ.id, user.id);
  seedMembro(db, empA.id, user.id);
  await seedValidLlm(db, empA.id);
  await seedValidLlm(db, empZ.id, "sk-boot-z");

  // Ordered: Alpha Boot, Zulu Boot — index 1 = Alpha
  const { db: spyDb, llmReads } = spyLlmSettingsReads(db);

  /** @type {unknown[]} */
  const agentCalls = [];

  // First message establishes awaiting_pin list path (no pin yet)
  await handleBotTurn({
    db: spyDb,
    update: dmTextUpdate({ telegramUserId: tgId, text: "olá" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "nope";
    },
  });
  assert.equal(agentCalls.length, 0);
  assert.equal(await getDmActiveEmpresa(db, user.id), null);

  // Selector: 1-based index of ordered list → Alpha Boot
  const result = await handleBotTurn({
    db: spyDb,
    update: dmTextUpdate({ telegramUserId: tgId, text: "1" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "nope";
    },
  });

  const reply = replyOf(result);
  assert.equal(agentCalls.length, 0, "runAgentTurn call count must be 0 on selector message");
  assert.equal(
    llmReads(),
    0,
    "decrypt/loadEmpresaLlmForBot must not be invoked on selector message",
  );
  assert.equal(countTurnContext(db), 0, "no turn_context on bootstrap pin");

  const pin = await getDmActiveEmpresa(db, user.id);
  assert.ok(pin, "pin must be persisted to telegram_dm_active_empresa");
  assert.equal(pin.empresa_id, empA.id, "pin must be Alpha Boot (index 1)");

  assert.ok(
    isNonEmptyPtBr(reply),
    `reply must be pt-br confirm only, got: ${reply}`,
  );
  // Confirm should reference chosen empresa; must not look like an agent task dump
  assert.ok(
    reply.includes(empA.nome) ||
      reply.includes(empA.id) ||
      /\b(ativa|ativo|definid|confirm|selecion|escolh)\b/i.test(reply),
    `confirm reply should acknowledge pin, got: ${reply}`,
  );

  // Also accept exact empresa_id selector path on a fresh user
  const user2 = seedUser(db, { id: "user-dm-boot-id" });
  const tgId2 = "777014";
  seedTelegramLink(db, user2.id, tgId2);
  seedMembro(db, empZ.id, user2.id);
  seedMembro(db, empA.id, user2.id);
  agentCalls.length = 0;
  await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId2, text: "start" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (a) => {
      agentCalls.push(a);
      return "x";
    },
  });
  const byId = await handleBotTurn({
    db,
    update: dmTextUpdate({ telegramUserId: tgId2, text: empZ.id }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (a) => {
      agentCalls.push(a);
      return "x";
    },
  });
  assert.equal(agentCalls.length, 0);
  const pin2 = await getDmActiveEmpresa(db, user2.id);
  assert.ok(pin2);
  assert.equal(pin2.empresa_id, empZ.id, "exact empresa_id selector must pin Z");
  assert.ok(isNonEmptyPtBr(replyOf(byId)));

  db.close();
});

// ─── lt-orch-dm-bootstrap-invalid-relists ──────────────────────────────────

/**
 * @description DM N>1 awaiting pin + invalid selector: re-list same ordered empresas, no pin, no agent, no decrypt.
 */
test("lt-orch-dm-bootstrap-invalid-relists: invalid selector → re-list NOCASE order; no pin/agent/decrypt", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-dm-invalid" });
  const tgId = "777005";
  seedTelegramLink(db, user.id, tgId);

  const empC = seedEmpresa(db, { id: "emp-inv-c", nome: "Charlie Inv" });
  const empA = seedEmpresa(db, { id: "emp-inv-a", nome: "Alpha Inv" });
  seedMembro(db, empC.id, user.id);
  seedMembro(db, empA.id, user.id);
  await seedValidLlm(db, empA.id);
  await seedValidLlm(db, empC.id, "sk-inv-c");

  const { db: spyDb, llmReads } = spyLlmSettingsReads(db);
  /** @type {unknown[]} */
  const agentCalls = [];

  // Enter awaiting pin
  await handleBotTurn({
    db: spyDb,
    update: dmTextUpdate({ telegramUserId: tgId, text: "oi" }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (a) => {
      agentCalls.push(a);
      return "x";
    },
  });

  const result = await handleBotTurn({
    db: spyDb,
    update: dmTextUpdate({
      telegramUserId: tgId,
      text: "empresa-que-nao-existe-xyz",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (a) => {
      agentCalls.push(a);
      return "x";
    },
  });

  const reply = replyOf(result);
  assert.equal(agentCalls.length, 0, "runAgentTurn call count must be 0");
  assert.equal(llmReads(), 0, "decrypt must not be invoked");
  assert.equal(
    await getDmActiveEmpresa(db, user.id),
    null,
    "pin must not be written",
  );
  assert.equal(countTurnContext(db), 0);

  // Re-lists same empresas ordered by nome COLLATE NOCASE then id: Alpha, Charlie
  assert.ok(
    reply.includes(empA.nome) || reply.includes(empA.id),
    "re-list must include Alpha Inv",
  );
  assert.ok(
    reply.includes(empC.nome) || reply.includes(empC.id),
    "re-list must include Charlie Inv",
  );
  const idxA = reply.indexOf(empA.nome);
  const idxC = reply.indexOf(empC.nome);
  if (idxA >= 0 && idxC >= 0) {
    assert.ok(
      idxA < idxC,
      `re-list order must be nome NOCASE then id; Alpha before Charlie in: ${reply}`,
    );
  }

  db.close();
});

// ─── lt-orch-dm-stale-pin-rebootstrap ───────────────────────────────────────

/**
 * @description Durable pin to A but live membership for A removed: clear pin; N>1 list / N=1 auto-pin / N=0 refuse. No agent/decrypt on list/refuse paths.
 */
test("lt-orch-dm-stale-pin-rebootstrap: stale pin cleared; N>1 list / N=1 auto / N=0 refuse", async () => {
  // ── Case N>1 remaining ──
  {
    const db = openDb();
    const user = seedUser(db, { id: "user-stale-n2" });
    const tgId = "666001";
    seedTelegramLink(db, user.id, tgId);
    const empA = seedEmpresa(db, { id: "emp-stale-a", nome: "Stale A" });
    const empB = seedEmpresa(db, { id: "emp-stale-b", nome: "Stale B" });
    const empC = seedEmpresa(db, { id: "emp-stale-c", nome: "Stale C" });
    seedMembro(db, empA.id, user.id);
    seedMembro(db, empB.id, user.id);
    seedMembro(db, empC.id, user.id);
    await upsertDmActiveEmpresa(db, user.id, empA.id);
    // Remove live membership for A (hard-delete membros — no soft-delete on empresa_membros)
    db.prepare(
      `DELETE FROM empresa_membros WHERE empresa_id = ? AND user_id = ?`,
    ).run(empA.id, user.id);
    await seedValidLlm(db, empB.id);
    await seedValidLlm(db, empC.id, "sk-c");

    const { db: spyDb, llmReads } = spyLlmSettingsReads(db);
    /** @type {unknown[]} */
    const agentCalls = [];
    const result = await handleBotTurn({
      db: spyDb,
      update: dmTextUpdate({ telegramUserId: tgId, text: "continuar" }),
      botUsername: BOT_USERNAME,
      llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
      runAgentTurn: async (a) => {
        agentCalls.push(a);
        return "x";
      },
    });
    const reply = replyOf(result);
    assert.equal(agentCalls.length, 0, "N>1 stale: no agent");
    assert.equal(llmReads(), 0, "N>1 stale: no decrypt");
    assert.equal(
      await getDmActiveEmpresa(db, user.id),
      null,
      "stale pin must be cleared when N>1 remaining",
    );
    assert.ok(
      (reply.includes(empB.nome) || reply.includes(empB.id)) &&
        (reply.includes(empC.nome) || reply.includes(empC.id)),
      `N>1 must list remaining empresas, got: ${reply}`,
    );
    assert.equal(
      reply.includes(empA.nome) && !reply.includes(empB.nome),
      false,
    );
    db.close();
  }

  // ── Case N=1 remaining → auto-pin ──
  {
    const db = openDb();
    const user = seedUser(db, { id: "user-stale-n1" });
    const tgId = "666002";
    seedTelegramLink(db, user.id, tgId);
    const empA = seedEmpresa(db, { id: "emp-stale1-a", nome: "OnlyGone" });
    const empB = seedEmpresa(db, { id: "emp-stale1-b", nome: "OnlyLeft" });
    seedMembro(db, empA.id, user.id);
    seedMembro(db, empB.id, user.id);
    await upsertDmActiveEmpresa(db, user.id, empA.id);
    db.prepare(
      `DELETE FROM empresa_membros WHERE empresa_id = ? AND user_id = ?`,
    ).run(empA.id, user.id);
    await seedValidLlm(db, empB.id);

    /** @type {unknown[]} */
    const agentCalls = [];
    // Auto-pin may proceed to agent if LLM valid — either auto-pin only or full turn is OK
    // Contract: pin is cleared then N=1 auto-pins the remaining
    await handleBotTurn({
      db,
      update: dmTextUpdate({ telegramUserId: tgId, text: "oi" }),
      botUsername: BOT_USERNAME,
      llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
      runAgentTurn: async (a) => {
        agentCalls.push(a);
        return "ok-auto";
      },
    });
    const pin = await getDmActiveEmpresa(db, user.id);
    assert.ok(pin, "N=1 remaining must auto-pin");
    assert.equal(pin.empresa_id, empB.id, "auto-pin must be the remaining empresa B");
    db.close();
  }

  // ── Case N=0 remaining → refuse ──
  {
    const db = openDb();
    const user = seedUser(db, { id: "user-stale-n0" });
    const tgId = "666003";
    seedTelegramLink(db, user.id, tgId);
    const empA = seedEmpresa(db, { id: "emp-stale0-a", nome: "Gone Soft" });
    seedMembro(db, empA.id, user.id);
    await upsertDmActiveEmpresa(db, user.id, empA.id);
    // Soft-delete empresa A (live-membership predicate fails)
    db.prepare(
      `UPDATE empresas SET deleted_at = datetime('now') WHERE id = ?`,
    ).run(empA.id);
    await seedValidLlm(db, empA.id);

    const { db: spyDb, llmReads } = spyLlmSettingsReads(db);
    /** @type {unknown[]} */
    const agentCalls = [];
    const result = await handleBotTurn({
      db: spyDb,
      update: dmTextUpdate({ telegramUserId: tgId, text: "oi" }),
      botUsername: BOT_USERNAME,
      llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
      runAgentTurn: async (a) => {
        agentCalls.push(a);
        return "x";
      },
    });
    const reply = replyOf(result);
    assert.equal(agentCalls.length, 0, "N=0 must refuse without agent");
    assert.equal(llmReads(), 0, "N=0 must not decrypt");
    assert.equal(
      await getDmActiveEmpresa(db, user.id),
      null,
      "stale pin must be cleared on N=0",
    );
    assert.ok(
      isNonEmptyPtBr(reply),
      `N=0 refuse must be non-empty pt-br, got: ${reply}`,
    );
    assert.equal(countTurnContext(db), 0);
    db.close();
  }
});

// ─── lt-orch-dm-switch-boundary-line ───────────────────────────────────────

/**
 * @description DM pin empresa B + pending_boundary=1: insertTurnContext gets dm_boundary_line (other-tenant) + empresa_id B; pending cleared to 0 after turn row written.
 */
test("lt-orch-dm-switch-boundary-line: pending_boundary=1 → dm_boundary_line + empresa B; pending cleared to 0", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-boundary" });
  const tgId = "555001";
  seedTelegramLink(db, user.id, tgId);
  const empA = seedEmpresa(db, { id: "emp-bound-a", nome: "Bound A" });
  const empB = seedEmpresa(db, { id: "emp-bound-b", nome: "Bound B" });
  seedMembro(db, empA.id, user.id);
  seedMembro(db, empB.id, user.id);
  await seedValidLlm(db, empB.id);

  // Pin B with pending_boundary=1 (after prior definir_empresa_ativa switch)
  await upsertDmActiveEmpresa(db, user.id, empB.id);
  await setDmPendingBoundary(db, user.id, 1);
  const before = await getDmActiveEmpresa(db, user.id);
  assert.equal(before?.empresa_id, empB.id);
  assert.equal(before?.pending_boundary, 1);

  /** @type {unknown[][]} */
  const insertCalls = [];
  /** @type {unknown[]} */
  const agentCalls = [];

  const insertSpy = async (...args) => {
    insertCalls.push(args);
    return realInsertTurnContext(
      /** @type {Parameters<typeof realInsertTurnContext>[0]} */ (args[0]),
      /** @type {Parameters<typeof realInsertTurnContext>[1]} */ (args[1]),
    );
  };

  const result = await handleBotTurn({
    db,
    update: dmTextUpdate({
      telegramUserId: tgId,
      text: "listar minhas tarefas",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (a) => {
      agentCalls.push(a);
      return "ok boundary turn";
    },
    insertTurnContext: insertSpy,
  });

  assert.ok(replyOf(result));
  assert.equal(insertCalls.length, 1, "insertTurnContext must run once");
  assert.equal(agentCalls.length, 1, "runAgentTurn must run once after gates");

  const inserted = normalizeInsertArgs(insertCalls[0]);
  assert.equal(
    inserted.empresaId,
    empB.id,
    "insertTurnContext empresa_id must equal B only",
  );
  assert.equal(inserted.surface, "dm");
  assert.ok(
    typeof inserted.dmBoundaryLine === "string" &&
      inserted.dmBoundaryLine.trim().length > 0,
    "insertTurnContext must receive non-empty dm_boundary_line",
  );
  assert.ok(
    /outr[oa]|other|tenant|empresa|anterio|pr[eé]vi|troca|boundary|contexto/i.test(
      inserted.dmBoundaryLine,
    ),
    `dm_boundary_line must state prior tool results may be other-tenant, got: ${inserted.dmBoundaryLine}`,
  );

  // After turn row written, pending_boundary cleared to 0
  const after = await getDmActiveEmpresa(db, user.id);
  assert.ok(after, "pin must remain");
  assert.equal(after.empresa_id, empB.id);
  assert.equal(
    after.pending_boundary,
    0,
    "pending_boundary must be cleared to 0 after turn row is written",
  );

  // D1 row also holds boundary line
  const row = db
    .prepare(
      `SELECT empresa_id, dm_boundary_line, surface
       FROM telegram_agent_turn_context LIMIT 1`,
    )
    .get();
  assert.ok(row);
  assert.equal(row.empresa_id, empB.id);
  assert.equal(row.surface, "dm");
  assert.equal(typeof row.dm_boundary_line, "string");
  assert.ok(String(row.dm_boundary_line).length > 0);

  db.close();
});

// ─── lt-orch-dm-switch-no-second-tool-same-turn ────────────────────────────

/**
 * @description DM switch via definir_empresa_ativa: pin B pending=1; turn ends after terminal; runAgentTurn not re-entered for second tool loop on switch message.
 */
test("lt-orch-dm-switch-no-second-tool-same-turn: switch turn → pin B pending=1; single runAgentTurn; no second loop", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-switch" });
  const tgId = "555002";
  seedTelegramLink(db, user.id, tgId);
  const empA = seedEmpresa(db, { id: "emp-sw-a", nome: "Switch A" });
  const empB = seedEmpresa(db, { id: "emp-sw-b", nome: "Switch B" });
  seedMembro(db, empA.id, user.id);
  seedMembro(db, empB.id, user.id);
  await seedValidLlm(db, empA.id);
  await seedValidLlm(db, empB.id, "sk-sw-b");
  await upsertDmActiveEmpresa(db, user.id, empA.id);
  await setDmPendingBoundary(db, user.id, 0);

  /** @type {unknown[]} */
  const agentCalls = [];
  let toolLoopsInMock = 0;

  const result = await handleBotTurn({
    db,
    update: dmTextUpdate({
      telegramUserId: tgId,
      text: "definir empresa ativa Switch B",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      toolLoopsInMock += 1;
      // Simulate agent turn that invokes definir_empresa_ativa terminal and stops
      // (dm_switch_end_turn_mechanism=tool-terminal-stop) — one call, no second tool loop
      await upsertDmActiveEmpresa(db, user.id, empB.id);
      await setDmPendingBoundary(db, user.id, 1);
      // Deliberately do NOT start a second tool loop / re-enter agent
      return "Empresa ativa alterada para Switch B. Turno encerrado.";
    },
  });

  assert.ok(isNonEmptyPtBr(replyOf(result)) || typeof replyOf(result) === "string");
  assert.equal(
    agentCalls.length,
    1,
    "runAgentTurn must not be re-entered for a second tool loop on the switch message",
  );
  assert.equal(toolLoopsInMock, 1, "mock must simulate exactly one agent call");

  const pin = await getDmActiveEmpresa(db, user.id);
  assert.ok(pin, "pin must exist after switch");
  assert.equal(pin.empresa_id, empB.id, "pin B must be persisted");
  assert.equal(
    pin.pending_boundary,
    1,
    "pending_boundary must be 1 after definir_empresa_ativa switch",
  );

  db.close();
});

// ─── lt-orch-identity-minimal ──────────────────────────────────────────────

/**
 * @description Successful topic path: runAgentTurn args include sessionId, message, turnToken, gated identity; no array of all task titulos from D1.
 */
test("lt-orch-identity-minimal: topic success → sessionId/message/turnToken/identity; no task titulos array", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-idmin", nome: "Empresa IdMin" });
  const expert = seedExpert(db, {
    id: "expert-idmin",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-2001",
    messageThreadId: "42",
  });
  const user = seedUser(db, { id: "user-idmin" });
  const tgId = "444001";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id);

  const decoyTitulo = "TITULO-DECOY-ORCH-NAO-DEVE-IR-AO-AGENT-xyz99";
  seedCampanhaAndTarefa(db, {
    empresaId: emp.id,
    expertId: expert.id,
    createdBy: user.id,
    titulo: decoyTitulo,
  });

  /** @type {Record<string, unknown>[]} */
  const agentCalls = [];
  /** @type {unknown[][]} */
  const insertCalls = [];

  const messageText = " criar tarefa Revisar landing";
  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: tgId,
      chatId: -2001,
      threadId: 42,
      text: messageText,
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: async (args) => {
      agentCalls.push(/** @type {Record<string, unknown>} */ (args ?? {}));
      return "ok identity";
    },
    insertTurnContext: async (...args) => {
      insertCalls.push(args);
      return realInsertTurnContext(
        /** @type {Parameters<typeof realInsertTurnContext>[0]} */ (args[0]),
        /** @type {Parameters<typeof realInsertTurnContext>[1]} */ (args[1]),
      );
    },
  });

  assert.ok(replyOf(result));
  assert.equal(agentCalls.length, 1, "runAgentTurn must be called once");
  const args = agentCalls[0];

  assert.equal(typeof args.sessionId, "string", "args.sessionId required");
  assert.equal(args.sessionId, "topic:-2001:42", "sessionId must be topic form");
  assert.equal(typeof args.message, "string", "args.message required");
  assert.ok(
    String(args.message).length > 0,
    "message must be non-empty",
  );
  assert.equal(
    typeof args.turnToken === "string" && args.turnToken.length > 0,
    true,
    "args.turnToken required",
  );

  // Gated identity fields needed to build the turn row — on runAgentTurn and/or insertTurnContext
  const inserted =
    insertCalls.length > 0 ? normalizeInsertArgs(insertCalls[0]) : null;
  const empresaId =
    args.empresaId ?? args.empresa_id ?? inserted?.empresaId;
  const expertId =
    args.expertId ?? args.expert_id ?? inserted?.expertId;
  const actorUserId =
    args.userId ??
    args.actorUserId ??
    args.actor_user_id ??
    inserted?.actorUserId;
  const surface = args.surface ?? inserted?.surface;
  assert.equal(empresaId, emp.id, "gated identity must include empresaId");
  assert.equal(expertId, expert.id, "gated identity must include expertId");
  assert.equal(actorUserId, user.id, "gated identity must include actor userId");
  assert.equal(surface, "topic", "gated identity must include surface topic");

  // Must NOT contain an array of all task titulos from D1
  const serialized = JSON.stringify(args);
  assert.equal(
    serialized.includes(decoyTitulo),
    false,
    "runAgentTurn args must not contain task titulo dumps from D1",
  );
  for (const key of Object.keys(args)) {
    const v = args[key];
    if (Array.isArray(v)) {
      const joined = v.map((x) => String(x)).join("\n");
      assert.equal(
        joined.includes(decoyTitulo),
        false,
        `args.${key} array must not dump task titulos`,
      );
      // Heuristic: no array that looks like a full task-title list
      if (
        v.length > 0 &&
        v.every((x) => typeof x === "string" || (x && typeof x === "object" && "titulo" in /** @type {object} */ (x)))
      ) {
        assert.fail(
          `args must not contain an array of task titulos (found args.${key})`,
        );
      }
    }
  }

  db.close();
});

// ─── lt-orch-writes-turn-row-then-agent ─────────────────────────────────────

/**
 * @description Successful topic path: telegram_agent_turn_context row inserted before runAgentTurn once; createGestaoBotTools not invoked in orchestrator module.
 */
test("lt-orch-writes-turn-row-then-agent: turn row before runAgentTurn once; createGestaoBotTools not in orchestrator", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-order", nome: "Empresa Order" });
  const expert = seedExpert(db, {
    id: "expert-order",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-3001",
    messageThreadId: "9",
  });
  const user = seedUser(db, { id: "user-order" });
  const tgId = "333001";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id);

  /** @type {string[]} */
  const order = [];
  /** @type {unknown[]} */
  const agentCalls = [];

  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: tgId,
      chatId: -3001,
      threadId: 9,
      text: " oi",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    insertTurnContext: async (...args) => {
      order.push("insert");
      // Row must exist before agent — write via real helper
      const out = await realInsertTurnContext(
        /** @type {Parameters<typeof realInsertTurnContext>[0]} */ (args[0]),
        /** @type {Parameters<typeof realInsertTurnContext>[1]} */ (args[1]),
      );
      assert.equal(
        countTurnContext(db) >= 1,
        true,
        "turn row must be present immediately after insertTurnContext",
      );
      return out;
    },
    runAgentTurn: async (args) => {
      order.push("agent");
      agentCalls.push(args);
      assert.equal(
        countTurnContext(db) >= 1,
        true,
        "turn row must already exist when runAgentTurn is invoked",
      );
      return "ok order";
    },
  });

  assert.ok(replyOf(result));
  assert.deepEqual(
    order,
    ["insert", "agent"],
    "telegram_agent_turn_context row must be inserted before runAgentTurn",
  );
  assert.equal(agentCalls.length, 1, "runAgentTurn must be invoked once");
  assert.equal(countTurnContext(db), 1, "exactly one turn_context row");

  // createGestaoBotTools is not invoked in the orchestrator module (source grep)
  const orchSrc = readFileSync(ORCHESTRATOR_SRC, "utf8");
  assert.equal(
    /createGestaoBotTools/.test(orchSrc),
    false,
    "createGestaoBotTools must not appear in bot-turn-orchestrator.ts",
  );
  assert.equal(
    /from\s+['"].*gestao-bot-tools/.test(orchSrc),
    false,
    "orchestrator must not import gestao-bot-tools",
  );

  db.close();
});

// ─── lt-orch-does-not-put-apikey-in-flue-body ───────────────────────────────

/**
 * @description Successful topic path: runAgentTurn is not instructed to place apiKey in the Flue JSON body; apiKey only via D1 turn row / turn-token path.
 */
test("lt-orch-does-not-put-apikey-in-flue-body: apiKey only on D1 turn-token path, not Flue body instruction", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-nokey", nome: "Empresa NoKeyBody" });
  const expert = seedExpert(db, {
    id: "expert-nokey",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-4001",
    messageThreadId: "3",
  });
  const user = seedUser(db, { id: "user-nokey" });
  const tgId = "222001";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  const secretKey = "sk-orch-must-not-appear-in-flue-body-aa11";
  await seedValidLlm(db, emp.id, secretKey);

  /** @type {Record<string, unknown>[]} */
  const agentCalls = [];
  /** @type {unknown[][]} */
  const insertCalls = [];

  const result = await handleBotTurn({
    db,
    update: topicMentionUpdate({
      telegramUserId: tgId,
      chatId: -4001,
      threadId: 3,
      text: " status",
    }),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    insertTurnContext: async (...args) => {
      insertCalls.push(args);
      return realInsertTurnContext(
        /** @type {Parameters<typeof realInsertTurnContext>[0]} */ (args[0]),
        /** @type {Parameters<typeof realInsertTurnContext>[1]} */ (args[1]),
      );
    },
    runAgentTurn: async (args) => {
      agentCalls.push(/** @type {Record<string, unknown>} */ (args ?? {}));
      return "ok no key body";
    },
  });

  assert.ok(replyOf(result));
  assert.equal(agentCalls.length, 1);
  assert.equal(insertCalls.length, 1);

  const args = agentCalls[0];
  assert.equal(typeof args.sessionId, "string");
  assert.equal(typeof args.message, "string");
  assert.equal(typeof args.turnToken, "string");
  assert.ok(String(args.turnToken).length > 0);

  // Must not instruct Flue JSON body to carry apiKey
  for (const bodyKey of ["body", "flueBody", "requestBody", "jsonBody"]) {
    const body = args[bodyKey];
    if (body && typeof body === "object") {
      const b = /** @type {Record<string, unknown>} */ (body);
      assert.equal(
        Object.prototype.hasOwnProperty.call(b, "apiKey"),
        false,
        `runAgentTurn args.${bodyKey} must not include apiKey`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(b, "api_key"),
        false,
        `runAgentTurn args.${bodyKey} must not include api_key`,
      );
      assert.equal(
        b.apiKey ?? b.api_key,
        undefined,
        `Flue body must not carry apiKey`,
      );
      // Body keys if present should be message-only
      if (Object.keys(b).length > 0) {
        assert.deepEqual(
          Object.keys(b).sort(),
          ["message"],
          `Flue JSON body keys must be exactly {message} when body is provided`,
        );
      }
    }
  }

  // putApiKeyInBody / includeApiKeyInBody style flags must not be true
  assert.notEqual(args.putApiKeyInBody, true);
  assert.notEqual(args.includeApiKeyInBody, true);
  assert.notEqual(args.sendApiKeyInBody, true);

  // apiKey reaches D1 turn row (ciphertext path), not as Flue transport
  const inserted = normalizeInsertArgs(insertCalls[0]);
  assert.equal(inserted.apiKey, secretKey, "apiKey must reach insertTurnContext only");

  const row = db
    .prepare(
      `SELECT api_key_ciphertext, api_key_iv, turn_token
       FROM telegram_agent_turn_context WHERE turn_token = ?`,
    )
    .get(String(args.turnToken));
  assert.ok(row, "turn row must exist for turnToken");
  assert.equal(typeof row.api_key_ciphertext, "string");
  assert.ok(row.api_key_ciphertext.length > 0);
  assert.notEqual(
    row.api_key_ciphertext,
    secretKey,
    "D1 must store ciphertext, not plaintext",
  );
  assert.equal(typeof row.api_key_iv, "string");
  assert.ok(row.api_key_iv.length > 0);

  // runAgentTurn transport is turn-token, not plaintext key as body payload
  assert.ok(
    args.turnToken,
    "apiKey handoff must be via turnToken, not Flue body",
  );

  db.close();
});
