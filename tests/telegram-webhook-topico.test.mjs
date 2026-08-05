/**
 * Locked telegram webhook contract — POST /api/telegram/webhook /vincular_expert.
 * Hermetic: node:sqlite + Hono app.request via createTelegramApp(db, deps).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTelegramApp } from "../src/worker/routes/telegram.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const WEBHOOK_PATH = "/api/telegram/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

const BOT_TOKEN = "123456:ABC-DEF_fake-bot-token-material";
const WEBHOOK_SECRET = "whsec_fake_telegram_webhook_secret";

/** @description Success copy after expert topic map (not invalid/expired). */
const COPY_EXPERT_SUCCESS = "Tópico vinculado com sucesso.";
/** @description Invalid/unknown/used code copy (pt-br). */
const COPY_EXPERT_INVALID =
  "Código inválido ou já usado. Gere um novo comando em Admin → Telegram.";
/** @description Expired code copy (pt-br). */
const COPY_EXPERT_EXPIRED =
  "Código expirado. Gere um novo comando em Admin → Telegram.";
/** @description Reject when command is used outside group/supergroup (pt-br). */
const COPY_EXPERT_NOT_GROUP =
  "Este comando só funciona em um grupo ou supergrupo.";
/** @description Reject when message_thread_id is missing (pt-br). */
const COPY_EXPERT_MISSING_THREAD =
  "Este comando só funciona dentro de um tópico do grupo.";
/** @description Reject when empresa chat is not the inbound chat (pt-br). */
const COPY_EXPERT_WRONG_CHAT =
  "Vincule o grupo da empresa antes, ou use o grupo correto.";
/** @description Reject when thread already mapped to another expert (pt-br). */
const COPY_EXPERT_THREAD_TAKEN =
  "Este tópico já está vinculado a outro expert.";
/** @description Reject when expert is soft-deleted (pt-br). */
const COPY_EXPERT_DELETED =
  "Expert não encontrado ou removido. Gere um novo comando em Admin → Telegram.";

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
 * @description Seed a minimal empresa row.
 * @param {DatabaseSync} db
 * @param {string} id
 */
function seedEmpresa(db, id) {
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    id,
    `Empresa ${id}`,
  );
  return id;
}

/**
 * @description Seed a live expert under empresa (deleted_at NULL unless deletedAt set).
 * @param {DatabaseSync} db
 * @param {string} id
 * @param {string} empresaId
 * @param {{ deletedAt?: string | null, nome?: string }} [opts]
 */
