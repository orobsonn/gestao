/**
 * Locked resolveTelegramTopicContext contract — map-only chat/thread → tenant context.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Async helper; String-canonical chat/thread bind params.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveTelegramTopicContext } from "../src/worker/services/resolve-telegram-topic-context.ts";

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
 * @description Seed a live expert under empresa.
 * @param {DatabaseSync} db
 * @param {string} id
 * @param {string} empresaId
 */
function seedExpert(db, id, empresaId) {
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, empresaId, `Expert ${id}`);
  return id;
}

/**
 * @description Seed empresa_telegram_chats + expert_telegram_topics for a live pair.
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
  ).run(
    opts.expertId,
    opts.empresaId,
    opts.chatId,
    opts.messageThreadId,
  );
}

// ─── lt-resolve-happy-path ─────────────────────────────────────────────────

/**
 * @description Live empresa+expert maps for chat '-1001' thread '55' resolve to seeded ids.
 */
test("lt-resolve-happy-path: chat -1001 thread 55 → {empresa_id, expert_id}", async () => {
  const db = openDb();
  const empresaId = seedEmpresa(db, "emp-happy");
  const expertId = seedExpert(db, "exp-happy", empresaId);
  seedTopicMap(db, {
    empresaId,
    expertId,
    chatId: "-1001",
    messageThreadId: "55",
  });

  const result = await resolveTelegramTopicContext(db, "-1001", "55");

  assert.deepEqual(result, {
    empresa_id: empresaId,
    expert_id: expertId,
  });

  db.close();
});

// ─── lt-resolve-unknown-thread-null ────────────────────────────────────────

/**
 * @description Unknown message_thread_id returns null when only thread 55 is mapped.
 */
test("lt-resolve-unknown-thread-null: thread 999 with maps only for 55 → null", async () => {
  const db = openDb();
  const empresaId = seedEmpresa(db, "emp-unknown");
  const expertId = seedExpert(db, "exp-unknown", empresaId);
  seedTopicMap(db, {
    empresaId,
    expertId,
    chatId: "-1001",
    messageThreadId: "55",
  });

  const result = await resolveTelegramTopicContext(db, "-1001", "999");

  assert.equal(result, null);

  db.close();
});

// ─── lt-resolve-soft-deleted-expert-null ───────────────────────────────────

/**
 * @description Topic map with soft-deleted expert returns null.
 */
test("lt-resolve-soft-deleted-expert-null: experts.deleted_at set → null", async () => {
  const db = openDb();
  const empresaId = seedEmpresa(db, "emp-soft-exp");
  const expertId = seedExpert(db, "exp-soft", empresaId);
  seedTopicMap(db, {
    empresaId,
    expertId,
    chatId: "-1001",
    messageThreadId: "55",
  });
  db.prepare(
    `UPDATE experts SET deleted_at = datetime('now') WHERE id = ?`,
  ).run(expertId);

  const result = await resolveTelegramTopicContext(db, "-1001", "55");

  assert.equal(result, null);

  db.close();
});

// ─── lt-resolve-soft-deleted-empresa-null ──────────────────────────────────

/**
 * @description Topic map with soft-deleted empresa returns null.
 */
test("lt-resolve-soft-deleted-empresa-null: empresas.deleted_at set → null", async () => {
  const db = openDb();
  const empresaId = seedEmpresa(db, "emp-soft-emp");
  const expertId = seedExpert(db, "exp-soft-emp", empresaId);
  seedTopicMap(db, {
    empresaId,
    expertId,
    chatId: "-1001",
    messageThreadId: "55",
  });
  db.prepare(
    `UPDATE empresas SET deleted_at = datetime('now') WHERE id = ?`,
  ).run(empresaId);

  const result = await resolveTelegramTopicContext(db, "-1001", "55");

  assert.equal(result, null);

  db.close();
});

// ─── lt-resolve-join-requires-matching-chat ─────────────────────────────────

/**
 * @description Join on empresa_id AND chat_id — chat_id drift between topic and empresa chat yields null.
 */
test("lt-resolve-join-requires-matching-chat: topic chat_id ≠ empresa chat_id → null", async () => {
  const db = openDb();
  const empresaId = seedEmpresa(db, "emp-drift");
  const expertId = seedExpert(db, "exp-drift", empresaId);

  // Seed matching rows first (FK ON), then drift topic.chat_id with FK briefly OFF.
  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id) VALUES (?, ?)`,
  ).run(empresaId, "-1001");
  db.prepare(
    `INSERT INTO expert_telegram_topics
      (expert_id, empresa_id, chat_id, message_thread_id)
     VALUES (?, ?, ?, ?)`,
  ).run(expertId, empresaId, "-1001", "55");

  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `UPDATE expert_telegram_topics SET chat_id = ? WHERE expert_id = ?`,
  ).run("-9999", expertId);
  db.exec("PRAGMA foreign_keys = ON");

  // Resolve with the empresa's real chat + thread — join must require matching chat_id on both sides.
  const result = await resolveTelegramTopicContext(db, "-1001", "55");

  assert.equal(result, null);

  // Also resolve with the drifted topic chat_id — still null (no matching empresa_telegram_chats).
  const resultDriftedChat = await resolveTelegramTopicContext(
    db,
    "-9999",
    "55",
  );
  assert.equal(resultDriftedChat, null);

  db.close();
});

// ─── lt-resolve-topic-async-canonical ──────────────────────────────────────

/**
 * @description Numeric chatId/threadId resolve to the same empresa_id and expert_id as string-form call.
 */
test("lt-resolve-topic-async-canonical: number and string chat/thread yield same context", async () => {
  const db = openDb();
  const empresaId = seedEmpresa(db, "emp-canonical");
  const expertId = seedExpert(db, "exp-canonical", empresaId);
  seedTopicMap(db, {
    empresaId,
    expertId,
    chatId: "-1001",
    messageThreadId: "7",
  });

  const fromNumbers = await resolveTelegramTopicContext(db, -1001, 7);
  const fromStrings = await resolveTelegramTopicContext(db, "-1001", "7");

  assert.deepEqual(fromNumbers, {
    empresa_id: empresaId,
    expert_id: expertId,
  });
  assert.deepEqual(fromStrings, {
    empresa_id: empresaId,
    expert_id: expertId,
  });
  assert.deepEqual(fromNumbers, fromStrings);

  db.close();
});

