/**
 * Locked Flue 2.x reply-path contract for the Telegram bot — no more internal HTTP hop
 * (`?wait=result` does not exist in Flue 2.x). `runAgentTurn` takes an injected agent-handle
 * PORT (`dispatch({ message }) -> receipt`, `read(receipt, { signal, onEvent }) -> reply`) and
 * resolves BOTH the reply text and a RESOLVED dedupe key.
 *
 * The dedupe key is ALWAYS `settledChunk.answeredBySubmissionId ?? receipt.submissionId` — never
 * the raw (possibly `undefined`) field, which against a `TEXT PRIMARY KEY NOT NULL` column would
 * coerce to the string `'undefined'` and mute every later solo reply.
 *
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted, via
 * createTelegramApp(db, deps) + a recording fetchImpl for the webhook-level assertions.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentRunError } from "@flue/runtime";
import { runAgentTurn, SAFE_REPLY } from "../src/worker/agent/run-agent-turn.ts";
import { createTelegramApp } from "../src/worker/routes/telegram.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const INDEX_SRC_PATH = resolve(__dirname, "../src/worker/index.ts");
const RUN_AGENT_TURN_SRC_PATH = resolve(
  __dirname,
  "../src/worker/agent/run-agent-turn.ts",
);

const TEST_ENCRYPTION_SECRET = "test-llm-key-encryption-secret-flue2-reply-path";
const PLAINTEXT_KEY = "sk-test-flue2-reply-path-plaintext-key";
const BOT_USERNAME = "GestaoBot";
const BOT_TOKEN = "123456:ABC-DEF_fake-bot-token-flue2";
const WEBHOOK_SECRET = "whsec_fake_flue2_webhook_secret";
const WEBHOOK_PATH = "/api/telegram/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

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
 * @description Seed a minimal empresas row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-flue2-a";
  const nome = opts.nome ?? "Empresa Flue2";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  return { id, nome };
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
 * @description Seed a minimal users row (dummy hash/salt — FK parent only).
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
 * @description Seed empresa_telegram_chats + expert_telegram_topics (chat/thread → empresa/expert).
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
 * @description Seed empresa_llm_settings row.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, provider?: string | null, ciphertext?: string | null, iv?: string | null, status?: string }} opts
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
}

/**
 * @description Topic @mention update fragment (case-insensitive bot username via entities).
 * @param {{ updateId: number, telegramUserId: string | number, chatId: number | string, threadId: number | string, text: string }} opts
 */
function topicMentionUpdate(opts) {
  const mention = `@${BOT_USERNAME}`;
  const text = `${mention}${opts.text}`;
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.updateId,
      from: {
        id: Number(opts.telegramUserId) || opts.telegramUserId,
        is_bot: false,
        first_name: "Actor",
      },
      chat: {
        id: opts.chatId,
        type: "supergroup",
        title: "Grupo Flue2",
        is_forum: true,
      },
      message_thread_id: opts.threadId,
      text,
      entities: [{ type: "mention", offset: 0, length: mention.length }],
      date: Math.floor(Date.now() / 1000),
    },
  };
}

/**
 * @description Capture Bot API calls via injectable fetchImpl.
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
 * @description Count recorded fetch calls whose URL hits the Telegram sendMessage endpoint —
 * never every recorded fetch.
 * @param {{ calls: Array<{ url: string }> }} capture
 */
function countSendMessageCalls(capture) {
  return capture.calls.filter(
    (c) => typeof c.url === "string" && c.url.includes("sendMessage"),
  ).length;
}

/**
 * @description POST webhook with JSON update + the webhook secret header.
 * @param {import('hono').Hono} app
 * @param {unknown} update
 */
async function postWebhook(app, update) {
  return app.request(WEBHOOK_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SECRET_HEADER]: WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
}

/**
 * @description Build a realistic `submission-settled` ConversationStreamChunk (the shape
 * `@flue/runtime`'s `AgentReadOptions.onEvent` receives). Omits `answeredBySubmissionId` ENTIRELY
 * when not given — genuinely absent, never merely set to `undefined`.
 * @param {{ submissionId: string, answeredBySubmissionId?: string, conversationId?: string, outcome?: "completed" | "failed" | "aborted" }} opts
 */
