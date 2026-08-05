/**
 * Locked telegram webhook contract — POST /api/telegram/webhook /vincular_empresa.
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

/** @description Success copy after empresa group map (not invalid/expired). */
const COPY_EMPRESA_SUCCESS = "Grupo vinculado com sucesso.";
/** @description Invalid/unknown/used code copy (pt-br). */
const COPY_EMPRESA_INVALID =
  "Código inválido ou já usado. Gere um novo comando em Admin → Telegram.";
/** @description Expired code copy (pt-br). */
const COPY_EMPRESA_EXPIRED =
  "Código expirado. Gere um novo comando em Admin → Telegram.";
/** @description Reject when command is used outside group/supergroup (pt-br). */
const COPY_EMPRESA_NOT_GROUP =
  "Este comando só funciona em um grupo ou supergrupo.";
/** @description Reject when chat already mapped to another empresa (pt-br). */
const COPY_EMPRESA_CHAT_TAKEN =
  "Este grupo já está vinculado a outra empresa.";
/** @description Reject when empresa already linked to a different chat (pt-br). */
const COPY_EMPRESA_ALREADY_LINKED =
  "Esta empresa já está vinculada a outro grupo.";

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
 * @description Insert unused kind=empresa telegram_bind_codes row; returns { rawCode, codeHash, id }.
 * @param {DatabaseSync} db
 * @param {string} empresaId
 * @param {{ expiresAtSql?: string, rawCode?: string }} [opts]
 */
