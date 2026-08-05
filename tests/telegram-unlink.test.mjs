/**
 * @description Locked DELETE /api/auth/telegram-link unlink contract.
 * Hermetic: node:sqlite + Hono app.request via createAuthApp(db).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 */
import assert from "node:assert/strict";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const SESSION_COOKIE_NAME = "gestao_session";
const TELEGRAM_LINK_PATH = "/api/auth/telegram-link";
const ME_PATH = "/api/auth/me";

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
 * @description Insert user_telegram_links row for a user.
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
 * @description Count user_telegram_links rows for a user (or all when userId omitted).
 * @param {DatabaseSync} db
 * @param {string} [userId]
 */
function countLinks(db, userId) {
  if (userId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM user_telegram_links WHERE user_id = ?`,
      )
      .get(userId);
    return Number(row.c);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM user_telegram_links`)
    .get();
  return Number(row.c);
}

// ─── lt-ac-4-unlink-unauthenticated-401 ────────────────────────────────────

/**
 * @description DELETE /api/auth/telegram-link without session cookie returns 401 with JSON error (not 204, not 500).
 */
test("lt-ac-4-unlink-unauthenticated-401: no cookie → 401 JSON error", async () => {
  const db = openDb();
  const app = createAuthApp(db);

  const res = await app.request(TELEGRAM_LINK_PATH, { method: "DELETE" });

  assert.equal(res.status, 401, "unauthenticated unlink must be 401");
  assert.notEqual(res.status, 204, "unauthenticated unlink must not be 204");
  assert.notEqual(res.status, 500, "unauthenticated unlink must not be 500");

  const body = await res.json();
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  assert.ok(
    "error" in body,
    "401 JSON body must include error",
  );

  db.close();
});

// ─── lt-ac-5-unlink-removes-session-user-row ────────────────────────────────

/**
 * @description Authenticated DELETE removes only the session user's user_telegram_links row; other users' rows remain; status 204.
 */
test("lt-ac-5-unlink-removes-session-user-row: A unlinks; B's row remains; 204", async () => {
  const db = openDb();
  const userA = await seedUser(db, {
    id: "user-a-unlink",
    email: "unlink-a@example.com",
    name: "User A",
  });
  const userB = await seedUser(db, {
    id: "user-b-unlink",
    email: "unlink-b@example.com",
    name: "User B",
  });
  seedTelegramLink(db, userA.id, "tg-user-a-111");
  seedTelegramLink(db, userB.id, "tg-user-b-222");
  assert.equal(countLinks(db, userA.id), 1);
  assert.equal(countLinks(db, userB.id), 1);

  const { cookie } = await sessionFor(db, userA.id);
  const app = createAuthApp(db);

  const res = await app.request(TELEGRAM_LINK_PATH, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });

  assert.equal(res.status, 204, "successful unlink must be 204");
  assert.equal(
    countLinks(db, userA.id),
    0,
    "user A's user_telegram_links row must be gone",
  );
  assert.equal(
    countLinks(db, userB.id),
    1,
    "user B's user_telegram_links row must remain",
  );

  const bRow = db
    .prepare(
      `SELECT user_id, telegram_user_id FROM user_telegram_links WHERE user_id = ?`,
    )
    .get(userB.id);
  assert.ok(bRow, "B link row exists");
  assert.equal(bRow.telegram_user_id, "tg-user-b-222");

  db.close();
});

// ─── lt-ac-6-unlink-idempotent-204-empty ───────────────────────────────────

/**
 * @description DELETE with no link (or after prior unlink) returns 204 with empty body (byte length 0); second DELETE also 204 empty.
 */
test("lt-ac-6-unlink-idempotent-204-empty: no row / second DELETE → 204 empty body", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "unlink-idem@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db);

  assert.equal(countLinks(db, user.id), 0, "user starts with no link");

  const res1 = await app.request(TELEGRAM_LINK_PATH, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(res1.status, 204, "first DELETE (no row) must be 204");
  const buf1 = new Uint8Array(await res1.arrayBuffer());
  assert.equal(buf1.byteLength, 0, "first DELETE body must be empty (0 bytes)");

  const res2 = await app.request(TELEGRAM_LINK_PATH, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(res2.status, 204, "second DELETE must also be 204");
  const buf2 = new Uint8Array(await res2.arrayBuffer());
  assert.equal(buf2.byteLength, 0, "second DELETE body must be empty (0 bytes)");

  db.close();
});

// ─── lt-ac-7-me-after-unlink-linked-false-no-tg-id ──────────────────────────

/**
 * @description After successful DELETE, GET /api/auth/me returns telegram:{linked:false}, no telegram_user_id key, and JSON text omits the prior telegram_user_id value.
 */
test("lt-ac-7-me-after-unlink-linked-false-no-tg-id: me after unlink has linked:false and no tg id", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "unlink-me@example.com" });
  const telegramUserId = "999888777";
  seedTelegramLink(db, user.id, telegramUserId);
  assert.equal(countLinks(db, user.id), 1);

  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db);

  const delRes = await app.request(TELEGRAM_LINK_PATH, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(delRes.status, 204, "unlink must succeed");
  assert.equal(countLinks(db, user.id), 0, "link row removed");

  const meRes = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookie },
  });
  assert.equal(meRes.status, 200);
  const body = await meRes.json();
  const text = JSON.stringify(body);

  assert.deepEqual(
    body.telegram,
    { linked: false },
    "telegram must be exactly {linked:false}",
  );
  assert.equal(
    "telegram_user_id" in body,
    false,
    "body must not have telegram_user_id key",
  );
  assert.equal(
    text.includes(telegramUserId),
    false,
    "me JSON must not include the prior telegram_user_id value",
  );

  db.close();
});
