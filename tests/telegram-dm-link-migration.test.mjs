/**
 * Locked telegram DM link migration contract — full migrations/ chain + UNIQUE constraints.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Asserts telegram_link_codes and user_telegram_links schema (user-scoped, no empresa_id).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

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
 * @description Column names set from pragma_table_info.
 * @param {DatabaseSync} db
 * @param {string} table
 * @returns {Set<string>}
 */
function columnNames(db, table) {
  return new Set(
    db
      .prepare(`SELECT * FROM pragma_table_info(?)`)
      .all(table)
      .map((r) => r.name),
  );
}

/**
 * @description Seed a minimal users row for FK targets.
 * @param {DatabaseSync} db
 * @param {string} id
 */
function seedUser(db, id) {
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `${id}@example.com`, `User ${id}`, "hash", "salt");
  return id;
}

// ─── lt-mig-chain-tables ───────────────────────────────────────────────────

/**
 * @description Full migration chain yields telegram_link_codes and user_telegram_links columns without empresa_id.
 */
test("lt-mig-chain-tables: telegram_link_codes and user_telegram_links columns; no empresa_id", () => {
  const db = openDb();

  const codesCols = columnNames(db, "telegram_link_codes");
  for (const col of [
    "id",
    "user_id",
    "code_hash",
    "expires_at",
    "used_at",
    "created_at",
  ]) {
    assert.ok(
      codesCols.has(col),
      `pragma_table_info('telegram_link_codes') must include ${col}`,
    );
  }
  assert.equal(
    codesCols.has("empresa_id"),
    false,
    "telegram_link_codes must not have empresa_id",
  );

  const linksCols = columnNames(db, "user_telegram_links");
  for (const col of ["user_id", "telegram_user_id", "linked_at"]) {
    assert.ok(
      linksCols.has(col),
      `pragma_table_info('user_telegram_links') must include ${col}`,
    );
  }
  assert.equal(
    linksCols.has("empresa_id"),
    false,
    "user_telegram_links must not have empresa_id",
  );

  db.close();
});

// ─── lt-mig-code-hash-unique ───────────────────────────────────────────────

/**
 * @description telegram_link_codes.code_hash is UNIQUE — duplicate hash insert fails.
 */
test("lt-mig-code-hash-unique: second telegram_link_codes row with same code_hash fails UNIQUE", () => {
  const db = openDb();

  const userId = seedUser(db, "user-code-hash");
  const codeHash = "a".repeat(64);
  const now = "2026-08-05T12:00:00.000Z";
  const expires = "2026-08-05T12:15:00.000Z";

  db.prepare(
    `INSERT INTO telegram_link_codes (id, user_id, code_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("code-1", userId, codeHash, expires, null, now);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO telegram_link_codes (id, user_id, code_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("code-2", userId, codeHash, expires, null, now);
    },
    /UNIQUE/i,
    "second INSERT with same code_hash must fail UNIQUE",
  );

  db.close();
});

// ─── lt-mig-telegram-user-unique ───────────────────────────────────────────

/**
 * @description user_telegram_links.telegram_user_id is UNIQUE across users — cannot bind T to two accounts.
 */
test("lt-mig-telegram-user-unique: same telegram_user_id on two users fails UNIQUE", () => {
  const db = openDb();

  const userA = seedUser(db, "user-A");
  const userB = seedUser(db, "user-B");
  const telegramUserId = "111";
  const linkedAt = "2026-08-05T12:00:00.000Z";

  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(userA, telegramUserId, linkedAt);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
         VALUES (?, ?, ?)`,
      ).run(userB, telegramUserId, linkedAt);
    },
    /UNIQUE/i,
    "INSERT binding same telegram_user_id to another user must fail UNIQUE",
  );

  db.close();
});

// ─── lt-mig-links-user-pk ──────────────────────────────────────────────────

/**
 * @description user_telegram_links.user_id is PRIMARY KEY / UNIQUE — one telegram link per user.
 */
test("lt-mig-links-user-pk: second user_telegram_links row for same user_id fails PRIMARY KEY/UNIQUE", () => {
  const db = openDb();

  const userA = seedUser(db, "user-A");
  const linkedAt = "2026-08-05T12:00:00.000Z";

  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(userA, "T1", linkedAt);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
         VALUES (?, ?, ?)`,
      ).run(userA, "T2", linkedAt);
    },
    /UNIQUE|PRIMARY KEY/i,
    "second INSERT for same user_id with different telegram_user_id must fail PRIMARY KEY / UNIQUE",
  );

  db.close();
});