function insertUnusedEmpresaCode(db, empresaId, opts = {}) {
  const rawCode = opts.rawCode ?? freshRawCode();
  assert.match(rawCode, /^[0-9a-f]{64}$/);
  const codeHash = sha256Hex(rawCode);
  const id = crypto.randomUUID();
  const expiresAtSql = opts.expiresAtSql ?? "datetime('now', '+15 minutes')";
  db.prepare(
    `INSERT INTO telegram_bind_codes
       (id, empresa_id, kind, expert_id, code_hash, expires_at, used_at, created_at)
     VALUES (?, ?, 'empresa', NULL, ?, ${expiresAtSql}, NULL, datetime('now'))`,
  ).run(id, empresaId, codeHash);
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
 * @description List empresa_telegram_chats rows ordered by empresa_id.
 * @param {DatabaseSync} db
 */
function listEmpresaChats(db) {
  return db
    .prepare(
      `SELECT empresa_id, chat_id FROM empresa_telegram_chats ORDER BY empresa_id`,
    )
    .all();
}

/**
 * @description Count empresa_telegram_chats for an empresa (or all when empresaId omitted).
 * @param {DatabaseSync} db
 * @param {string} [empresaId]
 */
function countEmpresaChats(db, empresaId) {
  if (empresaId != null) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM empresa_telegram_chats WHERE empresa_id = ?`,
      )
      .get(empresaId);
    return Number(row.c);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM empresa_telegram_chats`)
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
 * @description Minimal Telegram /vincular_empresa update body.
 * @param {string} rawCode
 * @param {{ chatId?: number|string, chatType?: string, fromId?: number, threadId?: number|string|null, botSuffix?: boolean }} [opts]
 */
function vincularEmpresaUpdate(rawCode, opts = {}) {
  const chatId = opts.chatId ?? -1001;
  const chatType = opts.chatType ?? "supergroup";
  const fromId = opts.fromId ?? 111;
  const cmd = opts.botSuffix
    ? `/vincular_empresa@gestao_bot ${rawCode}`
    : `/vincular_empresa ${rawCode}`;
  /** @type {{ message: Record<string, unknown> }} */
  const update = {
    message: {
      text: cmd,
      from: { id: fromId },
      chat: { id: chatId, type: chatType },
    },
  };
  if (opts.threadId != null) {
    update.message.message_thread_id = opts.threadId;
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
  if (text === COPY_EMPRESA_INVALID) return false;
  if (text === COPY_EMPRESA_EXPIRED) return false;
  if (text === COPY_EMPRESA_NOT_GROUP) return false;
  if (text === COPY_EMPRESA_CHAT_TAKEN) return false;
  if (text === COPY_EMPRESA_ALREADY_LINKED) return false;
  return text === COPY_EMPRESA_SUCCESS || /sucesso/i.test(text);
}

/**
 * @description True when text is an error/reject copy in pt-br (not success).
 * @param {string | null} text
 */
function isErrorCopyPtBr(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (isSuccessCopy(text)) return false;
  return (
    text === COPY_EMPRESA_INVALID ||
    text === COPY_EMPRESA_EXPIRED ||
    text === COPY_EMPRESA_NOT_GROUP ||
    text === COPY_EMPRESA_CHAT_TAKEN ||
    text === COPY_EMPRESA_ALREADY_LINKED ||
    /código|grupo|comando|inválido|expirado|vinculad/i.test(text)
  );
}

/**
 * @description True when text is expired or invalid copy.
 * @param {string | null} text
 */
function isInvalidOrExpiredCopy(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return (
    text === COPY_EMPRESA_INVALID ||
    text === COPY_EMPRESA_EXPIRED ||
    /inválido|expirado|já usado/i.test(text)
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

// ─── lt-wh-empresa-supergroup-maps ─────────────────────────────────────────

/**
 * @description Unused kind=empresa code + supergroup -1001 → map + success copy + HTTP 200.
 */
test("lt-wh-empresa-supergroup-maps: unused code + supergroup -1001 → map, success copy, HTTP 200", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-sg-a");
  const { rawCode, codeHash } = insertUnusedEmpresaCode(db, empresaA);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularEmpresaUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
    }),
  );
  assert.equal(res.status, 200, "webhook must return HTTP 200 after auth");

  const chats = listEmpresaChats(db);
  assert.equal(chats.length, 1, "exactly one empresa_telegram_chats row");
  assert.equal(chats[0].empresa_id, empresaA);
  assert.equal(String(chats[0].chat_id), "-1001");

  assert.notEqual(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code used_at must be NOT NULL after successful map",
  );

  const text = lastSendMessageText(capture);
  assert.ok(isSuccessCopy(text), `sendMessage must be success copy, got: ${text}`);
  assert.equal(
    isInvalidOrExpiredCopy(text),
    false,
    "success copy must not be invalid/expired",
  );
  assert.ok(
    capture.calls.some((c) => String(c.url).includes("sendMessage")),
    "fetchImpl must be called with sendMessage",
  );

  db.close();
});

// ─── lt-wh-empresa-dm-rejects-no-map ───────────────────────────────────────

/**
 * @description Private chat → no map, used_at NULL, error copy pt-br, HTTP 200.
 */
test("lt-wh-empresa-dm-rejects-no-map: private chat → no map, used_at NULL, error copy", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-dm-a");
  const { rawCode, codeHash } = insertUnusedEmpresaCode(db, empresaA);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularEmpresaUpdate(rawCode, {
      chatId: 111,
      chatType: "private",
      fromId: 111,
    }),
  );
  assert.equal(res.status, 200, "webhook must return HTTP 200 after auth");

  assert.equal(
    countEmpresaChats(db, empresaA),
    0,
    "zero rows in empresa_telegram_chats for that empresa",
  );
  assert.equal(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code used_at remains NULL (no claim without map)",
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

// ─── lt-wh-empresa-foreign-code-no-overwrite ───────────────────────────────

/**
 * @description B code on A's chat → A untouched, B used_at NULL (no claim without map).
 */
test("lt-wh-empresa-foreign-code-no-overwrite: B code on A chat → A untouched, B used_at NULL", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-fx-a");
  const empresaB = seedEmpresa(db, "emp-wh-fx-b");
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode: rawB, codeHash: hashB } = insertUnusedEmpresaCode(
    db,
    empresaB,
  );
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularEmpresaUpdate(rawB, {
      chatId: -1001,
      chatType: "supergroup",
    }),
  );
  assert.equal(res.status, 200);

  const chats = listEmpresaChats(db);
  assert.equal(chats.length, 1, "still exactly one map row");
  assert.equal(chats[0].empresa_id, empresaA, "A still owns the chat");
  assert.equal(String(chats[0].chat_id), "-1001");
  assert.equal(
    chats.some((c) => c.empresa_id === empresaB),
    false,
    "B has no empresa_telegram_chats row",
  );
  assert.equal(
    countEmpresaChats(db, empresaB),
    0,
    "B must not map to -1001",
  );

  assert.equal(
    getBindCodeUsedAt(db, hashB),
    null,
    "B-code used_at stays NULL (no claim without successful map)",
  );

  const text = lastSendMessageText(capture);
  assert.ok(
    isErrorCopyPtBr(text),
    `reject/error copy required, got: ${text}`,
  );
  assert.equal(isSuccessCopy(text), false);

  db.close();
});

