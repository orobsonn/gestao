/**
 * Locked auth primitives contract — password hash/verify + session mint/resolve/logout/cookies.
 * Applies migrations/0001_init.sql against ephemeral SQLite (foreign_keys=ON).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "../src/worker/auth/password.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  logoutSession,
  mintSession,
  resolveSession,
} from "../src/worker/auth/session.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(__dirname, "../migrations/0001_init.sql");

const HEX_RE = /^[0-9a-f]+$/i;
/** SQLite datetime('now') shape: no T, no Z */
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

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
 * @description Seed a minimal users row for session tests.
 * @param {DatabaseSync} db
 * @param {string} id
 */
function seedUser(db, id = "user-1") {
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `${id}@example.com`, `User ${id}`, "hash", "salt");
  return id;
}

/**
 * @description SHA-256 hex digest of a raw session token (judgment: token_hash_alg).
 * @param {string} rawToken
 */
function sha256Hex(rawToken) {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

// ─── lt-password-roundtrip ─────────────────────────────────────────────────

/**
 * @description hashPassword then verifyPassword with the same password succeeds; salt/hash are non-empty hex distinct from plaintext.
 */
test("lt-password-roundtrip: hash then verify same password; salt/hash non-empty hex ≠ plaintext", async () => {
  const password = "secure-pass-ok";
  assert.ok(password.length >= 8);

  const { hash, salt } = await hashPassword(password);

  assert.equal(typeof hash, "string");
  assert.equal(typeof salt, "string");
  assert.ok(hash.length > 0, "hash non-empty");
  assert.ok(salt.length > 0, "salt non-empty");
  assert.match(hash, HEX_RE, "hash is hex");
  assert.match(salt, HEX_RE, "salt is hex");
  assert.notEqual(hash, password, "hash distinct from plaintext");
  assert.notEqual(salt, password, "salt distinct from plaintext");

  const ok = await verifyPassword(password, hash, salt);
  assert.equal(ok, true);
});

// ─── lt-password-wrong-rejects ─────────────────────────────────────────────

/**
 * @description verifyPassword with a different password returns false (never true).
 */
test("lt-password-wrong-rejects: verify with password B against hash of A returns false", async () => {
  const passwordA = "password-alpha";
  const passwordB = "password-beta";
  assert.ok(passwordA.length >= 8);
  assert.ok(passwordB.length >= 8);

  const { hash, salt } = await hashPassword(passwordA);
  const ok = await verifyPassword(passwordB, hash, salt);
  assert.equal(ok, false);
});

// ─── lt-session-mint-resolve ───────────────────────────────────────────────

/**
 * @description mintSession stores token_hash (SHA-256 hex of raw token) not raw token; expires_at is SQLite datetime; resolveSession returns user id.
 */
test("lt-session-mint-resolve: token_hash stored, expires_at SQLite shape, resolve returns user id", async () => {
  const db = openDb();
  const userId = seedUser(db, "user-mint");

  const rawToken = await mintSession(db, userId);
  assert.equal(typeof rawToken, "string");
  assert.ok(rawToken.length > 0, "raw token non-empty");

  const row = db
    .prepare(`SELECT user_id, token_hash, expires_at FROM sessions WHERE user_id = ?`)
    .get(userId);

  assert.ok(row, "sessions row exists");
  assert.equal(row.user_id, userId);
  assert.notEqual(row.token_hash, rawToken, "must not store raw token");
  assert.equal(row.token_hash, sha256Hex(rawToken), "token_hash is SHA-256 hex of raw token");
  assert.match(String(row.expires_at), SQLITE_DATETIME_RE, "expires_at SQLite datetime without T/Z");

  const resolved = await resolveSession(db, rawToken);
  assert.equal(resolved, userId);

  db.close();
});

// ─── lt-session-expired-rejects ────────────────────────────────────────────

/**
 * @description resolveSession on a session whose expires_at is in the past returns null.
 */
test("lt-session-expired-rejects: past expires_at yields null/unauthenticated", async () => {
  const db = openDb();
  const userId = seedUser(db, "user-expired");

  const rawToken = await mintSession(db, userId);
  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE token_hash = ?`,
  ).run(sha256Hex(rawToken));

  const resolved = await resolveSession(db, rawToken);
  assert.equal(resolved, null);

  db.close();
});

// ─── lt-session-logout-deletes ─────────────────────────────────────────────

/**
 * @description logoutSession deletes the sessions row; resolveSession on the same raw token returns null.
 */
test("lt-session-logout-deletes: logout removes row and resolve returns null", async () => {
  const db = openDb();
  const userId = seedUser(db, "user-logout");

  const rawToken = await mintSession(db, userId);
  assert.equal(await resolveSession(db, rawToken), userId);

  await logoutSession(db, rawToken);

  const row = db
    .prepare(`SELECT id FROM sessions WHERE token_hash = ?`)
    .get(sha256Hex(rawToken));
  assert.equal(row, undefined, "sessions row deleted");

  const resolved = await resolveSession(db, rawToken);
  assert.equal(resolved, null);

  db.close();
});

// ─── lt-cookie-path-root ───────────────────────────────────────────────────

/**
 * @description buildSessionCookie and clearSessionCookie both include Path=/ and HttpOnly; clear uses Max-Age=0.
 */
test("lt-cookie-path-root: Set-Cookie strings include Path=/ and HttpOnly; clear has Max-Age=0", () => {
  const token = "raw-session-token-for-cookie-test";
  const setCookie = buildSessionCookie(token);
  const clearCookie = clearSessionCookie();

  assert.equal(typeof setCookie, "string");
  assert.equal(typeof clearCookie, "string");

  assert.match(setCookie, /Path=\//, "buildSessionCookie Path=/");
  assert.match(setCookie, /HttpOnly/i, "buildSessionCookie HttpOnly");

  assert.match(clearCookie, /Path=\//, "clearSessionCookie Path=/");
  assert.match(clearCookie, /HttpOnly/i, "clearSessionCookie HttpOnly");
  assert.match(clearCookie, /Max-Age=0/i, "clearSessionCookie Max-Age=0");
});
