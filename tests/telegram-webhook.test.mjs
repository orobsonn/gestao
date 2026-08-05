/**
 * Locked telegram webhook contract — POST /api/telegram/webhook atomic claim.
 * Hermetic: node:sqlite + Hono app.request via createTelegramApp(db, deps) + createAuthApp for /me.
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import { createAuthApp } from "../src/worker/routes/auth.ts";
import { createTelegramApp } from "../src/worker/routes/telegram.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const TELEGRAM_ROUTES_PATH = resolve(
  __dirname,
  "../src/worker/routes/telegram.ts",
);

const SESSION_COOKIE_NAME = "gestao_session";
const WEBHOOK_PATH = "/api/telegram/webhook";
const ME_PATH = "/api/auth/me";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

const BOT_TOKEN = "123456:ABC-DEF_fake-bot-token-material";
const WEBHOOK_SECRET = "whsec_fake_telegram_webhook_secret";
const BOT_USERNAME = "gestao_bot";

const COPY_SUCCESS = "Conta vinculada com sucesso. Pode voltar ao Gestão.";
const COPY_INVALID =
  "Código inválido ou já usado. Gere um novo link em Minha conta.";
const COPY_EXPIRED = "Código expirado. Gere um novo link em Minha conta.";
const COPY_COLLISION = "Este Telegram já está vinculado a outra conta.";

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
 * @description Mint session and return Cookie header + raw token.
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
 * @description SHA-256 hex digest of utf8 string.
 * @param {string} value
 */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * @description Generate a 64-char lowercase hex raw link code (32 bytes).
 */
function freshRawCode() {
  return randomBytes(32).toString("hex");
}

/**
 * @description Insert an unused telegram_link_codes row; returns { rawCode, codeHash, id }.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {{ expiresAtSql?: string, rawCode?: string }} [opts]
 */
function insertUnusedCode(db, userId, opts = {}) {
  const rawCode = opts.rawCode ?? freshRawCode();
  assert.match(rawCode, /^[0-9a-f]{64}$/);
  const codeHash = sha256Hex(rawCode);
  const id = crypto.randomUUID();
  const expiresAtSql = opts.expiresAtSql ?? "datetime('now', '+15 minutes')";
  db.prepare(
    `INSERT INTO telegram_link_codes (id, user_id, code_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ${expiresAtSql}, NULL, datetime('now'))`,
  ).run(id, userId, codeHash);
  return { id, rawCode, codeHash };
}

/**
 * @description Mark a code as already consumed (used_at set).
 * @param {DatabaseSync} db
 * @param {string} codeHash
 */
function markCodeUsed(db, codeHash) {
  db.prepare(
    `UPDATE telegram_link_codes SET used_at = datetime('now') WHERE code_hash = ?`,
  ).run(codeHash);
}

/**
 * @description Insert user_telegram_links row.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {string} telegramUserId
 */
function insertLink(db, userId, telegramUserId) {
  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(userId, String(telegramUserId));
}

/**
 * @description All user_telegram_links rows ordered by user_id.
 * @param {DatabaseSync} db
 */
function listLinks(db) {
  return db
    .prepare(
      `SELECT user_id, telegram_user_id FROM user_telegram_links ORDER BY user_id`,
    )
    .all();
}

/**
 * @description Count user_telegram_links rows.
 * @param {DatabaseSync} db
 */
