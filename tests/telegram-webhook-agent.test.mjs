/**
 * Locked telegram webhook agent path — POST /api/telegram/webhook dedup + bot turn.
 * Hermetic: node:sqlite + Hono app.request via createTelegramApp(db, deps).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 *
 * Expected production surface (executor extends createTelegramApp per LD-21):
 *   deps: botToken, webhookSecret, fetchImpl,
 *         botUsername, llmKeyEncryptionSecret, waitUntil,
 *         optional runAgentTurn, optional agentInternalSecret
 *   After secret OK: claimTelegramUpdateId(update_id) before side effects;
 *   topic @mention / DM → handleBotTurn; always HTTP 200 after secret.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGestaoBotTools } from "../src/worker/agent/gestao-bot-tools.ts";
import { createTelegramApp } from "../src/worker/routes/telegram.ts";
import { buildSessionId } from "../src/worker/services/build-session-id.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const TELEGRAM_ROUTES_PATH = resolve(
  __dirname,
  "../src/worker/routes/telegram.ts",
);

const WEBHOOK_PATH = "/api/telegram/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

const BOT_TOKEN = "123456:ABC-DEF_fake-bot-token-material";
const WEBHOOK_SECRET = "whsec_fake_telegram_webhook_secret";
const BOT_USERNAME = "GestaoBot";
const TEST_ENCRYPTION_SECRET =
  "test-llm-key-encryption-secret-webhook-agent-hermetic";
const PLAINTEXT_KEY = "sk-test-webhook-agent-plaintext-xyz";
const AGENT_INTERNAL_SECRET = "gestao-agent-internal-secret-test";

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
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

/**
 * @description Seed a minimal users row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-wh-agent-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Webhook Agent User";
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
  const id = opts.id ?? "emp-wh-agent-a";
  const nome = opts.nome ?? "Empresa Webhook Agent";
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
 * @description Seed user_telegram_links row.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {string|number} telegramUserId
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
  const id = opts.id ?? "expert-wh-agent-e";
  const nome = opts.nome ?? "Expert E";
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, opts.empresaId, nome);
  return { id, nome, empresaId: opts.empresaId };
}

/**
 * @description Seed empresa_telegram_chats + expert_telegram_topics.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, expertId: string, chatId: string|number, messageThreadId: string|number }} opts
 */