function seedExpert(db, id, empresaId, opts = {}) {
  const nome = opts.nome ?? `Expert ${id}`;
  const deletedAt = opts.deletedAt ?? null;
  if (deletedAt === null) {
    db.prepare(
      `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
    ).run(id, empresaId, nome);
  } else {
    db.prepare(
      `INSERT INTO experts (id, empresa_id, nome, deleted_at) VALUES (?, ?, ?, ?)`,
    ).run(id, empresaId, nome, deletedAt);
  }
  return id;
}

/**
 * @description Soft-delete an expert (set deleted_at).
 * @param {DatabaseSync} db
 * @param {string} expertId
 */
function softDeleteExpert(db, expertId) {
  db.prepare(
    `UPDATE experts SET deleted_at = datetime('now') WHERE id = ?`,
  ).run(expertId);
}

/**
 * @description SHA-256 hex digest of utf8 string.
 * @param {string} value
 */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * @description Generate a 64-char lowercase hex raw bind code (32 bytes).
 */
function freshRawCode() {
  return randomBytes(32).toString("hex");
}

/**
 * @description Insert unused kind=expert telegram_bind_codes row; returns { rawCode, codeHash, id }.
 * @param {DatabaseSync} db
 * @param {string} empresaId
 * @param {string} expertId
 * @param {{ expiresAtSql?: string, rawCode?: string }} [opts]
 */
function insertUnusedExpertCode(db, empresaId, expertId, opts = {}) {
  const rawCode = opts.rawCode ?? freshRawCode();
  assert.match(rawCode, /^[0-9a-f]{64}$/);
  const codeHash = sha256Hex(rawCode);
  const id = crypto.randomUUID();
  const expiresAtSql = opts.expiresAtSql ?? "datetime('now', '+15 minutes')";
  db.prepare(
    `INSERT INTO telegram_bind_codes
       (id, empresa_id, kind, expert_id, code_hash, expires_at, used_at, created_at)
     VALUES (?, ?, 'expert', ?, ?, ${expiresAtSql}, NULL, datetime('now'))`,
  ).run(id, empresaId, expertId, codeHash);
  return { id, rawCode, codeHash };
}

/**
 * @description Mark a bind code as already consumed (used_at set).
 * @param {DatabaseSync} db
 * @param {string} codeHash
 */
function markBindCodeUsed(db, codeHash) {
  db.prepare(
    `UPDATE telegram_bind_codes SET used_at = datetime('now') WHERE code_hash = ?`,
  ).run(codeHash);
}

/**
 * @description Insert empresa_telegram_chats map row.
 * @param {DatabaseSync} db
 * @param {string} empresaId
 * @param {string} chatId
 */
function insertEmpresaChat(db, empresaId, chatId) {
  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(empresaId, String(chatId));
}

/**
 * @description Insert expert_telegram_topics map row.
 * @param {DatabaseSync} db
 * @param {{ expertId: string, empresaId: string, chatId: string|number, messageThreadId: string|number }} opts
 */
function insertExpertTopic(db, opts) {
  db.prepare(
    `INSERT INTO expert_telegram_topics
       (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(
    opts.expertId,
    opts.empresaId,
    String(opts.chatId),
    String(opts.messageThreadId),
  );
}

/**
 * @description List expert_telegram_topics rows ordered by expert_id.
 * @param {DatabaseSync} db
 */
function listExpertTopics(db) {
  return db
    .prepare(
      `SELECT expert_id, empresa_id, chat_id, message_thread_id
         FROM expert_telegram_topics
        ORDER BY expert_id`,
    )
    .all();
}

/**
 * @description Topics for one expert (or empty array).
 * @param {DatabaseSync} db
 * @param {string} expertId
 */
function topicsForExpert(db, expertId) {
  return db
    .prepare(
      `SELECT expert_id, empresa_id, chat_id, message_thread_id
         FROM expert_telegram_topics
        WHERE expert_id = ?`,
    )
    .all(expertId);
}

/**
 * @description Count expert_telegram_topics for an expert (or all when expertId omitted).
 * @param {DatabaseSync} db
 * @param {string} [expertId]
 */
function countExpertTopics(db, expertId) {
  if (expertId != null) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM expert_telegram_topics WHERE expert_id = ?`,
      )
      .get(expertId);
    return Number(row.c);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM expert_telegram_topics`)
    .get();
  return Number(row.c);
}

/**
 * @description used_at for a bind code_hash (or undefined if missing).
 * @param {DatabaseSync} db
 * @param {string} codeHash
 */
function getBindCodeUsedAt(db, codeHash) {
  const row = db
    .prepare(`SELECT used_at FROM telegram_bind_codes WHERE code_hash = ?`)
    .get(codeHash);
  return row ? row.used_at : undefined;
}

/**
 * @description Minimal Telegram /vincular_expert update body.
 * @param {string} rawCode
 * @param {{ chatId?: number|string, chatType?: string, fromId?: number, threadId?: number|string|null, botSuffix?: boolean, omitThread?: boolean }} [opts]
 */
function vincularExpertUpdate(rawCode, opts = {}) {
  const chatId = opts.chatId ?? -1001;
  const chatType = opts.chatType ?? "supergroup";
  const fromId = opts.fromId ?? 111;
  const cmd = opts.botSuffix
    ? `/vincular_expert@gestao_bot ${rawCode}`
    : `/vincular_expert ${rawCode}`;
  /** @type {{ message: Record<string, unknown> }} */
  const update = {
    message: {
      text: cmd,
      from: { id: fromId },
      chat: { id: chatId, type: chatType },
    },
  };
  if (!opts.omitThread) {
    if (opts.threadId !== undefined && opts.threadId !== null) {
      update.message.message_thread_id = opts.threadId;
    } else if (opts.threadId === null) {
      // explicit null: leave absent
    } else {
      // default thread when not omitted
      update.message.message_thread_id = 42;
    }
  }
  return update;
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
 * @description Last captured sendMessage JSON body, or null.
 * @param {{ calls: Array<{ url: string, body: unknown }> }} capture
 */
function lastSendMessageBody(capture) {
  const sendCalls = capture.calls.filter(
    (c) =>
      typeof c.url === "string" &&
      c.url.includes("sendMessage") &&
      c.body &&
      typeof c.body === "object",
  );
  if (sendCalls.length === 0) return null;
  return /** @type {Record<string, unknown>} */ (
    sendCalls[sendCalls.length - 1].body
  );
}

/**
 * @description Last captured sendMessage text, or null.
 * @param {{ calls: Array<{ url: string, body: unknown }> }} capture
 */
function lastSendMessageText(capture) {
  const body = lastSendMessageBody(capture);
  if (!body) return null;
  return typeof body.text === "string" ? body.text : null;
}

/**
 * @description True when text is a success copy (not invalid/expired/reject).
 * @param {string | null} text
 */
function isSuccessCopy(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text === COPY_EXPERT_INVALID) return false;
  if (text === COPY_EXPERT_EXPIRED) return false;
  if (text === COPY_EXPERT_NOT_GROUP) return false;
  if (text === COPY_EXPERT_MISSING_THREAD) return false;
  if (text === COPY_EXPERT_WRONG_CHAT) return false;
  if (text === COPY_EXPERT_THREAD_TAKEN) return false;
  if (text === COPY_EXPERT_DELETED) return false;
  return text === COPY_EXPERT_SUCCESS || /sucesso/i.test(text);
}

/**
 * @description True when text is an error/reject copy in pt-br (not success).
 * @param {string | null} text
 */
function isErrorCopyPtBr(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (isSuccessCopy(text)) return false;
  return (
    text === COPY_EXPERT_INVALID ||
    text === COPY_EXPERT_EXPIRED ||
    text === COPY_EXPERT_NOT_GROUP ||
    text === COPY_EXPERT_MISSING_THREAD ||
    text === COPY_EXPERT_WRONG_CHAT ||
    text === COPY_EXPERT_THREAD_TAKEN ||
    text === COPY_EXPERT_DELETED ||
    /código|grupo|tópico|topico|comando|inválido|expirado|vinculad|expert/i.test(
      text,
    )
  );
}

/**
 * @description POST webhook with JSON update + optional secret header.
 * @param {import('hono').Hono} app
 * @param {unknown} update
 * @param {{ secret?: string | null }} [opts]
 */
async function postWebhook(app, update, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if ("secret" in opts) {
    if (opts.secret != null) {
      headers[SECRET_HEADER] = opts.secret;
    }
  } else {
    headers[SECRET_HEADER] = WEBHOOK_SECRET;
  }
  return app.request(WEBHOOK_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(update),
  });
}

/**
 * @description Build createTelegramApp with default secrets + capture fetch.
 * @param {DatabaseSync} db
 * @param {{ botToken?: string, webhookSecret?: string | undefined, omitWebhookSecret?: boolean }} [deps]
 */
function makeTelegramApp(db, deps = {}) {
  const capture = createFetchCapture();
  /** @type {{ botToken: string, webhookSecret?: string, fetchImpl: typeof capture.fetchImpl }} */
  const factoryDeps = {
    botToken: deps.botToken ?? BOT_TOKEN,
    fetchImpl: capture.fetchImpl,
  };
  if (!deps.omitWebhookSecret) {
    factoryDeps.webhookSecret =
      "webhookSecret" in deps ? deps.webhookSecret : WEBHOOK_SECRET;
  }
  const app = createTelegramApp(db, factoryDeps);
  return { app, capture, factoryDeps };
}

// ─── lt-wh-expert-topic-maps-and-replies-in-thread ─────────────────────────

/**
 * @description Unused kind=expert code + supergroup -1001 thread 42 → map + success copy + message_thread_id 42.
 */
test("lt-wh-expert-topic-maps-and-replies-in-thread: unused code + thread 42 → map, success, message_thread_id 42", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-map-a");
  const expertE = seedExpert(db, "exp-wh-ex-map-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
      threadId: 42,
    }),
  );
  assert.equal(res.status, 200, "webhook must return HTTP 200 after auth");

  const topics = topicsForExpert(db, expertE);
  assert.equal(topics.length, 1, "exactly one expert_telegram_topics row for E");
  assert.equal(topics[0].expert_id, expertE);
  assert.equal(topics[0].empresa_id, empresaA);
  assert.equal(String(topics[0].chat_id), "-1001");
  assert.equal(String(topics[0].message_thread_id), "42");

  assert.notEqual(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code used_at must be NOT NULL after successful map",
  );

  const body = lastSendMessageBody(capture);
  assert.ok(body, "sendMessage must be invoked");
  const text = typeof body.text === "string" ? body.text : null;
  assert.ok(isSuccessCopy(text), `sendMessage must be success copy, got: ${text}`);

  const thread = body.message_thread_id;
  assert.ok(
    thread === 42 || thread === "42",
    `JSON body must include message_thread_id equal to 42 (number or string), got: ${String(thread)}`,
  );

  db.close();
});