function buildSettledChunk(opts) {
  const chunk = {
    type: "submission-settled",
    conversationId: opts.conversationId ?? "conv-flue2-reply-path",
    submissionId: opts.submissionId,
    outcome: opts.outcome ?? "completed",
    position: { batch: 0, index: 0 },
  };
  if (opts.answeredBySubmissionId !== undefined) {
    chunk.answeredBySubmissionId = opts.answeredBySubmissionId;
  }
  return chunk;
}

/**
 * @description True when text is a non-empty pt-br copy (accented chars or common confirmation
 * tokens) and is NOT the SAFE_REPLY string — the discriminator between the
 * terminate-with-empty-text success branch and the failed-read branch.
 * @param {unknown} value
 */
function isNonEmptyPtBrConfirmation(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (t.length === 0) return false;
  if (t === SAFE_REPLY) return false;
  return (
    /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(t) ||
    /\b(conclu[ií]d|pronto|feito|sucesso|ok|registrad|salv|criad|finaliz|encerrad)\b/i.test(
      t,
    )
  );
}

// ─── lt-flue2-resolved-key-falls-back-to-own-submission ────────────────────

test("lt-flue2-resolved-key-falls-back-to-own-submission: absent answeredBySubmissionId → key falls back to receipt.submissionId", async () => {
  const settledChunk = buildSettledChunk({ submissionId: "sub_A" });
  assert.equal(
    Object.hasOwn(settledChunk, "answeredBySubmissionId"),
    false,
    "fixture chunk must genuinely OMIT answeredBySubmissionId — not merely set it to undefined",
  );

  const port = {
    dispatch: async () => ({
      submissionId: "sub_A",
      acceptedAt: new Date().toISOString(),
      uid: "uid-sub-a",
    }),
    read: async (_receipt, { onEvent }) => {
      onEvent(settledChunk);
      return { text: "Sua tarefa foi criada.", data: {}, submissionId: "sub_A" };
    },
  };

  const result = await runAgentTurn({
    sessionId: "topic:-1001:42",
    message: "criar tarefa de teste",
    port,
  });

  assert.equal(
    result.text,
    "Sua tarefa foi criada.",
    "runAgentTurn must resolve the agent's own reply text",
  );
  assert.notEqual(result.text, SAFE_REPLY, "success path must never resolve SAFE_REPLY");
  assert.equal(result.key, "sub_A", "dedupe key must fall back to receipt.submissionId");
  assert.notEqual(result.key, undefined, "dedupe key must never be undefined");
  assert.notEqual(result.key, null, "dedupe key must never be null on a successful solo reply");
  assert.notEqual(result.key, "undefined", "dedupe key must never be the string 'undefined'");
});

// ─── lt-flue2-coalesced-key-is-the-head ─────────────────────────────────────

test("lt-flue2-coalesced-key-is-the-head: present answeredBySubmissionId → key is the head submission, not the reader's own", async () => {
  const settledChunk = buildSettledChunk({
    submissionId: "sub_B",
    answeredBySubmissionId: "sub_A",
  });
  assert.equal(
    Object.hasOwn(settledChunk, "answeredBySubmissionId"),
    true,
    "fixture chunk must carry answeredBySubmissionId for a coalesced delivery",
  );

  const port = {
    dispatch: async () => ({
      submissionId: "sub_B",
      acceptedAt: new Date().toISOString(),
      uid: "uid-sub-b",
    }),
    read: async (_receipt, { onEvent }) => {
      onEvent(settledChunk);
      return { text: "Resposta coalescida.", data: {}, submissionId: "sub_B" };
    },
  };

  const result = await runAgentTurn({
    sessionId: "topic:-1001:42",
    message: "outra mensagem que juntou na resposta viva",
    port,
  });

  assert.equal(
    result.key,
    "sub_A",
    "dedupe key must be the head submission id that answered this delivery, not sub_B",
  );
});

// ─── lt-flue2-failed-read-is-safe-reply-with-null-key ───────────────────────