function seedTopicMap(db, opts) {
  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id) VALUES (?, ?)`,
  ).run(opts.empresaId, String(opts.chatId));
  db.prepare(
    `INSERT INTO expert_telegram_topics
      (expert_id, empresa_id, chat_id, message_thread_id)
     VALUES (?, ?, ?, ?)`,
  ).run(
    opts.expertId,
    opts.empresaId,
    String(opts.chatId),
    String(opts.messageThreadId),
  );
}

/**
 * @description Seed empresa_llm_settings row.
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
 * @description Seed a live aberta campanha under expert.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, expertId: string, id?: string, nome?: string }} opts
 */
function seedOpenCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Aberta";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, ?, 'gratuito', 'aberta')`,
  ).run(id, opts.empresaId, opts.expertId, nome);
  return { id, nome };
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
 * @description Topic @mention update body (case-insensitive bot username via entities).
 * @param {{
 *   updateId: number | string,
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
  const rest = opts.text ?? " criar tarefa Revisar criativos";
  const text = `${mention}${rest}`;
  const chatId = opts.chatId ?? -1001;
  const threadId = opts.threadId ?? 7;
  return {
    update_id: opts.updateId,
    message: {
      message_id: Number(opts.updateId) || 1,
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
 * @description Capture Bot API sendMessage calls via injectable fetchImpl.
 */
function createFetchCapture() {
  /** @type {Array<{ url: string, init: RequestInit | undefined, body: unknown }>} */
  const calls = [];
  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   */
  async function fetchImpl(input, init) {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    let body = null;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, init, body });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return { fetchImpl, calls };
}

/**
 * @description Last captured sendMessage text, or null.
 * @param {{ calls: Array<{ url: string, body: unknown }> }} capture
 */
function lastSendMessageText(capture) {
  const sendCalls = capture.calls.filter(
    (c) =>
      typeof c.url === "string" &&
      c.url.includes("sendMessage") &&
      c.body &&
      typeof c.body === "object",
  );
  if (sendCalls.length === 0) return null;
  const last = sendCalls[sendCalls.length - 1];
  const body = /** @type {{ text?: string }} */ (last.body);
  return typeof body.text === "string" ? body.text : null;
}

/**
 * @description True when string looks like non-empty pt-br fail-closed copy.
 * @param {unknown} value
 */
function isNonEmptyPtBr(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (t.length === 0) return false;
  return (
    /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(t) ||
    /\b(n[aã]o|v[ií]ncul|empresa|llm|chave|configur|escolh|list|membro|recus|inv[aá]lid|ativo|ativa|troca|tente|desculpe|erro|indispon|falha|pin|selecion|conta|telegram)\b/i.test(
      t,
    )
  );
}

/**
 * @description waitUntil capture — records deferred work and drains after response.
 */
function createWaitUntilCapture() {
  /** @type {Promise<unknown>[]} */
  const pending = [];
  /**
   * @param {Promise<unknown> | unknown} p
   */
  function waitUntil(p) {
    pending.push(Promise.resolve(p));
  }
  async function drain() {
    if (pending.length === 0) return;
    await Promise.all(pending.splice(0, pending.length));
  }
  return { waitUntil, drain, pending };
}

/**
 * @description POST webhook with JSON update + secret header.
 * @param {import('hono').Hono} app
 * @param {unknown} update
 * @param {{ secret?: string }} [opts]
 */
async function postWebhook(app, update, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
    [SECRET_HEADER]: opts.secret ?? WEBHOOK_SECRET,
  };
  return app.request(WEBHOOK_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(update),
  });
}

/**
 * @description Build createTelegramApp with LD-21 deps + capture fetch + waitUntil.
 * @param {DatabaseSync} db
 * @param {{
 *   runAgentTurn?: (...args: unknown[]) => Promise<unknown> | unknown,
 *   botUsername?: string,
 *   llmKeyEncryptionSecret?: string,
 *   agentInternalSecret?: string,
 *   waitUntil?: (p: unknown) => void,
 * }} [extra]
 */
function makeAgentTelegramApp(db, extra = {}) {
  const capture = createFetchCapture();
  const wu =
    extra.waitUntil != null
      ? { waitUntil: extra.waitUntil, drain: async () => {}, pending: [] }
      : createWaitUntilCapture();

  /** @type {Record<string, unknown>} */
  const factoryDeps = {
    botToken: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    fetchImpl: capture.fetchImpl,
    botUsername: extra.botUsername ?? BOT_USERNAME,
    llmKeyEncryptionSecret:
      extra.llmKeyEncryptionSecret ?? TEST_ENCRYPTION_SECRET,
    waitUntil: wu.waitUntil,
    agentInternalSecret: extra.agentInternalSecret ?? AGENT_INTERNAL_SECRET,
  };
  if (extra.runAgentTurn != null) {
    factoryDeps.runAgentTurn = extra.runAgentTurn;
  }

  const app = createTelegramApp(db, factoryDeps);
  return { app, capture, waitUntil: wu, factoryDeps };
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
 * @description Normalize runAgentTurn call args to a plain object.
 * @param {unknown} args
 */
function normalizeAgentArgs(args) {
  assert.ok(args && typeof args === "object", "runAgentTurn args must be object");
  return /** @type {Record<string, unknown>} */ (args);
}

/**
 * @description Seed full linked topic fixture: empresa, expert, map, member, link, valid LLM, one open campanha.
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId?: string,
 *   expertId?: string,
 *   userId?: string,
 *   tgId?: string | number,
 *   chatId?: string | number,
 *   threadId?: string | number,
 *   campanhaId?: string,
 * }} [opts]
 */
async function seedLinkedTopicFixture(db, opts = {}) {
  const empresaId = opts.empresaId ?? "emp-wh-topic";
  const expertId = opts.expertId ?? "expert-wh-topic";
  const userId = opts.userId ?? "user-wh-topic";
  const tgId = opts.tgId ?? "700001";
  const chatId = opts.chatId ?? -1001;
  const threadId = opts.threadId ?? 7;

  const emp = seedEmpresa(db, { id: empresaId, nome: "Empresa Topic WH" });
  const expert = seedExpert(db, { id: expertId, empresaId: emp.id });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId,
    messageThreadId: threadId,
  });
  const user = seedUser(db, { id: userId });
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id);
  const camp = seedOpenCampanha(db, {
    id: opts.campanhaId ?? "camp-wh-open-1",
    empresaId: emp.id,
    expertId: expert.id,
    nome: "Campanha Unica Aberta",
  });

  return {
    emp,
    expert,
    user,
    tgId,
    chatId,
    threadId,
    camp,
  };
}