// ─── lt-wh-expert-missing-thread-no-claim ──────────────────────────────────

/**
 * @description Command without message_thread_id → used_at NULL, zero topics, error copy.
 */
test("lt-wh-expert-missing-thread-no-claim: no message_thread_id → used_at NULL, no map, error copy", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-mt-a");
  const expertE = seedExpert(db, "exp-wh-ex-mt-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
      omitThread: true,
    }),
  );
  assert.equal(res.status, 200, "webhook must return HTTP 200 after auth");

  assert.equal(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code used_at stays NULL (no claim without thread)",
  );
  assert.equal(
    countExpertTopics(db, expertE),
    0,
    "zero expert_telegram_topics rows for that expert",
  );

  const text = lastSendMessageText(capture);
  assert.ok(
    isErrorCopyPtBr(text),
    `Bot API error copy required, got: ${text}`,
  );
  assert.equal(isSuccessCopy(text), false);

  db.close();
});

// ─── lt-wh-expert-dm-or-nongroup-rejects ───────────────────────────────────

/**
 * @description Private chat (even with message_thread_id) → used_at NULL, no map, error copy, HTTP 200.
 */
test("lt-wh-expert-dm-or-nongroup-rejects: private chat → used_at NULL, no map, error copy", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-dm-a");
  const expertE = seedExpert(db, "exp-wh-ex-dm-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: 111,
      chatType: "private",
      fromId: 111,
      threadId: 42,
    }),
  );
  assert.equal(res.status, 200, "webhook must return HTTP 200 after auth");

  assert.equal(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code used_at stays NULL (no claim, no map)",
  );
  assert.equal(
    countExpertTopics(db, expertE),
    0,
    "zero expert_telegram_topics rows for that expert",
  );

  const text = lastSendMessageText(capture);
  assert.ok(
    isErrorCopyPtBr(text),
    `Bot API error copy in pt-br required, got: ${text}`,
  );
  assert.equal(
    isSuccessCopy(text),
    false,
    "must not send success copy on DM reject",
  );

  db.close();
});