// ─── lt-wh-empresa-different-chat-reject ───────────────────────────────────

/**
 * @description A linked -1001, code used in -2002 → stays -1001, used_at NULL, reject copy.
 */
test("lt-wh-empresa-different-chat-reject: A linked -1001, code in -2002 → stays -1001, used_at NULL", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-dc-a");
  insertEmpresaChat(db, empresaA, "-1001");
  const { rawCode, codeHash } = insertUnusedEmpresaCode(db, empresaA);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularEmpresaUpdate(rawCode, {
      chatId: -2002,
      chatType: "group",
    }),
  );
  assert.equal(res.status, 200);

  const chats = listEmpresaChats(db);
  assert.equal(chats.length, 1, "still one map row for A");
  assert.equal(chats[0].empresa_id, empresaA);
  assert.equal(
    String(chats[0].chat_id),
    "-1001",
    "map row remains chat_id='-1001' (not updated to -2002)",
  );
  assert.equal(
    chats.some((c) => String(c.chat_id) === "-2002"),
    false,
    "must not create/move map to -2002",
  );

  assert.equal(
    getBindCodeUsedAt(db, codeHash),
    null,
    "code used_at stays NULL (no claim without successful map)",
  );

  const text = lastSendMessageText(capture);
  assert.ok(
    isErrorCopyPtBr(text),
    `outcome is reject copy, got: ${text}`,
  );
  assert.equal(isSuccessCopy(text), false);

  db.close();
});

// ─── lt-wh-empresa-invalid-expired ─────────────────────────────────────────

/**
 * @description Expired or unknown code → no empresa_telegram_chats insert, invalid/expired copy.
 */
