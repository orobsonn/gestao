/**
 * Locked auth routes contract — POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me.
 * Hermetic: node:sqlite + Hono app.request via createAuthApp(db).
 * Applies migrations/0001_init.sql (foreign_keys=ON).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/worker/auth/password.ts";
import { createAuthApp } from "../src/worker/routes/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(__dirname, "../migrations/0001_init.sql");

const SESSION_COOKIE_NAME = "gestao_session";
const LOGIN_PATH = "/api/auth/login";
const LOGOUT_PATH = "/api/auth/logout";
const ME_PATH = "/api/auth/me";

/**
 * @description Open in-memory SQLite, enable FKs, apply 0001_init.sql.
 * @returns {DatabaseSync}
 */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  db.exec(sql);
  return db;
}

/**
 * @description Seed a super_admin user with a known password (hashPassword).
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string, password?: string }} [opts]
 */
async function seedSuperAdmin(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const email = opts.email ?? "sa@example.com";
  const name = opts.name ?? "Super Admin";
  const password = opts.password ?? "secure-pass-ok";
  assert.ok(password.length >= 8);

  const { hash, salt } = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'super_admin')`,
  ).run(id, email, name, hash, salt);

  return { id, email, name, password, role: "super_admin" };
}

/**
 * @description Extract first Set-Cookie header value (string or array).
 * @param {Headers} headers
 * @returns {string | null}
 */
function getSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") {
    const list = headers.getSetCookie();
    if (Array.isArray(list) && list.length > 0) {
      const match = list.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      return match ?? list[0] ?? null;
    }
  }
  const raw = headers.get("set-cookie");
  return raw;
}

/**
 * @description Parse gestao_session raw token from a Set-Cookie header string.
 * @param {string} setCookie
 * @returns {string | null}
 */
function parseSessionToken(setCookie) {
  if (!setCookie) return null;
  const part = setCookie.split(";")[0] ?? "";
  const eq = part.indexOf("=");
  if (eq < 0) return null;
  const name = part.slice(0, eq).trim();
  if (name !== SESSION_COOKIE_NAME) return null;
  return part.slice(eq + 1);
}

/**
 * @description Build Cookie request header from a Set-Cookie response header.
 * @param {string} setCookie
 */
function cookieHeaderFromSetCookie(setCookie) {
  const token = parseSessionToken(setCookie);
  assert.ok(token != null && token.length > 0, "Set-Cookie must carry gestao_session token");
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/**
 * @description SHA-256 hex of raw session token (matches session token_hash storage).
 * @param {string} rawToken
 */
function sha256Hex(rawToken) {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * @description Count sessions rows (optionally for a user).
 * @param {DatabaseSync} db
 * @param {string} [userId]
 */
function countSessions(db, userId) {
  if (userId) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?`)
      .get(userId);
    return Number(row.c);
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get();
  return Number(row.c);
}

/**
 * @description POST JSON helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 */
async function postJson(app, path, body, extraHeaders = {}) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

// ─── lt-login-sets-session-cookie ──────────────────────────────────────────

/**
 * @description Login as super_admin sets gestao_session cookie (Path=/, HttpOnly); GET /me returns {id,email,name,role} without password fields.
 */
