/**
 * Locked telegram agent reply send-guard migration + claim contract.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Asserts 0010 telegram_agent_reply_sends PK + claimAgentReplySend once-semantics + empty-key reject.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimAgentReplySend } from "../src/worker/services/agent-reply-send-guard.ts";

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
 * @description Column metadata from pragma_table_info.
 * @param {DatabaseSync} db
 * @param {string} table
 */
function tableInfo(db, table) {
  return db
    .prepare(`SELECT * FROM pragma_table_info(?)`)
    .all(table)
    .map((r) => ({
      name: r.name,
      type: String(r.type ?? "").toUpperCase(),
      notnull: r.notnull === 1,
      dflt_value: r.dflt_value,
      pk: r.pk > 0,
      pkOrd: r.pk,
    }));
}

/**
 * @description Map column name → tableInfo row.
 * @param {DatabaseSync} db
 * @param {string} table
 */
function columnsByName(db, table) {
  /** @type {Map<string, ReturnType<typeof tableInfo>[number]>} */
  const map = new Map();
  for (const col of tableInfo(db, table)) {
    map.set(col.name, col);
  }
  return map;
}

// ─── lt-flue2-reply-guard-migration ────────────────────────────────────────

/**
 * @description Full migration chain including 0010 yields telegram_agent_reply_sends with PK answered_by_submission_id.
 */
test("lt-flue2-reply-guard-migration: migrations run without error; telegram_agent_reply_sends.answered_by_submission_id is PRIMARY KEY", () => {
  const db = openDb();

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r) => r.name);
  assert.ok(
    tables.includes("telegram_agent_reply_sends"),
    "telegram_agent_reply_sends must exist after full migration chain including 0010",
  );

  const cols = columnsByName(db, "telegram_agent_reply_sends");
  const col = cols.get("answered_by_submission_id");
  assert.ok(col, "telegram_agent_reply_sends.answered_by_submission_id must exist");
  assert.equal(
    col.pk,
    true,
    "telegram_agent_reply_sends.answered_by_submission_id must be PRIMARY KEY (pk flag)",
  );

  db.close();
});

// ─── lt-flue2-reply-guard-claims-once ──────────────────────────────────────

/**
 * @description claimAgentReplySend is once-only: first claimed=true, second claimed=false, single row stored.
 */
test("lt-flue2-reply-guard-claims-once: claimAgentReplySend(db, 'sub_A') twice → first claimed=true, second false, count=1", async () => {
  const db = openDb();

  const first = await claimAgentReplySend(db, "sub_A");
  assert.equal(first.claimed, true, "first claim must return claimed=true");

  const second = await claimAgentReplySend(db, "sub_A");
  assert.equal(second.claimed, false, "second claim must return claimed=false");

  const row = db
    .prepare(
      `SELECT count(*) AS n FROM telegram_agent_reply_sends WHERE answered_by_submission_id = ?`,
    )
    .get("sub_A");
  assert.equal(row.n, 1, "exactly one telegram_agent_reply_sends row for answered_by_submission_id");

  db.close();
});

// ─── lt-flue2-reply-guard-distinct-answers-both-pass ───────────────────────

/**
 * @description Distinct answered_by_submission_id values each claim independently; the guard suppresses only genuine repeats.
 */
test("lt-flue2-reply-guard-distinct-answers-both-pass: claimAgentReplySend for 'sub_A' and 'sub_B' → both claimed=true, two rows", async () => {
  const db = openDb();

  const a = await claimAgentReplySend(db, "sub_A");
  assert.equal(a.claimed, true, "claim for sub_A must return claimed=true");

  const b = await claimAgentReplySend(db, "sub_B");
  assert.equal(b.claimed, true, "claim for sub_B (distinct id) must return claimed=true");

  const row = db.prepare(`SELECT count(*) AS n FROM telegram_agent_reply_sends`).get();
  assert.equal(row.n, 2, "two distinct telegram_agent_reply_sends rows must exist");

  db.close();
});

// ─── lt-flue2-reply-guard-rejects-empty-key ────────────────────────────────

/**
 * @description claimAgentReplySend rejects undefined/null/'' rather than coercing to the literal string 'undefined',
 * which would otherwise silently claim on behalf of every future solo (non-coalesced) reply and mute the bot.
 */
test("lt-flue2-reply-guard-rejects-empty-key: claimAgentReplySend(db, k) for k = undefined | null | '' each rejects; no row stored, none literal 'undefined'", async () => {
  const db = openDb();

  await assert.rejects(
    async () => claimAgentReplySend(db, undefined),
    "claimAgentReplySend(db, undefined) must reject, not resolve",
  );
  await assert.rejects(
    async () => claimAgentReplySend(db, null),
    "claimAgentReplySend(db, null) must reject, not resolve",
  );
  await assert.rejects(
    async () => claimAgentReplySend(db, ""),
    "claimAgentReplySend(db, '') must reject, not resolve",
  );

  const count = db.prepare(`SELECT COUNT(*) AS n FROM telegram_agent_reply_sends`).get();
  assert.equal(count.n, 0, "no row must be stored after all three rejected claims");

  const literalUndefined = db
    .prepare(
      `SELECT count(*) AS n FROM telegram_agent_reply_sends WHERE answered_by_submission_id = 'undefined'`,
    )
    .get();
  assert.equal(
    literalUndefined.n,
    0,
    "no row's answered_by_submission_id must be the literal string 'undefined'",
  );

  db.close();
});