test("lt-wh-empresa-invalid-expired: expired/unknown code → no insert, invalid/expired copy", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-ie-a");

  // (1) expired unused code
  {
    const { rawCode } = insertUnusedEmpresaCode(db, empresaA, {
      expiresAtSql: "datetime('now', '-1 minutes')",
    });
    const chatsBefore = countEmpresaChats(db);
    const { app, capture } = makeTelegramApp(db);
    const res = await postWebhook(
      app,
      vincularEmpresaUpdate(rawCode, {
        chatId: -1001,
        chatType: "supergroup",
      }),
    );
    assert.equal(res.status, 200, "expired: HTTP 200 after auth");
    assert.equal(
      countEmpresaChats(db),
      chatsBefore,
      "expired: no empresa_telegram_chats insert",
    );
    const text = lastSendMessageText(capture);
    assert.ok(
      isInvalidOrExpiredCopy(text),
      `expired: Bot API expired/invalid copy, got: ${text}`,
    );
    assert.equal(isSuccessCopy(text), false);
  }

  // (2) unknown 64-hex
  {
    const unknownCode = freshRawCode();
    const unknownHash = sha256Hex(unknownCode);
    const codesBefore = db
      .prepare(`SELECT COUNT(*) AS c FROM telegram_bind_codes`)
      .get();
    const chatsBefore = countEmpresaChats(db);
    const { app, capture } = makeTelegramApp(db);
    const res = await postWebhook(
      app,
      vincularEmpresaUpdate(unknownCode, {
        chatId: -1001,
        chatType: "supergroup",
      }),
    );
    assert.equal(res.status, 200, "unknown: HTTP 200 after auth");
    assert.equal(
      countEmpresaChats(db),
      chatsBefore,
      "unknown: no empresa_telegram_chats insert",
    );
    const text = lastSendMessageText(capture);
    assert.ok(
      isInvalidOrExpiredCopy(text),
      `unknown: Bot API expired/invalid copy, got: ${text}`,
    );
    const codesAfter = db
      .prepare(`SELECT COUNT(*) AS c FROM telegram_bind_codes`)
      .get();
    assert.equal(
      Number(codesAfter.c),
      Number(codesBefore.c),
      "unknown: no new telegram_bind_codes side-effect rows",
    );
    assert.equal(
      getBindCodeUsedAt(db, unknownHash),
      undefined,
      "unknown: no row created for unknown hash",
    );
  }

  db.close();
});

// ─── lt-wh-empresa-redelivery-success ──────────────────────────────────────

/**
 * @description used code + map already matches inbound chat → success copy, HTTP 200.
 */
test("lt-wh-empresa-redelivery-success: used code + matching map → success copy, HTTP 200", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-rd-a");
  const { rawCode, codeHash } = insertUnusedEmpresaCode(db, empresaA);
  markBindCodeUsed(db, codeHash);
  insertEmpresaChat(db, empresaA, "-1001");

  assert.notEqual(
    getBindCodeUsedAt(db, codeHash),
    null,
    "precondition: used_at set",
  );

  const { app, capture } = makeTelegramApp(db);
  const res = await postWebhook(
    app,
    vincularEmpresaUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
    }),
  );
  assert.equal(res.status, 200, "redelivery must return HTTP 200");

  const chats = listEmpresaChats(db);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].empresa_id, empresaA);
  assert.equal(String(chats[0].chat_id), "-1001");

  const text = lastSendMessageText(capture);
  assert.ok(
    isSuccessCopy(text),
    `Bot API success copy (not error), got: ${text}`,
  );
  assert.equal(
    isErrorCopyPtBr(text) && !isSuccessCopy(text),
    false,
    "must not send error copy on matching redelivery",
  );

  db.close();
});

// ─── lt-wh-empresa-sendmessage-thread-when-present ─────────────────────────

/**
 * @description Successful empresa bind with inbound message_thread_id=99 → sendMessage body has message_thread_id 99.
 */
test("lt-wh-empresa-sendmessage-thread-when-present: inbound thread 99 → sendMessage body message_thread_id 99", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, "emp-wh-th-a");
  const { rawCode } = insertUnusedEmpresaCode(db, empresaA);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(
    app,
    vincularEmpresaUpdate(rawCode, {
      chatId: -1001,
      chatType: "supergroup",
      threadId: 99,
    }),
  );
  assert.equal(res.status, 200);

  // Map must succeed so sendMessage is the success path under test.
  const chats = listEmpresaChats(db);
  assert.equal(chats.length, 1, "bind must succeed for thread assertion");
  assert.equal(String(chats[0].chat_id), "-1001");

  const body = lastSendMessageBody(capture);
  assert.ok(body, "sendMessage must be invoked");
  assert.ok(
    isSuccessCopy(typeof body.text === "string" ? body.text : null),
    "sendMessage text must be success copy on successful bind",
  );

  const thread = body.message_thread_id;
  assert.ok(
    thread === 99 || thread === "99",
    `JSON body must include message_thread_id equal to 99 (number or string), got: ${String(thread)}`,
  );

  db.close();
});