// ─── lt-webhook-dedup-single-side-effect ───────────────────────────────────

/**
 * @description Same update_id delivered twice: runAgentTurn (or create side-effect) once; HTTP 200 both times.
 */
test("lt-webhook-dedup-single-side-effect: same update_id twice → runAgentTurn once, HTTP 200 both", async () => {
  const db = openDb();
  const fx = await seedLinkedTopicFixture(db, {
    empresaId: "emp-dedup",
    expertId: "expert-dedup",
    userId: "user-dedup",
    tgId: "710099",
    chatId: -1099,
    threadId: 99,
  });

  /** @type {Record<string, unknown>[]} */
  const agentCalls = [];
  const { app, waitUntil } = makeAgentTelegramApp(db, {
    runAgentTurn: async (args) => {
      agentCalls.push(normalizeAgentArgs(args));
      return "ok dedup";
    },
  });

  const body = topicMentionUpdate({
    updateId: 99,
    telegramUserId: fx.tgId,
    chatId: fx.chatId,
    threadId: fx.threadId,
    text: " criar tarefa Revisar criativos",
  });

  const res1 = await postWebhook(app, body);
  await waitUntil.drain();
  const res2 = await postWebhook(app, body);
  await waitUntil.drain();

  assert.equal(res1.status, 200, "first delivery must return HTTP 200");
  assert.equal(res2.status, 200, "duplicate delivery must return HTTP 200");
  assert.equal(
    agentCalls.length,
    1,
    "runAgentTurn (create side-effect) must be invoked exactly once",
  );

  db.close();
});

// ─── lt-webhook-two-turns-same-session ─────────────────────────────────────

/**
 * @description Two sequential @mentions on same mapped chat/thread with different update_ids share identical topic sessionId.
 */
test("lt-webhook-two-turns-same-session: two updates same chat/thread → identical topic sessionId", async () => {
  const db = openDb();
  const chatId = -1001;
  const threadId = 42;
  const fx = await seedLinkedTopicFixture(db, {
    empresaId: "emp-sess",
    expertId: "expert-sess",
    userId: "user-sess",
    tgId: "720042",
    chatId,
    threadId,
  });

  /** @type {string[]} */
  const sessionIds = [];
  const { app, waitUntil } = makeAgentTelegramApp(db, {
    runAgentTurn: async (args) => {
      const a = normalizeAgentArgs(args);
      assert.equal(typeof a.sessionId, "string", "sessionId must be string");
      sessionIds.push(/** @type {string} */ (a.sessionId));
      return "ok session";
    },
  });

  const expectedSessionId = buildSessionId({
    kind: "topic",
    chatId,
    threadId,
  });

  const res1 = await postWebhook(
    app,
    topicMentionUpdate({
      updateId: 1001,
      telegramUserId: fx.tgId,
      chatId,
      threadId,
      text: " listar tarefas",
    }),
  );
  await waitUntil.drain();

  const res2 = await postWebhook(
    app,
    topicMentionUpdate({
      updateId: 1002,
      telegramUserId: fx.tgId,
      chatId,
      threadId,
      text: " criar tarefa Outra",
    }),
  );
  await waitUntil.drain();

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(sessionIds.length, 2, "runAgentTurn must run twice (two update_ids)");
  assert.equal(sessionIds[0], expectedSessionId);
  assert.equal(sessionIds[1], expectedSessionId);
  assert.equal(
    sessionIds[0],
    sessionIds[1],
    "both calls must receive the identical sessionId",
  );
  assert.equal(expectedSessionId, "topic:-1001:42");

  db.close();
});

