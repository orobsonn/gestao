/**
 * Locked telegram link mint + me.telegram contract.
 * Hermetic: node:sqlite + Hono app.request via createAuthApp(db, authDeps?).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const WORKER_INDEX_PATH = resolve(__dirname, "../src/worker/index.ts");
const DEV_VARS_EXAMPLE_PATH = resolve(__dirname, "../.dev.vars.example");
const AUTH_ROUTES_TEST_PATH = resolve(__dirname, "auth-routes.test.mjs");
const AUTH_ACTIVE_EMPRESA_TEST_PATH = resolve(
  __dirname,
  "auth-active-empresa.test.mjs",
);

const SESSION_COOKIE_NAME = "gestao_session";
const TELEGRAM_LINK_PATH = "/api/auth/telegram-link";
const ME_PATH = "/api/auth/me";
const BOT_USERNAME = "gestao_bot";
const DEEP_LINK_RE = /^https:\/\/t\.me\/gestao_bot\?start=([0-9a-f]{64})$/;

/** Sentinel values that must never leak into client JSON. */
const FAKE_BOT_TOKEN = "123456:ABC-DEF_fake-bot-token-material";
const FAKE_WEBHOOK_SECRET = "whsec_fake_telegram_webhook_secret";

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
 * @description SHA-256 hex digest of utf8 string.
 * @param {string} value
 */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * @description Count telegram_link_codes rows (optionally for a user).
 * @param {DatabaseSync} db
 * @param {string} [userId]
 */
function countLinkCodes(db, userId) {
  if (userId) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM telegram_link_codes WHERE user_id = ?`)
      .get(userId);
    return Number(row.c);
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM telegram_link_codes`).get();
  return Number(row.c);
}

/**
 * @description Count unused (used_at IS NULL) codes for a user.
 * @param {DatabaseSync} db
 * @param {string} userId
 */