function countLinks(db) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM user_telegram_links`)
    .get();
  return Number(row.c);
}

/**
 * @description used_at for a code_hash (or undefined if missing).
 * @param {DatabaseSync} db
 * @param {string} codeHash
 */
function getCodeUsedAt(db, codeHash) {
  const row = db
    .prepare(`SELECT used_at FROM telegram_link_codes WHERE code_hash = ?`)
    .get(codeHash);
  return row ? row.used_at : undefined;
}

/**
 * @description Minimal Telegram /start update body.
 * @param {string} rawCode
 * @param {number} fromId
 * @param {number} [chatId]
 */
function startUpdate(rawCode, fromId, chatId = fromId) {
  return {
    message: {
      text: `/start ${rawCode}`,
      from: { id: fromId },
      chat: { id: chatId },
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
 * @description POST webhook with JSON update + optional secret header.
 * @param {import('hono').Hono} app
 * @param {unknown} update
 * @param {{ secret?: string | null }} [opts] omit secret key to skip header; null = send empty
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

// ─── lt-webhook-secret-required ────────────────────────────────────────────

/**
 * @description Blank/missing webhookSecret or wrong/missing secret header → 401; no DB write; fetchImpl not called.
 */
test("lt-webhook-secret-required: blank/missing secret or wrong/missing header → 401, no DB write, fetchImpl not called", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "wh-secret@example.com" });
  const { rawCode, codeHash } = insertUnusedCode(db, user.id);
  const update = startUpdate(rawCode, 111);

  /** @type {Array<{ label: string, build: () => ReturnType<typeof makeTelegramApp>, secretOpt: { secret?: string | null } }>} */
  const cases = [
    {
      label: "missing webhookSecret dep",
      build: () => makeTelegramApp(db, { omitWebhookSecret: true }),
      secretOpt: { secret: WEBHOOK_SECRET },
    },
    {
      label: "blank webhookSecret dep",
      build: () => makeTelegramApp(db, { webhookSecret: "" }),
      secretOpt: { secret: WEBHOOK_SECRET },
    },
    {
      label: "wrong header",
      build: () => makeTelegramApp(db),
      secretOpt: { secret: "wrong-secret-value" },
    },
    {
      label: "missing header",
      build: () => makeTelegramApp(db),
      secretOpt: { secret: null },
    },
  ];

  for (const { label, build, secretOpt } of cases) {
    const linksBefore = countLinks(db);
    const usedBefore = getCodeUsedAt(db, codeHash);
    assert.equal(usedBefore, null, `${label}: precondition used_at NULL`);

    const { app, capture } = build();
    const res = await postWebhook(app, update, secretOpt);

    assert.equal(res.status, 401, `${label}: must return 401`);
    assert.equal(
      countLinks(db),
      linksBefore,
      `${label}: user_telegram_links must be unchanged`,
    );
    assert.equal(
      getCodeUsedAt(db, codeHash),
      null,
      `${label}: code used_at must remain NULL`,
    );
    assert.equal(
      capture.calls.length,
      0,
      `${label}: fetchImpl must not be called`,
    );
  }

  db.close();
});

// ─── lt-webhook-valid-start-links ──────────────────────────────────────────

/**
 * @description Valid secret + unused code + from.id 111 → link A→111, used_at set, success copy, me.telegram.linked true.
 */
test("lt-webhook-valid-start-links: valid secret+code → link A→111, used_at set, success copy, me.linked true", async () => {
  const db = openDb();
  const userA = await seedUser(db, { email: "wh-valid-a@example.com" });
  const { rawCode, codeHash } = insertUnusedCode(db, userA.id);
  const { app, capture } = makeTelegramApp(db);

  const res = await postWebhook(app, startUpdate(rawCode, 111));
  assert.equal(res.status, 200, "webhook must return HTTP 200 after auth");

  const links = listLinks(db);
  assert.equal(links.length, 1, "exactly one link row");
  assert.equal(links[0].user_id, userA.id);
  assert.equal(String(links[0].telegram_user_id), "111");

  assert.notEqual(
    getCodeUsedAt(db, codeHash),
    null,
    "code used_at must be NOT NULL after claim",
  );

  assert.equal(
    lastSendMessageText(capture),
    COPY_SUCCESS,
    "sendMessage text must be exact success copy",
  );
  assert.ok(
    capture.calls.some((c) => String(c.url).includes("sendMessage")),
    "fetchImpl must be called with sendMessage",
  );

  const { cookie } = await sessionFor(db, userA.id);
  const authApp = createAuthApp(db, { botUsername: BOT_USERNAME });
  const meRes = await authApp.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookie },
  });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.deepEqual(me.telegram, { linked: true });
  assert.equal(me.telegram.linked, true);

  db.close();
});

// ─── lt-webhook-replay-no-rebind ───────────────────────────────────────────

/**
 * @description Consumed code + from 222 → no rebind, invalid copy, used_at remains set.
 */
test("lt-webhook-replay-no-rebind: consumed code + from 222 → no rebind, invalid copy", async () => {
  const db = openDb();
  const userA = await seedUser(db, { email: "wh-replay-a@example.com" });
  const { rawCode, codeHash } = insertUnusedCode(db, userA.id);
  insertLink(db, userA.id, "111");
  markCodeUsed(db, codeHash);

  const { app, capture } = makeTelegramApp(db);
  const res = await postWebhook(app, startUpdate(rawCode, 222));
  assert.equal(res.status, 200);

  const links = listLinks(db);
  assert.equal(links.length, 1, "still only one link");
  assert.equal(links[0].user_id, userA.id);
  assert.equal(String(links[0].telegram_user_id), "111");
  assert.equal(
    links.some((l) => String(l.telegram_user_id) === "222"),
    false,
    "no row for 222",
  );

  assert.equal(
    lastSendMessageText(capture),
    COPY_INVALID,
    "sendMessage must be invalid/used copy",
  );
  assert.notEqual(
    getCodeUsedAt(db, codeHash),
    null,
    "used_at remains set",
  );

  db.close();
});

// ─── lt-webhook-atomic-double-delivery ─────────────────────────────────────

/**
 * @description Sequential two claims different from.id → exactly one winner link for A; code consumed.
 */
test("lt-webhook-atomic-double-delivery: sequential two claims → one winner link only", async () => {
  const db = openDb();
  const userA = await seedUser(db, { email: "wh-double-a@example.com" });
  const { rawCode, codeHash } = insertUnusedCode(db, userA.id);

  const first = makeTelegramApp(db);
  const second = makeTelegramApp(db);

  const res1 = await postWebhook(first.app, startUpdate(rawCode, 111));
  const res2 = await postWebhook(second.app, startUpdate(rawCode, 222));
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const links = listLinks(db);
  assert.equal(links.length, 1, "exactly one user_telegram_links row");
  assert.equal(links[0].user_id, userA.id);
  const winnerTg = String(links[0].telegram_user_id);
  assert.ok(
    winnerTg === "111" || winnerTg === "222",
    `winner telegram_user_id must be 111 or 222, got ${winnerTg}`,
  );
  const loserTg = winnerTg === "111" ? "222" : "111";
  assert.equal(
    links.some((l) => String(l.telegram_user_id) === loserTg),
    false,
    "loser must not write a link",
  );

  assert.notEqual(
    getCodeUsedAt(db, codeHash),
    null,
    "code used_at must be NOT NULL",
  );

  db.close();
});

// ─── lt-webhook-expired-unknown-bad-alphabet ───────────────────────────────

/**
 * @description Expired / unknown 64-hex / bad alphabet → no link; correct copies; no hash-lookup side-effect rows.
 */
test("lt-webhook-expired-unknown-bad-alphabet: expired/unknown/bad alphabet → no link, correct copies", async () => {
  const db = openDb();
  const userA = await seedUser(db, { email: "wh-bad@example.com" });

  // (1) expired unused code
  {
    const { rawCode, codeHash } = insertUnusedCode(db, userA.id, {
      expiresAtSql: "datetime('now', '-1 minutes')",
    });
    const { app, capture } = makeTelegramApp(db);
    const linksBefore = countLinks(db);
    const res = await postWebhook(app, startUpdate(rawCode, 111));
    assert.equal(res.status, 200, "expired: HTTP 200 after auth");
    assert.equal(countLinks(db), linksBefore, "expired: no link write");
    assert.equal(
      lastSendMessageText(capture),
      COPY_EXPIRED,
      "expired: sendMessage expired copy",
    );
    // Code may or may not be consumed on expired path; assertion only requires no link.
    void codeHash;
  }

  // (2) unknown 64-hex
  {
    const unknownCode = freshRawCode();
    const unknownHash = sha256Hex(unknownCode);
    const codesBefore = db
      .prepare(`SELECT COUNT(*) AS c FROM telegram_link_codes`)
      .get();
    const { app, capture } = makeTelegramApp(db);
    const linksBefore = countLinks(db);
    const res = await postWebhook(app, startUpdate(unknownCode, 222));
    assert.equal(res.status, 200, "unknown: HTTP 200 after auth");
    assert.equal(countLinks(db), linksBefore, "unknown: no link write");
    assert.equal(
      lastSendMessageText(capture),
      COPY_INVALID,
      "unknown: invalid copy",
    );
    const codesAfter = db
      .prepare(`SELECT COUNT(*) AS c FROM telegram_link_codes`)
      .get();
    assert.equal(
      Number(codesAfter.c),
      Number(codesBefore.c),
      "unknown: no new telegram_link_codes side-effect rows",
    );
    assert.equal(
      getCodeUsedAt(db, unknownHash),
      undefined,
      "unknown: no row created for unknown hash",
    );
  }

  // (3) start arg not matching ^[0-9a-f]{64}$
  {
    const badArgs = ["SHORT", "ZZ".repeat(32), "not-hex-at-all", "ab".repeat(31)];
    for (const bad of badArgs) {
      const codesBefore = db
        .prepare(`SELECT COUNT(*) AS c FROM telegram_link_codes`)
        .get();
      const linksBefore = countLinks(db);
      const { app, capture } = makeTelegramApp(db);
      const res = await postWebhook(app, startUpdate(bad, 333));
      assert.equal(res.status, 200, `bad-alphabet(${bad}): HTTP 200`);
      assert.equal(
        countLinks(db),
        linksBefore,
        `bad-alphabet(${bad}): no link write`,
      );
      assert.equal(
        lastSendMessageText(capture),
        COPY_INVALID,
        `bad-alphabet(${bad}): invalid copy`,
      );
      const codesAfter = db
        .prepare(`SELECT COUNT(*) AS c FROM telegram_link_codes`)
        .get();
      assert.equal(
        Number(codesAfter.c),
        Number(codesBefore.c),
        `bad-alphabet(${bad}): no hash lookup side-effect rows`,
      );
    }
  }

  db.close();
});

// ─── lt-webhook-collision-no-steal ─────────────────────────────────────────

/**
 * @description B owns 111; A code + from 111 → collision copy; A no link; B keeps 111; A's code consumed.
 */
test("lt-webhook-collision-no-steal: B owns 111, A code + from 111 → collision, A no link, code consumed", async () => {
  const db = openDb();
  const userA = await seedUser(db, {
    id: "user-a-collision",
    email: "wh-coll-a@example.com",
  });
  const userB = await seedUser(db, {
    id: "user-b-collision",
    email: "wh-coll-b@example.com",
  });
  insertLink(db, userB.id, "111");
  const { rawCode, codeHash } = insertUnusedCode(db, userA.id);

  const { app, capture } = makeTelegramApp(db);
  const res = await postWebhook(app, startUpdate(rawCode, 111));
  assert.equal(res.status, 200);

  const links = listLinks(db);
  assert.equal(
    links.some((l) => l.user_id === userA.id),
    false,
    "A gains no link to 111",
  );
  const bLink = links.find((l) => l.user_id === userB.id);
  assert.ok(bLink, "B still has a link");
  assert.equal(String(bLink.telegram_user_id), "111", "B keeps 111");

  assert.equal(
    lastSendMessageText(capture),
    COPY_COLLISION,
    "sendMessage collision copy exact",
  );
  assert.notEqual(
    getCodeUsedAt(db, codeHash),
    null,
    "A's code used_at is NOT NULL (consumed after claim win)",
  );

  db.close();
});

// ─── lt-webhook-relink-and-idempotent-consume ──────────────────────────────

/**
 * @description A 111→222 replace with success; second same 222 consumes new code (idempotent).
 */
test("lt-webhook-relink-and-idempotent-consume: A 111→222 replace; second same 222 consumes code", async () => {
  const db = openDb();
  const userA = await seedUser(db, { email: "wh-relink-a@example.com" });
  insertLink(db, userA.id, "111");

  // (1) new code + from.id 222 → A linked only to 222, 111 free, success copy
  {
    const { rawCode, codeHash } = insertUnusedCode(db, userA.id);
    const { app, capture } = makeTelegramApp(db);
    const res = await postWebhook(app, startUpdate(rawCode, 222));
    assert.equal(res.status, 200);

    const links = listLinks(db);
    assert.equal(links.length, 1, "A has exactly one link after relink");
    assert.equal(links[0].user_id, userA.id);
    assert.equal(String(links[0].telegram_user_id), "222");
    assert.equal(
      links.some((l) => String(l.telegram_user_id) === "111"),
      false,
      "111 must be free after relink",
    );
    assert.equal(lastSendMessageText(capture), COPY_SUCCESS);
    assert.notEqual(
      getCodeUsedAt(db, codeHash),
      null,
      "relink code used_at NOT NULL",
    );
  }

  // (2) another new code + from.id 222 again → success + code consumed (same-user idempotent)
  {
    const { rawCode, codeHash } = insertUnusedCode(db, userA.id);
    const { app, capture } = makeTelegramApp(db);
    const res = await postWebhook(app, startUpdate(rawCode, 222));
    assert.equal(res.status, 200);

    const links = listLinks(db);
    assert.equal(links.length, 1);
    assert.equal(links[0].user_id, userA.id);
    assert.equal(String(links[0].telegram_user_id), "222");
    assert.equal(lastSendMessageText(capture), COPY_SUCCESS);
    assert.notEqual(
      getCodeUsedAt(db, codeHash),
      null,
      "idempotent path still consumes code (used_at NOT NULL)",
    );
  }

  db.close();
});

// ─── lt-webhook-no-per-empresa-bot ─────────────────────────────────────────

/**
 * @description botToken is a single factory/env secret string; no empresa bot-token table; responses never include secrets.
 */
test("lt-webhook-no-per-empresa-bot: single botToken factory; no secrets in responses", async () => {
  // Schema: no per-empresa bot token table / bot_token columns.
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const allSql = migrationFiles
    .map((name) => readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"))
    .join("\n");
  assert.equal(
    /CREATE\s+TABLE\s+\w*empresa\w*bot/i.test(allSql),
    false,
    "migrations must not define a per-empresa bot token table",
  );
  assert.equal(
    /bot_token/i.test(allSql),
    false,
    "migrations must not store bot_token columns",
  );

  // Factory source: botToken from deps, not empresa-scoped table load.
  const telegramSrc = readFileSync(TELEGRAM_ROUTES_PATH, "utf8");
  assert.ok(
    /createTelegramApp/.test(telegramSrc),
    "telegram routes must export createTelegramApp",
  );
  assert.ok(
    /botToken/.test(telegramSrc),
    "createTelegramApp must accept botToken dep",
  );
  assert.equal(
    /FROM\s+\w*empresa\w*bot/i.test(telegramSrc) ||
      /SELECT\s+.*bot_token/i.test(telegramSrc),
    false,
    "botToken must not be loaded from an empresa-scoped table",
  );

  const db = openDb();
  const userA = await seedUser(db, { email: "wh-noper@example.com" });
  const { rawCode } = insertUnusedCode(db, userA.id);
  const { app, capture, factoryDeps } = makeTelegramApp(db);

  assert.equal(typeof factoryDeps.botToken, "string");
  assert.equal(factoryDeps.botToken, BOT_TOKEN);
  assert.equal(typeof factoryDeps.webhookSecret, "string");

  const res = await postWebhook(app, startUpdate(rawCode, 111));
  assert.equal(res.status, 200);
  const webhookText = await res.text();
  assert.equal(
    webhookText.includes(BOT_TOKEN),
    false,
    "webhook response must never include botToken",
  );
  assert.equal(
    webhookText.includes(WEBHOOK_SECRET),
    false,
    "webhook response must never include webhookSecret",
  );

  // sendMessage request URL may embed bot token (Bot API path) — body/text to client must not.
  for (const call of capture.calls) {
    if (call.body && typeof call.body === "object") {
      const bodyText = JSON.stringify(call.body);
      assert.equal(
        bodyText.includes(WEBHOOK_SECRET),
        false,
        "sendMessage body must not include webhookSecret",
      );
    }
  }

  // me/mint responses never include secrets.
  const { cookie } = await sessionFor(db, userA.id);
  const authApp = createAuthApp(db, {
    botUsername: BOT_USERNAME,
    // If secrets ever leak into auth deps, they still must not appear in JSON.
    botToken: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
  });
  const meRes = await authApp.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookie },
  });
  assert.equal(meRes.status, 200);
  const meText = await meRes.text();
  assert.equal(meText.includes(BOT_TOKEN), false, "me JSON must not include botToken");
  assert.equal(
    meText.includes(WEBHOOK_SECRET),
    false,
    "me JSON must not include webhookSecret",
  );

  const mintRes = await authApp.request("/api/auth/telegram-link", {
    method: "POST",
    headers: { Cookie: cookie },
  });
  // 200 if username set; body must never leak secrets either way.
  const mintText = await mintRes.text();
  assert.equal(
    mintText.includes(BOT_TOKEN),
    false,
    "mint response must never include botToken",
  );
  assert.equal(
    mintText.includes(WEBHOOK_SECRET),
    false,
    "mint response must never include webhookSecret",
  );

  db.close();
});