// ─── lt-webhook-unlinked-no-d1-task-write ───────────────────────────────────

/**
 * @description @mention from unlinked telegram user on mapped topic: no tarefas write, no runAgentTurn, sendMessage fail-closed pt-br.
 */
test("lt-webhook-unlinked-no-d1-task-write: unlinked @mention → no tarefas change, no runAgentTurn, pt-br sendMessage", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-unlinked", nome: "Empresa Unlinked" });
  const expert = seedExpert(db, {
    id: "expert-unlinked",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: -1300,
    messageThreadId: 3,
  });
  // Linked member exists for other tg id — inbound from is unlinked
  const linkedUser = seedUser(db, { id: "user-other-linked" });
  seedTelegramLink(db, linkedUser.id, "999888");
  seedMembro(db, emp.id, linkedUser.id);
  await seedValidLlm(db, emp.id);
  seedOpenCampanha(db, {
    id: "camp-unlinked",
    empresaId: emp.id,
    expertId: expert.id,
  });

  const tarefasBefore = countTarefas(db);
  /** @type {unknown[]} */
  const agentCalls = [];

  const { app, capture, waitUntil } = makeAgentTelegramApp(db, {
    runAgentTurn: async (args) => {
      agentCalls.push(args);
      return "should-not-run";
    },
  });

  const unlinkedTgId = "555001";
  const res = await postWebhook(
    app,
    topicMentionUpdate({
      updateId: 555,
      telegramUserId: unlinkedTgId,
      chatId: -1300,
      threadId: 3,
      text: " criar tarefa Nao deve inserir",
    }),
  );
  await waitUntil.drain();

  assert.equal(res.status, 200, "webhook must ack HTTP 200 after secret");
  assert.equal(
    countTarefas(db),
    tarefasBefore,
    "tarefas row count must be unchanged",
  );
  assert.equal(agentCalls.length, 0, "runAgentTurn must not be called");

  const reply = lastSendMessageText(capture);
  assert.ok(reply != null, "Bot API sendMessage mock must receive a text");
  assert.ok(
    isNonEmptyPtBr(reply),
    `sendMessage text must be non-empty pt-br fail-closed copy, got: ${String(reply)}`,
  );

  db.close();
});

// ─── lt-webhook-topic-create-persists ──────────────────────────────────────

/**
 * @description Linked member + valid LLM + one open campanha; runAgentTurn mock invokes criar_tarefa against real db closure → tarefas row under correct empresa/campanha.
 */