function countUnusedCodes(db, userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM telegram_link_codes
       WHERE user_id = ? AND used_at IS NULL`,
    )
    .get(userId);
  return Number(row.c);
}

/**
 * @description Parse start param from deep_link URL.
 * @param {string} deepLink
 */
function startParamFromDeepLink(deepLink) {
  const m = DEEP_LINK_RE.exec(deepLink);
  assert.ok(m, `deep_link must match ${DEEP_LINK_RE}`);
  return m[1];
}

// ─── lt-mint-requires-session ──────────────────────────────────────────────

/**
 * @description POST /api/auth/telegram-link without session cookie returns 401 and inserts no codes.
 */
test("lt-mint-requires-session: no cookie → 401, telegram_link_codes stays 0", async () => {
  const db = openDb();
  const app = createAuthApp(db, { botUsername: BOT_USERNAME });

  const before = countLinkCodes(db);
  assert.equal(before, 0);

  const res = await app.request(TELEGRAM_LINK_PATH, { method: "POST" });

  assert.equal(res.status, 401, "unauthenticated mint must be 401");
  assert.equal(
    countLinkCodes(db),
    0,
    "no telegram_link_codes row after unauthenticated mint",
  );

  db.close();
});

// ─── lt-mint-deep-link-shape ───────────────────────────────────────────────

/**
 * @description Authenticated mint returns only deep_link+expires_at; stores SHA-256 of start; used_at null; raw ≠ hash.
 */
test("lt-mint-deep-link-shape: deep_link shape, body keys, code_hash = sha256(start), used_at null", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "mint-shape@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db, { botUsername: BOT_USERNAME });

  const res = await app.request(TELEGRAM_LINK_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });

  assert.equal(res.status, 200, "authenticated mint succeeds");
  const body = await res.json();
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);

  const keys = Object.keys(body).sort();
  assert.deepEqual(
    keys,
    ["deep_link", "expires_at"].sort(),
    "body keys must be exactly deep_link and expires_at",
  );

  assert.equal(typeof body.deep_link, "string");
  assert.equal(typeof body.expires_at, "string");
  assert.match(body.deep_link, DEEP_LINK_RE);

  const rawCode = startParamFromDeepLink(body.deep_link);
  const expectedHash = sha256Hex(rawCode);
  assert.notEqual(
    rawCode,
    expectedHash,
    "raw start code must not equal its SHA-256 hex",
  );

  const rows = db
    .prepare(
      `SELECT code_hash, used_at, user_id FROM telegram_link_codes WHERE user_id = ?`,
    )
    .all(user.id);
  assert.equal(rows.length, 1, "exactly one code row for user");
  assert.equal(rows[0].user_id, user.id);
  assert.equal(
    rows[0].code_hash,
    expectedHash,
    "DB code_hash must equal SHA-256 hex of start param",
  );
  assert.equal(rows[0].used_at, null, "fresh mint used_at IS NULL");

  const bodyText = JSON.stringify(body);
  assert.equal(
    bodyText.includes(expectedHash),
    false,
    "mint JSON must not leak code_hash",
  );
  assert.equal(
    bodyText.includes(FAKE_BOT_TOKEN),
    false,
    "mint JSON must not contain bot token",
  );

  db.close();
});

// ─── lt-mint-expires-at-ttl ────────────────────────────────────────────────

/**
 * @description Mint expires_at is within [T+14min, T+16min]; DB expires_at matches the same TTL window.
 */
test("lt-mint-expires-at-ttl: expires_at within T+14..T+16 min; DB matches", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "mint-ttl@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db, { botUsername: BOT_USERNAME });

  const tBefore = Date.now();
  const res = await app.request(TELEGRAM_LINK_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  const tAfter = Date.now();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.expires_at, "string");

  const expiresMs = Date.parse(body.expires_at);
  assert.ok(Number.isFinite(expiresMs), "expires_at must parse as instant");

  const minMs = tBefore + 14 * 60 * 1000;
  const maxMs = tAfter + 16 * 60 * 1000;
  assert.ok(
    expiresMs >= minMs,
    `expires_at ${body.expires_at} must be >= T+14min (min=${new Date(minMs).toISOString()})`,
  );
  assert.ok(
    expiresMs <= maxMs,
    `expires_at ${body.expires_at} must be <= T+16min (max=${new Date(maxMs).toISOString()})`,
  );

  const row = db
    .prepare(
      `SELECT expires_at FROM telegram_link_codes WHERE user_id = ? AND used_at IS NULL`,
    )
    .get(user.id);
  assert.ok(row, "unused code row exists");
  const dbExpiresMs = Date.parse(String(row.expires_at));
  assert.ok(
    Number.isFinite(dbExpiresMs),
    "DB expires_at must parse as instant",
  );
  assert.ok(
    dbExpiresMs >= minMs && dbExpiresMs <= maxMs,
    "DB expires_at must fall in the same T+14..T+16 window",
  );

  db.close();
});

// ─── lt-mint-invalidates-prior ─────────────────────────────────────────────

/**
 * @description Second mint invalidates prior unused code (used_at set); only one unused remains; start codes differ.
 */
test("lt-mint-invalidates-prior: second mint invalidates first; only one unused", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "mint-invalidate@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db, { botUsername: BOT_USERNAME });

  const res1 = await app.request(TELEGRAM_LINK_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  const c1 = startParamFromDeepLink(body1.deep_link);
  const hash1 = sha256Hex(c1);

  const res2 = await app.request(TELEGRAM_LINK_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  const c2 = startParamFromDeepLink(body2.deep_link);
  const hash2 = sha256Hex(c2);

  assert.notEqual(c1, c2, "second mint start code must differ from first");
  assert.notEqual(hash1, hash2, "second mint code_hash must differ from first");

  const rowC1 = db
    .prepare(`SELECT used_at FROM telegram_link_codes WHERE code_hash = ?`)
    .get(hash1);
  assert.ok(rowC1, "C1 row exists");
  assert.notEqual(
    rowC1.used_at,
    null,
    "C1 used_at must be NOT NULL after remint",
  );

  const rowC2 = db
    .prepare(`SELECT used_at FROM telegram_link_codes WHERE code_hash = ?`)
    .get(hash2);
  assert.ok(rowC2, "C2 row exists");
  assert.equal(rowC2.used_at, null, "C2 used_at must be IS NULL");

  assert.equal(
    countUnusedCodes(db, user.id),
    1,
    "only one unused code for user_id",
  );

  db.close();
});

// ─── lt-mint-503-without-username ──────────────────────────────────────────

/**
 * @description Authenticated mint without botUsername (or empty) returns 503 and inserts no code.
 */
test("lt-mint-503-without-username: no botUsername → 503, no new code row", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "mint-503@example.com" });
  const { cookie } = await sessionFor(db, user.id);

  /** @type {Array<{ label: string, app: ReturnType<typeof createAuthApp> }>} */
  const cases = [
    { label: "omitted deps", app: createAuthApp(db) },
    { label: "empty botUsername", app: createAuthApp(db, { botUsername: "" }) },
  ];

  for (const { label, app } of cases) {
    const before = countLinkCodes(db, user.id);
    const res = await app.request(TELEGRAM_LINK_PATH, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 503, `${label}: must return 503`);
    assert.equal(
      countLinkCodes(db, user.id),
      before,
      `${label}: must not insert telegram_link_codes`,
    );
  }

  db.close();
});

// ─── lt-me-telegram-linked-false ───────────────────────────────────────────

/**
 * @description GET /me with no link returns telegram:{linked:false}; no telegram_user_id; no token/hash leak.
 */
test("lt-me-telegram-linked-false: no link → telegram:{linked:false}; no leaks", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "me-unlinked@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db, { botUsername: BOT_USERNAME });

  // Seed an unused code so a hash exists in DB — must not leak into /me JSON.
  const rawCode = "ab".repeat(32);
  const codeHash = sha256Hex(rawCode);
  db.prepare(
    `INSERT INTO telegram_link_codes (id, user_id, code_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, datetime('now', '+15 minutes'), NULL, datetime('now'))`,
  ).run(crypto.randomUUID(), user.id, codeHash);

  const res = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
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
    text.includes(codeHash),
    false,
    "me JSON must not include any 64-hex code_hash from DB",
  );
  assert.equal(
    text.includes(FAKE_BOT_TOKEN),
    false,
    "me JSON must not include TELEGRAM_BOT_TOKEN value",
  );
  assert.equal(
    text.includes(FAKE_WEBHOOK_SECRET),
    false,
    "me JSON must not include webhook secret",
  );

  db.close();
});

// ─── lt-me-telegram-linked-true ────────────────────────────────────────────

/**
 * @description GET /me with a user_telegram_links row returns telegram:{linked:true}; no telegram_user_id key.
 */
test("lt-me-telegram-linked-true: with link → linked:true; no telegram_user_id key", async () => {
  const db = openDb();
  const user = await seedUser(db, { email: "me-linked@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db, { botUsername: BOT_USERNAME });

  const telegramUserId = "111222333";
  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(user.id, telegramUserId);

  const res = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = JSON.stringify(body);

  assert.deepEqual(
    body.telegram,
    { linked: true },
    "telegram must be exactly {linked:true}",
  );
  assert.equal(
    "telegram_user_id" in body,
    false,
    "body must not expose telegram_user_id key",
  );
  assert.equal(
    text.includes(telegramUserId),
    false,
    "me JSON must not leak telegram_user_id value",
  );
  assert.equal(
    text.includes(FAKE_BOT_TOKEN),
    false,
    "me JSON must not include bot token material",
  );
  assert.equal(
    text.includes(FAKE_WEBHOOK_SECRET),
    false,
    "me JSON must not include webhook secret",
  );

  db.close();
});

// ─── lt-single-global-bot-env ──────────────────────────────────────────────

/**
 * @description WorkerEnv + .dev.vars.example expose single app-level TELEGRAM_* keys; no per-empresa bot table; mint JSON has no secrets.
 */
test("lt-single-global-bot-env: TELEGRAM_* app-level keys; no per-empresa bot table; mint JSON no secrets", async () => {
  const workerEnvSrc = readFileSync(WORKER_INDEX_PATH, "utf8");
  const devVarsExample = readFileSync(DEV_VARS_EXAMPLE_PATH, "utf8");

  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_WEBHOOK_SECRET",
  ]) {
    assert.ok(
      workerEnvSrc.includes(key),
      `WorkerEnv source must declare ${key}`,
    );
    assert.ok(
      devVarsExample.includes(key),
      `.dev.vars.example must include placeholder for ${key}`,
    );
  }

  // No per-empresa bot token table in migrations.
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

  // Mint response never contains bot token or webhook secret.
  const db = openDb();
  const user = await seedUser(db, { email: "env-mint@example.com" });
  const { cookie } = await sessionFor(db, user.id);
  const app = createAuthApp(db, {
    botUsername: BOT_USERNAME,
    // If implementation ever threads secrets into deps, they still must not leak.
    botToken: FAKE_BOT_TOKEN,
    webhookSecret: FAKE_WEBHOOK_SECRET,
  });

  const res = await app.request(TELEGRAM_LINK_PATH, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const mintText = await res.text();
  assert.equal(
    mintText.includes(FAKE_BOT_TOKEN),
    false,
    "mint JSON must never contain bot token",
  );
  assert.equal(
    mintText.includes(FAKE_WEBHOOK_SECRET),
    false,
    "mint JSON must never contain webhook secret",
  );

  db.close();
});

// ─── lt-existing-auth-tests-full-chain-openDb ──────────────────────────────

/**
 * @description auth-routes and auth-active-empresa openDb helpers use full-chain readdirSync migrations + PRAGMA foreign_keys=ON (not single-file 0001 only).
 */
test("lt-existing-auth-tests-full-chain-openDb: auth-routes + auth-active-empresa openDb use readdirSync migrations chain", () => {
  const sources = [
    { path: AUTH_ROUTES_TEST_PATH, label: "tests/auth-routes.test.mjs" },
    {
      path: AUTH_ACTIVE_EMPRESA_TEST_PATH,
      label: "tests/auth-active-empresa.test.mjs",
    },
  ];

  for (const { path, label } of sources) {
    const src = readFileSync(path, "utf8");

    assert.ok(
      src.includes("readdirSync"),
      `${label} openDb must use readdirSync`,
    );
    assert.ok(
      /readdirSync\s*\(\s*MIGRATIONS/.test(src) ||
        /readdirSync\s*\([^)]*migrations/i.test(src),
      `${label} openDb must readdirSync the migrations/ directory`,
    );
    assert.ok(
      /\.endsWith\s*\(\s*["']\.sql["']\s*\)/.test(src) ||
        /filter\s*\([^)]*\.sql/.test(src),
      `${label} openDb must filter *.sql migration files`,
    );
    assert.ok(
      /\.sort\s*\(/.test(src),
      `${label} openDb must sort migration filenames`,
    );
    assert.ok(
      /PRAGMA\s+foreign_keys\s*=\s*ON/i.test(src),
      `${label} openDb must enable PRAGMA foreign_keys=ON`,
    );

    // Must not be single-file 0001_init only path.
    assert.equal(
      /migrations\/0001_init\.sql/.test(src) && !src.includes("readdirSync"),
      false,
      `${label} must not apply only migrations/0001_init.sql without full-chain readdirSync`,
    );
    assert.ok(
      !/const\s+MIGRATION_PATH\s*=\s*resolve\([^)]*0001_init\.sql/.test(src),
      `${label} must not hardcode single-file MIGRATION_PATH to 0001_init.sql`,
    );
  }
});