// ─── lt-wh-expert-wrong-chat-reject ────────────────────────────────────────

/**
 * @description Empresa A mapped only to -1001; expert code in chat -2002 thread 1 → no topic insert.
 */
test("lt-wh-expert-wrong-chat-reject: A mapped -1001, code in -2002 → no expert_telegram_topics insert", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-wc-a");
  const expertE = seedExpert(db, "exp-wh-ex-wc-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: -2002,
      chatType: "supergroup",
      threadId: 1,
    }),
  );
  assert.equal(res.status, 200);

  assert.equal(
    countExpertTopics(db, expertE),
    0,
    "no expert_telegram_topics insert for that expert",
  );
  assert.equal(
    countExpertTopics(db),
    0,
    "no expert_telegram_topics rows at all",
  );

  // wrong-chat reject must not leave a successful map; claim without map is also forbidden
  // (used_at may stay NULL or be burned — assertion locks no insert only)
  void codeHash;
  void capture;

  db.close();
});

// ─── lt-wh-expert-thread-collision-reject ──────────────────────────────────

/**
 * @description Thread 7 already mapped to E1; E2 code on same chat+thread → E1 unchanged, E2 no row.
 */
test("lt-wh-expert-thread-collision-reject: E1 owns thread 7, E2 code same thread → E1 unchanged, E2 no row", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-tc-a");
  const expertE1 = seedExpert(db, "exp-wh-ex-tc-e1", empresaA);
  const expertE2 = seedExpert(db, "exp-wh-ex-tc-e2", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  insertExpertTopic(db, {
    expertId: expertE1,
    empresaId: empresaA,
    chatId: "-1001",
    messageThreadId: "7",
  });
  const { rawCode: rawE2 } = insertUnusedExpertCode(db, empresaA, expertE2);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawE2, {
      chatId: -1001,
      chatType: "supergroup",
      threadId: 7,
    }),
  );
  assert.equal(res.status, 200);

  const e1Topics = topicsForExpert(db, expertE1);
  assert.equal(e1Topics.length, 1, "E1 row unchanged (still one topic)");
  assert.equal(String(e1Topics[0].chat_id), "-1001");
  assert.equal(String(e1Topics[0].message_thread_id), "7");
  assert.equal(e1Topics[0].expert_id, expertE1);

  const e2Topics = topicsForExpert(db, expertE2);
  assert.equal(
    e2Topics.length,
    0,
    "E2 has no row on that thread (collision reject)",
  );

  // E2 must not own thread 7 via any row
  const onThread = listExpertTopics(db).filter(
    (t) =>
      String(t.chat_id) === "-1001" && String(t.message_thread_id) === "7",
  );
  assert.equal(onThread.length, 1);
  assert.equal(onThread[0].expert_id, expertE1);

  const text = lastSendMessageText(capture);
  assert.ok(
    isErrorCopyPtBr(text) || text != null,
    `reject path should reply via Bot API, got: ${text}`,
  );
  assert.equal(isSuccessCopy(text), false, "must not success on collision");

  db.close();
});