test("lt-flue2-failed-read-is-safe-reply-with-null-key: read rejects with AgentRunError → SAFE_REPLY text, null key, never throws", async () => {
  const port = {
    dispatch: async () => ({
      submissionId: "sub_fail",
      acceptedAt: new Date().toISOString(),
      uid: "uid-sub-fail",
    }),
    read: async () => {
      throw new AgentRunError({ outcome: "failed", submissionId: "sub_fail" });
    },
  };

  let threw = false;
  /** @type {{ text: string, key: string | null } | undefined} */
  let result;
  try {
    result = await runAgentTurn({
      sessionId: "topic:-1001:42",
      message: "mensagem que vai falhar",
      port,
    });
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "runAgentTurn must never throw, even when read() rejects");
  assert.ok(result, "runAgentTurn must resolve a result on the failure path");
  assert.equal(
    result.text,
    SAFE_REPLY,
    "failed read must resolve exactly the pt-br SAFE_REPLY text",
  );
  assert.equal(
    result.key,
    null,
    "failed read must resolve a null dedupe key so an apology is never suppressed by the guard",
  );
});

// ─── lt-flue2-empty-text-after-terminate-is-a-confirmation ──────────────────

test("lt-flue2-empty-text-after-terminate-is-a-confirmation: read resolves text=='' on a settled submission → non-empty pt-br confirmation, non-null key, distinct from the failed-read branch", async () => {
  const settledChunk = buildSettledChunk({ submissionId: "sub_terminate" });

  const port = {
    dispatch: async () => ({
      submissionId: "sub_terminate",
      acceptedAt: new Date().toISOString(),
      uid: "uid-sub-terminate",
    }),
    read: async (_receipt, { onEvent }) => {
      onEvent(settledChunk);
      return { text: "", data: {}, submissionId: "sub_terminate" };
    },
  };

  const result = await runAgentTurn({
    sessionId: "topic:-1001:42",
    message: "chame a ferramenta que termina sem texto",
    port,
  });

  assert.ok(
    isNonEmptyPtBrConfirmation(result.text),
    `empty-text-after-terminate must resolve a non-empty pt-br confirmation distinct from SAFE_REPLY, got: ${JSON.stringify(result.text)}`,
  );
  assert.notEqual(
    result.text,
    SAFE_REPLY,
    "empty text after a successful termination is not a failure — must not resolve SAFE_REPLY",
  );
  assert.notEqual(
    result.key,
    null,
    "a successful termination must resolve a non-null dedupe key",
  );
  assert.notEqual(result.key, undefined, "dedupe key must never be undefined");
});

// ─── lt-flue2-coalesced-reply-posts-once ────────────────────────────────────

test("lt-flue2-coalesced-reply-posts-once: two distinct updates, same resolved key → exactly one sendMessage call", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, {
    id: "emp-flue2-coalesce",
    nome: "Empresa Flue2 Coalesce",
  });
  const expert = seedExpert(db, {
    id: "expert-flue2-coalesce",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-9001",
    messageThreadId: "1",
  });
  const user = seedUser(db, { id: "user-flue2-coalesce" });
  const tgId = "700001";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id);

  const capture = createFetchCapture();
  const runAgentTurnMock = async () => ({
    reply: "Sua tarefa foi criada.",
    key: "sub_A",
  });

  const app = createTelegramApp(db, {
    botToken: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    fetchImpl: capture.fetchImpl,
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: runAgentTurnMock,
  });

  const update1 = topicMentionUpdate({
    updateId: 810001,
    telegramUserId: tgId,
    chatId: -9001,
    threadId: 1,
    text: " primeira mensagem",
  });
  const update2 = topicMentionUpdate({
    updateId: 810002,
    telegramUserId: tgId,
    chatId: -9001,
    threadId: 1,
    text: " segunda mensagem que junta na mesma resposta",
  });

  const res1 = await postWebhook(app, update1);
  const res2 = await postWebhook(app, update2);

  assert.equal(res1.status, 200, "first webhook response must be 200");
  assert.equal(res2.status, 200, "second webhook response must be 200");
  assert.equal(
    countSendMessageCalls(capture),
    1,
    "a coalesced repeat (same resolved key) must post sendMessage exactly once",
  );

  db.close();
});

// ─── lt-flue2-distinct-answers-post-twice ───────────────────────────────────