test("lt-login-sets-session-cookie: login SA → Set-Cookie Path=/ HttpOnly; GET /me → user JSON no password fields", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, {
    email: "sa-login@example.com",
    password: "secure-pass-ok",
  });
  const app = createAuthApp(db);

  const loginRes = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: sa.password,
  });

  assert.equal(loginRes.status, 200, "login succeeds");
  const setCookie = getSetCookie(loginRes.headers);
  assert.ok(setCookie, "Set-Cookie present on login");
  assert.match(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=`), "cookie named gestao_session");
  assert.match(setCookie, /Path=\//, "Path=/");
  assert.match(setCookie, /HttpOnly/i, "HttpOnly");

  const cookieHeader = cookieHeaderFromSetCookie(setCookie);
  const meRes = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookieHeader },
  });

  assert.equal(meRes.status, 200, "/me authenticated");
  const me = await meRes.json();
  assert.equal(typeof me, "object");
  assert.equal(me.id, sa.id);
  assert.equal(me.email, sa.email);
  assert.equal(me.name, sa.name);
  assert.equal(me.role, "super_admin");
  assert.equal("password_hash" in me, false, "no password_hash in /me");
  assert.equal("password_salt" in me, false, "no password_salt in /me");
  assert.equal("password" in me, false, "no password in /me");

  db.close();
});

// ─── lt-login-bad-creds-generic-401 ────────────────────────────────────────

/**
 * @description Wrong password and unknown email both return 401 with the same generic error shape (no user enumeration).
 */
test("lt-login-bad-creds-generic-401: wrong password and unknown email both 401 same generic shape", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, {
    email: "sa-bad@example.com",
    password: "secure-pass-ok",
  });
  const app = createAuthApp(db);

  const wrongPwRes = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: "wrong-password-xx",
  });
  assert.equal(wrongPwRes.status, 401, "wrong password → 401");
  const wrongPwBody = await wrongPwRes.json();

  const unknownRes = await postJson(app, LOGIN_PATH, {
    email: "nobody@example.com",
    password: "secure-pass-ok",
  });
  assert.equal(unknownRes.status, 401, "unknown email → 401");
  const unknownBody = await unknownRes.json();

  // Same generic shape — no user-enumeration distinction.
  assert.deepEqual(
    unknownBody,
    wrongPwBody,
    "unknown email and wrong password must share the same generic error body",
  );
  assert.ok(wrongPwBody && typeof wrongPwBody === "object", "error body is object");
  // Must not leak which field failed or whether the user exists.
  const serialized = JSON.stringify(wrongPwBody).toLowerCase();
  assert.equal(serialized.includes("password_hash"), false);
  assert.equal(serialized.includes("not found"), false);

  db.close();
});

// ─── lt-login-anti-fixation ────────────────────────────────────────────────

/**
 * @description Two successful logins for the same user create distinct sessions token_hash rows (never reused).
 */
test("lt-login-anti-fixation: two logins → distinct sessions token_hash rows", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, {
    email: "sa-fix@example.com",
    password: "secure-pass-ok",
  });
  const app = createAuthApp(db);

  const res1 = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: sa.password,
  });
  assert.equal(res1.status, 200);
  const cookie1 = getSetCookie(res1.headers);
  const token1 = parseSessionToken(cookie1);
  assert.ok(token1);

  const res2 = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: sa.password,
  });
  assert.equal(res2.status, 200);
  const cookie2 = getSetCookie(res2.headers);
  const token2 = parseSessionToken(cookie2);
  assert.ok(token2);

  assert.notEqual(token1, token2, "raw tokens must differ across logins");

  const hash1 = sha256Hex(token1);
  const hash2 = sha256Hex(token2);
  assert.notEqual(hash1, hash2, "token_hash values must differ");

  const row1 = db
    .prepare(`SELECT id, token_hash FROM sessions WHERE token_hash = ?`)
    .get(hash1);
  const row2 = db
    .prepare(`SELECT id, token_hash FROM sessions WHERE token_hash = ?`)
    .get(hash2);

  assert.ok(row1, "first login session row exists");
  assert.ok(row2, "second login session row exists");
  assert.notEqual(row1.id, row2.id, "distinct sessions rows");
  assert.notEqual(row1.token_hash, row2.token_hash, "distinct token_hash values");

  assert.equal(countSessions(db, sa.id), 2, "two session rows for user");

  db.close();
});

// ─── lt-logout-invalidates-token ───────────────────────────────────────────

/**
 * @description Logout clears gestao_session (Path=/, Max-Age=0), deletes sessions row, subsequent /me is 401.
 */
test("lt-logout-invalidates-token: logout clears cookie Path=/ Max-Age=0, session gone, /me 401", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, {
    email: "sa-logout@example.com",
    password: "secure-pass-ok",
  });
  const app = createAuthApp(db);

  const loginRes = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: sa.password,
  });
  assert.equal(loginRes.status, 200);
  const setCookie = getSetCookie(loginRes.headers);
  const cookieHeader = cookieHeaderFromSetCookie(setCookie);
  const rawToken = parseSessionToken(setCookie);
  assert.ok(rawToken);

  const before = db
    .prepare(`SELECT id FROM sessions WHERE token_hash = ?`)
    .get(sha256Hex(rawToken));
  assert.ok(before, "session exists before logout");

  const logoutRes = await app.request(LOGOUT_PATH, {
    method: "POST",
    headers: { Cookie: cookieHeader },
  });
  assert.ok(
    logoutRes.status === 200 || logoutRes.status === 204,
    `logout status 200/204, got ${logoutRes.status}`,
  );

  const clearCookie = getSetCookie(logoutRes.headers);
  assert.ok(clearCookie, "logout Set-Cookie present");
  assert.match(clearCookie, new RegExp(`${SESSION_COOKIE_NAME}=`), "clears gestao_session");
  assert.match(clearCookie, /Path=\//, "clear Path=/");
  assert.match(clearCookie, /Max-Age=0/i, "clear Max-Age=0");

  const after = db
    .prepare(`SELECT id FROM sessions WHERE token_hash = ?`)
    .get(sha256Hex(rawToken));
  assert.equal(after, undefined, "sessions row deleted on logout");

  const meRes = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookieHeader },
  });
  assert.equal(meRes.status, 401, "/me with old cookie → 401");

  db.close();
});

// ─── lt-me-expired-clears-cookie ───────────────────────────────────────────

/**
 * @description Expired session on GET /me returns 401 and clears gestao_session (Max-Age=0, Path=/).
 */
test("lt-me-expired-clears-cookie: expired session on /me → 401 + clear cookie Max-Age=0 Path=/", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, {
    email: "sa-expired@example.com",
    password: "secure-pass-ok",
  });
  const app = createAuthApp(db);

  const loginRes = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: sa.password,
  });
  assert.equal(loginRes.status, 200);
  const setCookie = getSetCookie(loginRes.headers);
  const cookieHeader = cookieHeaderFromSetCookie(setCookie);
  const rawToken = parseSessionToken(setCookie);
  assert.ok(rawToken);

  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE token_hash = ?`,
  ).run(sha256Hex(rawToken));

  const meRes = await app.request(ME_PATH, {
    method: "GET",
    headers: { Cookie: cookieHeader },
  });

  assert.equal(meRes.status, 401, "expired session → 401");
  const clearCookie = getSetCookie(meRes.headers);
  assert.ok(clearCookie, "Set-Cookie clear present on expired /me");
  assert.match(clearCookie, new RegExp(`${SESSION_COOKIE_NAME}=`), "clears gestao_session");
  assert.match(clearCookie, /Max-Age=0/i, "Max-Age=0");
  assert.match(clearCookie, /Path=\//, "Path=/");

  db.close();
});

// ─── lt-login-short-password-400 ───────────────────────────────────────────

/**
 * @description Login with password length < 8 returns 400 and inserts no new sessions row.
 */
test("lt-login-short-password-400: password < 8 → 400, no new session", async () => {
  const db = openDb();
  const sa = await seedSuperAdmin(db, {
    email: "sa-short@example.com",
    password: "secure-pass-ok",
  });
  const app = createAuthApp(db);

  const before = countSessions(db);
  const shortPassword = "short"; // length 5 < 8
  assert.ok(shortPassword.length < 8);

  const res = await postJson(app, LOGIN_PATH, {
    email: sa.email,
    password: shortPassword,
  });

  assert.equal(res.status, 400, "short password → 400");
  assert.equal(countSessions(db), before, "no new sessions row inserted");

  db.close();
});