// ─── lt-wh-expert-relink-new-free-thread ────────────────────────────────────

/**
 * @description Expert E mapped to thread 7; fresh code + thread 8 → single row on 8, old 7 free, success.
 */
test("lt-wh-expert-relink-new-free-thread: E on thread 7 → free thread 8 updates map, old free, success", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-rl-a");
  const expertE = seedExpert(db, "exp-wh-ex-rl-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  insertExpertTopic(db, {
    expertId: expertE,
    empresaId: empresaA,
    chatId: "-1001",
    messageThreadId: "7",
  });
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
      threadId: 8,
    }),
  );
  assert.equal(res.status, 200, "relink must return HTTP 200");

  const topics = topicsForExpert(db, expertE);
  assert.equal(
    topics.length,
    1,
    "expert_telegram_topics has exactly one row for E",
  );
  assert.equal(String(topics[0].message_thread_id), "8");
  assert.equal(String(topics[0].chat_id), "-1001");
  assert.equal(topics[0].empresa_id, empresaA);

  const onThread7 = listExpertTopics(db).filter(
    (t) =>
      String(t.chat_id) === "-1001" &&
      String(t.message_thread_id) === "7" &&
      t.expert_id === expertE,
  );
  assert.equal(
    onThread7.length,
    0,
    "no row remains for E on thread 7 (old thread free)",
  );

  assert.notEqual(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code claimed after successful relink",
  );

  const text = lastSendMessageText(capture);
  assert.ok(isSuccessCopy(text), `success copy required, got: ${text}`);

  db.close();
});

// ─── lt-wh-expert-soft-delete-after-mint-no-insert ─────────────────────────

/**
 * @description Unused expert code minted then expert.deleted_at set → no expert_telegram_topics insert.
 */
test("lt-wh-expert-soft-delete-after-mint-no-insert: soft-deleted expert → no topic insert", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-sd-a");
  const expertE = seedExpert(db, "exp-wh-ex-sd-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  softDeleteExpert(db, expertE);

  const deleted = db
    .prepare(`SELECT deleted_at FROM experts WHERE id = ?`)
    .get(expertE);
  assert.notEqual(deleted?.deleted_at, null, "precondition: expert soft-deleted");

  const { app, capture } = makeTelegramApp(db);
  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
      threadId: 42,
    }),
  );
  assert.equal(res.status, 200);

  assert.equal(
    countExpertTopics(db, expertE),
    0,
    "no expert_telegram_topics insert (reject/burn without map)",
  );
  assert.equal(countExpertTopics(db), 0, "no topic rows at all");

  const text = lastSendMessageText(capture);
  assert.equal(
    isSuccessCopy(text),
    false,
    "must not send success copy for soft-deleted expert",
  );
  void codeHash;

  db.close();
});

// ─── lt-wh-expert-redelivery-same-thread-success ───────────────────────────

/**
 * @description Used expert code + map already (expert, chat, thread) matching inbound → success + message_thread_id.
 */
test("lt-wh-expert-redelivery-same-thread-success: used code + matching map → success copy with message_thread_id", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ex-rd-a");
  const expertE = seedExpert(db, "exp-wh-ex-rd-e", empresaA);
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedExpertCode(db, empresaA, expertE);
  markBindCodeUsed(db, codeHash);
  insertExpertTopic(db, {
    expertId: expertE,
    empresaId: empresaA,
    chatId: "-1001",
    messageThreadId: "42",
  });

  assert.notEqual(
    getBindCodeUsedAt(db, codeHash),
    null,
    "precondition: used_at set",
  );

  const { app, capture } = makeTelegramApp(db);
  const res = await postWebhook(
    app,
    vincularExpertUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
      threadId: 42,
    }),
  );
  assert.equal(res.status, 200, "redelivery must return HTTP 200");

  const topics = topicsForExpert(db, expertE);
  assert.equal(topics.length, 1);
  assert.equal(String(topics[0].message_thread_id), "42");
  assert.equal(String(topics[0].chat_id), "-1001");

  const body = lastSendMessageBody(capture);
  assert.ok(body, "sendMessage must be invoked on redelivery");
  const text = typeof body.text === "string" ? body.text : null;
  assert.ok(
    isSuccessCopy(text),
    `Bot API success copy (not error), got: ${text}`,
  );

  const thread = body.message_thread_id;
  assert.ok(
    thread === 42 || thread === "42",
    `message_thread_id must be present (42), got: ${String(thread)}`,
  );

  db.close();
});