test("lt-flue2-distinct-answers-post-twice: two distinct updates, DIFFERENT resolved keys → exactly two sendMessage calls", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, {
    id: "emp-flue2-distinct",
    nome: "Empresa Flue2 Distinct",
  });
  const expert = seedExpert(db, {
    id: "expert-flue2-distinct",
    empresaId: emp.id,
  });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-9003",
    messageThreadId: "3",
  });
  const user = seedUser(db, { id: "user-flue2-distinct" });
  const tgId = "700002";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, emp.id, user.id);
  await seedValidLlm(db, emp.id);

  const capture = createFetchCapture();
  const keys = ["sub_A", "sub_B"];
  let callIndex = 0;
  const runAgentTurnMock = async () => {
    const key = keys[Math.min(callIndex, keys.length - 1)];
    callIndex += 1;
    return { reply: `Resposta ${key}`, key };
  };

  const app = createTelegramApp(db, {
    botToken: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    fetchImpl: capture.fetchImpl,
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: runAgentTurnMock,
  });

  const update1 = topicMentionUpdate({
    updateId: 830001,
    telegramUserId: tgId,
    chatId: -9003,
    threadId: 3,
    text: " primeira pergunta genuina",
  });
  const update2 = topicMentionUpdate({
    updateId: 830002,
    telegramUserId: tgId,
    chatId: -9003,
    threadId: 3,
    text: " segunda pergunta genuina, resposta distinta",
  });

  const res1 = await postWebhook(app, update1);
  const res2 = await postWebhook(app, update2);

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(
    countSendMessageCalls(capture),
    2,
    "two genuinely distinct answers (different resolved keys) must both post — the guard suppresses only a coalesced repeat",
  );

  db.close();
});

// ─── lt-flue2-gate-reply-is-never-suppressed ────────────────────────────────

test("lt-flue2-gate-reply-is-never-suppressed: FAIL_UNLINKED gate (no dedupe key) on two distinct updates → posts unconditionally, exactly two sendMessage calls", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, {
    id: "emp-flue2-gate",
    nome: "Empresa Flue2 Gate",
  });
  const expert = seedExpert(db, { id: "expert-flue2-gate", empresaId: emp.id });
  seedTopicMap(db, {
    empresaId: emp.id,
    expertId: expert.id,
    chatId: "-9002",
    messageThreadId: "2",
  });
  // Deliberately NO seedTelegramLink for this telegram user — unlinked → FAIL_UNLINKED gate,
  // no user_telegram_links row.
  const tgId = "700099";

  const capture = createFetchCapture();
  let agentCallCount = 0;
  const runAgentTurnMock = async () => {
    agentCallCount += 1;
    return { reply: "não deveria rodar", key: "should-not-be-used" };
  };

  const app = createTelegramApp(db, {
    botToken: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    fetchImpl: capture.fetchImpl,
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    runAgentTurn: runAgentTurnMock,
  });

  const update1 = topicMentionUpdate({
    updateId: 820001,
    telegramUserId: tgId,
    chatId: -9002,
    threadId: 2,
    text: " primeira mensagem gate",
  });
  const update2 = topicMentionUpdate({
    updateId: 820002,
    telegramUserId: tgId,
    chatId: -9002,
    threadId: 2,
    text: " segunda mensagem gate",
  });

  const res1 = await postWebhook(app, update1);
  const res2 = await postWebhook(app, update2);

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(
    agentCallCount,
    0,
    "runAgentTurn must never be called on the FAIL_UNLINKED gate",
  );
  assert.equal(
    countSendMessageCalls(capture),
    2,
    "a gate reply with no dedupe key must post unconditionally on every distinct update, never suppressed",
  );

  db.close();
});

// ─── lt-flue2-no-wait-result-anywhere ───────────────────────────────────────

test("lt-flue2-no-wait-result-anywhere: index.ts constructs the port via init(GestaoBot...); neither file references the retired ?wait=result hop", () => {
  const indexSrc = readFileSync(INDEX_SRC_PATH, "utf8");
  const runAgentTurnSrc = readFileSync(RUN_AGENT_TURN_SRC_PATH, "utf8");

  assert.ok(
    indexSrc.includes("init(GestaoBot"),
    "src/worker/index.ts must construct the agent-handle port via init(GestaoBot ...)",
  );
  assert.equal(
    indexSrc.includes("wait=result"),
    false,
    "src/worker/index.ts must not reference the retired ?wait=result HTTP hop",
  );
  assert.equal(
    runAgentTurnSrc.includes("wait=result"),
    false,
    "src/worker/agent/run-agent-turn.ts must not reference the retired ?wait=result HTTP hop",
  );
});