test("lt-webhook-topic-create-persists: linked+valid LLM+one open campanha → criar_tarefa persists tarefas row", async () => {
  const db = openDb();
  const fx = await seedLinkedTopicFixture(db, {
    empresaId: "emp-create",
    expertId: "expert-create",
    userId: "user-create",
    tgId: "730001",
    chatId: -1400,
    threadId: 14,
    campanhaId: "camp-create-open",
  });

  const titulo = "Revisar criativos webhook";
  const tarefasBefore = countTarefas(db);

  /**
   * @description Mock agent turn: build tools from gated identity and invoke criar_tarefa on real db.
   * @param {unknown} args
   */
  async function runAgentTurnMock(args) {
    const a = normalizeAgentArgs(args);
    const empresaId = String(a.empresaId ?? a.empresa_id ?? fx.emp.id);
    const expertId = String(a.expertId ?? a.expert_id ?? fx.expert.id);
    const actorUserId = String(
      a.actorUserId ?? a.actor_user_id ?? a.userId ?? fx.user.id,
    );
    const surface =
      a.surface === "dm" || a.surface === "topic" ? a.surface : "topic";

    const tools = createGestaoBotTools({
      empresa_id: empresaId,
      expert_id: expertId,
      actor_user_id: actorUserId,
      surface,
      db,
      sendNotify: async () => {},
    });
    await invokeTool(getTool(tools, "criar_tarefa"), { titulo });
    return "tarefa criada";
  }

  const { app, waitUntil } = makeAgentTelegramApp(db, {
    runAgentTurn: runAgentTurnMock,
  });

  const res = await postWebhook(
    app,
    topicMentionUpdate({
      updateId: 140014,
      telegramUserId: fx.tgId,
      chatId: fx.chatId,
      threadId: fx.threadId,
      text: ` criar tarefa ${titulo}`,
    }),
  );
  await waitUntil.drain();

  assert.equal(res.status, 200);
  assert.equal(
    countTarefas(db),
    tarefasBefore + 1,
    "exactly one new tarefas row must exist",
  );

  const row = db
    .prepare(
      `SELECT id, empresa_id, campanha_id, titulo, created_by, deleted_at
       FROM tarefas WHERE titulo = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(titulo);
  assert.ok(row, "tarefas row with create titulo must exist");
  assert.equal(row.empresa_id, fx.emp.id, "empresa_id must match mapped topic");
  assert.equal(
    row.campanha_id,
    fx.camp.id,
    "campanha_id must be the single open campanha",
  );
  assert.equal(row.created_by, fx.user.id);
  assert.equal(row.deleted_at, null);

  db.close();
});

// ─── lt-telegram-app-deps-ld21 ──────────────────────────────────────────────

/**
 * @description createTelegramApp factory accepts LD-21 deps: botUsername, llmKeyEncryptionSecret, waitUntil, optional runAgentTurn, optional agentInternalSecret, plus existing db/botToken/webhookSecret/fetchImpl.
 */
test("lt-telegram-app-deps-ld21: createTelegramApp accepts botUsername, llmKeyEncryptionSecret, waitUntil, runAgentTurn, agentInternalSecret", async () => {
  const src = readFileSync(TELEGRAM_ROUTES_PATH, "utf8");
  assert.ok(
    /export\s+function\s+createTelegramApp/.test(src) ||
      /export\s+\{\s*createTelegramApp/.test(src),
    "telegram.ts must export createTelegramApp",
  );
  assert.ok(
    /TelegramAppDeps/.test(src),
    "telegram.ts must declare TelegramAppDeps type",
  );

  // Source/type surface must name each LD-21 dep (and existing ones).
  for (const dep of [
    "botUsername",
    "llmKeyEncryptionSecret",
    "waitUntil",
    "runAgentTurn",
    "agentInternalSecret",
    "botToken",
    "webhookSecret",
    "fetchImpl",
  ]) {
    assert.ok(
      src.includes(dep),
      `TelegramAppDeps / createTelegramApp must accept ${dep} (LD-21)`,
    );
  }

  const db = openDb();
  const capture = createFetchCapture();
  const wu = createWaitUntilCapture();
  /** @type {number} */
  let runAgentTurnHits = 0;

  // Invoking with full deps must not throw (factory accepts the shape).
  let app;
  assert.doesNotThrow(() => {
    app = createTelegramApp(db, {
      botToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      fetchImpl: capture.fetchImpl,
      botUsername: BOT_USERNAME,
      llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
      waitUntil: wu.waitUntil,
      runAgentTurn: async () => {
        runAgentTurnHits += 1;
        return "ok";
      },
      agentInternalSecret: AGENT_INTERNAL_SECRET,
    });
  }, "createTelegramApp must accept full LD-21 deps object without throw");

  assert.ok(app, "createTelegramApp must return an app");
  assert.equal(typeof app.request, "function", "app must expose request()");

  // Smoke: secret-gated webhook still mounts
  const res = await app.request(WEBHOOK_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SECRET_HEADER]: WEBHOOK_SECRET,
    },
    body: JSON.stringify({ update_id: 1, message: { text: "/ping" } }),
  });
  assert.ok(
    res.status === 200 || res.status === 401,
    "webhook route must respond (200 after secret or 401 if misconfigured)",
  );
  // With valid secret, always 200 after auth (business no-ops included)
  assert.equal(res.status, 200, "valid secret → HTTP 200");

  void runAgentTurnHits;
  db.close();
});
