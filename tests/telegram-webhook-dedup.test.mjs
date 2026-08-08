/**
 * Locked telegram webhook dedup / DM pin / turn-context migration + claim contract.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Asserts 0007 tables + claimTelegramUpdateId once-semantics + FK reject orphans + DM pin helpers.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  clearDmActiveEmpresa,
  getDmActiveEmpresa,
  setDmPendingBoundary,
  upsertDmActiveEmpresa,
} from "../src/worker/services/telegram-dm-active-empresa.ts";
import { claimTelegramUpdateId } from "../src/worker/services/telegram-webhook-dedup.ts";

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

/**
 * @description Foreign key rows from pragma_foreign_key_list.
 * @param {DatabaseSync} db
 * @param {string} table
 */
function foreignKeys(db, table) {
  return db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table);
}

/**
 * @description FK group: multi-column FKs share the same id in pragma_foreign_key_list.
 * @param {ReturnType<typeof foreignKeys>} fks
 * @returns {Map<number, {table: string, from: string[], to: string[]}>}
 */
function groupForeignKeys(fks) {
  /** @type {Map<number, {table: string, from: string[], to: string[]}>} */
  const groups = new Map();
  for (const fk of fks) {
    let g = groups.get(fk.id);
    if (!g) {
      g = { table: fk.table, from: [], to: [] };
      groups.set(fk.id, g);
    }
    g.from[fk.seq] = fk.from;
    g.to[fk.seq] = fk.to;
  }
  return groups;
}

/**
 * @description True if some FK group matches parent table + from/to column sets.
 * @param {ReturnType<typeof foreignKeys>} fks
 * @param {string} parentTable
 * @param {string[]} fromCols
 * @param {string[]} toCols
 */
function hasFk(fks, parentTable, fromCols, toCols) {
  const groups = groupForeignKeys(fks);
  const fromWant = fromCols.join("\0");
  const toWant = toCols.join("\0");
  for (const g of groups.values()) {
    if (g.table !== parentTable) continue;
    if (g.from.join("\0") === fromWant && g.to.join("\0") === toWant) return true;
  }
  return false;
}

/**
 * @description Assert column is PRIMARY KEY (single-column).
 * @param {Map<string, ReturnType<typeof tableInfo>[number]>} cols
 * @param {string} name
 * @param {string} table
 */
function assertPk(cols, name, table) {
  const col = cols.get(name);
  assert.ok(col, `${table}.${name} must exist`);
  assert.equal(col.pk, true, `${table}.${name} must be PRIMARY KEY`);
  assert.equal(col.pkOrd, 1, `${table}.${name} must be sole PRIMARY KEY column`);
}

/**
 * @description Assert column is NOT NULL.
 * @param {Map<string, ReturnType<typeof tableInfo>[number]>} cols
 * @param {string} name
 * @param {string} table
 */
function assertNotNull(cols, name, table) {
  const col = cols.get(name);
  assert.ok(col, `${table}.${name} must exist`);
  assert.equal(col.notnull, true, `${table}.${name} must be NOT NULL`);
}

/**
 * @description Assert column is nullable (not NOT NULL).
 * @param {Map<string, ReturnType<typeof tableInfo>[number]>} cols
 * @param {string} name
 * @param {string} table
 */
function assertNullable(cols, name, table) {
  const col = cols.get(name);
  assert.ok(col, `${table}.${name} must exist`);
  assert.equal(col.notnull, false, `${table}.${name} must be nullable`);
}

/**
 * @description Assert column type is TEXT.
 * @param {Map<string, ReturnType<typeof tableInfo>[number]>} cols
 * @param {string} name
 * @param {string} table
 */
function assertText(cols, name, table) {
  const col = cols.get(name);
  assert.ok(col, `${table}.${name} must exist`);
  assert.equal(col.type, "TEXT", `${table}.${name} must be TEXT`);
}

/**
 * @description Seed a minimal users row (dummy hash/salt — FK parent only).
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-pin-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Pin User";
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, "hash", "salt");
  return { id, email, name };
}

/**
 * @description Seed a minimal empresas row (FK parent only).
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-pin-a";
  const nome = opts.nome ?? "Empresa A";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  return { id, nome };
}

// ─── lt-dedup-migration-schema ─────────────────────────────────────────────

/**
 * @description Full migration chain yields telegram_webhook_updates PK update_id and telegram_dm_active_empresa PK/FKs/pending_boundary.
 */
test("lt-dedup-migration-schema: webhook_updates PK update_id; dm_active_empresa PK user_id, NOT NULL empresa_id, pending_boundary DEFAULT 0, FKs", () => {
  const db = openDb();

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r) => r.name);
  assert.ok(
    tables.includes("telegram_webhook_updates"),
    "telegram_webhook_updates must exist after full migration chain including 0007",
  );
  assert.ok(
    tables.includes("telegram_dm_active_empresa"),
    "telegram_dm_active_empresa must exist after full migration chain including 0007",
  );

  const dedupCols = columnsByName(db, "telegram_webhook_updates");
  assertPk(dedupCols, "update_id", "telegram_webhook_updates");

  const pinCols = columnsByName(db, "telegram_dm_active_empresa");
  assertPk(pinCols, "user_id", "telegram_dm_active_empresa");
  assertNotNull(pinCols, "empresa_id", "telegram_dm_active_empresa");

  const pending = pinCols.get("pending_boundary");
  assert.ok(pending, "telegram_dm_active_empresa.pending_boundary must exist");
  assert.equal(
    pending.type,
    "INTEGER",
    "telegram_dm_active_empresa.pending_boundary must be INTEGER",
  );
  assert.equal(
    pending.notnull,
    true,
    "telegram_dm_active_empresa.pending_boundary must be NOT NULL",
  );
  assert.equal(
    String(pending.dflt_value),
    "0",
    "telegram_dm_active_empresa.pending_boundary must DEFAULT 0",
  );

  const pinFks = foreignKeys(db, "telegram_dm_active_empresa");
  assert.ok(
    hasFk(pinFks, "users", ["user_id"], ["id"]),
    "telegram_dm_active_empresa.user_id must FK REFERENCES users(id)",
  );
  assert.ok(
    hasFk(pinFks, "empresas", ["empresa_id"], ["id"]),
    "telegram_dm_active_empresa.empresa_id must FK REFERENCES empresas(id)",
  );

  db.close();
});

// ─── lt-turn-context-migration-schema ──────────────────────────────────────

/**
 * @description telegram_agent_turn_context has PK turn_token, required ciphertext+iv pair, nullable expert/boundary, FKs.
 */
test("lt-turn-context-migration-schema: PK turn_token; NOT NULL identity/key/message cols; nullable expert_id/dm_boundary_line; FKs", () => {
  const db = openDb();

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r) => r.name);
  assert.ok(
    tables.includes("telegram_agent_turn_context"),
    "telegram_agent_turn_context must exist after full migration chain",
  );

  const cols = columnsByName(db, "telegram_agent_turn_context");
  assertPk(cols, "turn_token", "telegram_agent_turn_context");

  for (const name of [
    "empresa_id",
    "actor_user_id",
    "surface",
    "provider",
    "api_key_ciphertext",
    "api_key_iv",
    "message",
    "expires_at",
  ]) {
    assertNotNull(cols, name, "telegram_agent_turn_context");
  }

  // bot_token must NOT be persisted in D1 — turn consumer uses env botToken
  assert.equal(
    cols.has("bot_token"),
    false,
    "telegram_agent_turn_context must not have bot_token column",
  );

  // ciphertext + iv both TEXT NOT NULL (mirror empresa_llm_settings encryptLlmApiKey pair — never ciphertext-only)
  assertText(cols, "api_key_ciphertext", "telegram_agent_turn_context");
  assertText(cols, "api_key_iv", "telegram_agent_turn_context");

  assertNullable(cols, "expert_id", "telegram_agent_turn_context");
  assertNullable(cols, "dm_boundary_line", "telegram_agent_turn_context");

  const fks = foreignKeys(db, "telegram_agent_turn_context");
  assert.ok(
    hasFk(fks, "empresas", ["empresa_id"], ["id"]),
    "telegram_agent_turn_context.empresa_id must FK REFERENCES empresas(id)",
  );
  assert.ok(
    hasFk(fks, "users", ["actor_user_id"], ["id"]),
    "telegram_agent_turn_context.actor_user_id must FK REFERENCES users(id)",
  );

  db.close();
});

// ─── lt-dedup-claim-once ───────────────────────────────────────────────────

/**
 * @description claimTelegramUpdateId is once-only: first claimed=true, second claimed=false, single row stored.
 */
test("lt-dedup-claim-once: claimTelegramUpdateId twice same id → first claimed=true, second false, count=1", async () => {
  const db = openDb();
  const updateId = "99";

  const first = await claimTelegramUpdateId(db, updateId);
  assert.equal(first.claimed, true, "first claim must return claimed=true");

  const second = await claimTelegramUpdateId(db, updateId);
  assert.equal(second.claimed, false, "second claim must return claimed=false");

  const row = db
    .prepare(
      `SELECT count(*) AS n FROM telegram_webhook_updates WHERE update_id = ?`,
    )
    .get(updateId);
  assert.equal(row.n, 1, "exactly one telegram_webhook_updates row for update_id");

  db.close();
});

// ─── lt-dm-pin-fk-rejects-orphan ───────────────────────────────────────────

/**
 * @description INSERT telegram_dm_active_empresa with orphan user_id/empresa_id fails FOREIGN KEY.
 */
test("lt-dm-pin-fk-rejects-orphan: INSERT telegram_dm_active_empresa orphan → FK fail", () => {
  const db = openDb();

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO telegram_dm_active_empresa (user_id, empresa_id)
         VALUES (?, ?)`,
      ).run("orphan-user", "orphan-empresa");
    },
    /FOREIGN KEY/i,
    "INSERT telegram_dm_active_empresa with orphan user_id/empresa_id must fail FOREIGN KEY",
  );

  const count = db
    .prepare(`SELECT count(*) AS n FROM telegram_dm_active_empresa`)
    .get();
  assert.equal(count.n, 0, "no dm pin row must be stored after FK failure");

  db.close();
});

// ─── lt-turn-context-fk-rejects-orphan ─────────────────────────────────────

/**
 * @description INSERT telegram_agent_turn_context with orphan empresa/actor and all NOT NULL cols fails FOREIGN KEY.
 */
test("lt-turn-context-fk-rejects-orphan: INSERT telegram_agent_turn_context orphan empresa/actor → FK fail", () => {
  const db = openDb();

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO telegram_agent_turn_context
          (turn_token, empresa_id, actor_user_id, surface, provider,
           api_key_ciphertext, api_key_iv, message, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "turn-orphan-1",
        "orphan-empresa",
        "orphan-actor",
        "dm",
        "openai",
        "cipher-test",
        "iv-test",
        "hello",
        "2026-08-05T12:02:00.000Z",
      );
    },
    /FOREIGN KEY/i,
    "INSERT telegram_agent_turn_context with orphan empresa_id/actor_user_id must fail FOREIGN KEY",
  );

  const count = db
    .prepare(`SELECT count(*) AS n FROM telegram_agent_turn_context`)
    .get();
  assert.equal(count.n, 0, "no turn_context row must be stored after FK failure");

  db.close();
});

// ─── lt-dm-pin-helpers-pending-boundary ────────────────────────────────────

/**
 * @description upsert/set pending_boundary/get/clear DM pin helpers round-trip empresa_id and pending_boundary 0|1.
 */
test("lt-dm-pin-helpers-pending-boundary: upsert → set(1) → get; set(0) → get; clear → null", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-pin-helpers" });
  const empresaA = seedEmpresa(db, { id: "emp-pin-a", nome: "Empresa A" });

  await upsertDmActiveEmpresa(db, user.id, empresaA.id);
  await setDmPendingBoundary(db, user.id, 1);

  const afterSet1 = await getDmActiveEmpresa(db, user.id);
  assert.ok(afterSet1, "getDmActiveEmpresa must return a row after upsert");
  assert.equal(
    afterSet1.empresa_id,
    empresaA.id,
    "row.empresa_id must be empresa A after upsert",
  );
  assert.equal(
    afterSet1.pending_boundary,
    1,
    "row.pending_boundary must be 1 after setDmPendingBoundary(1)",
  );

  await setDmPendingBoundary(db, user.id, 0);
  const afterSet0 = await getDmActiveEmpresa(db, user.id);
  assert.ok(afterSet0, "getDmActiveEmpresa must still return a row after set(0)");
  assert.equal(
    afterSet0.pending_boundary,
    0,
    "row.pending_boundary must be 0 after setDmPendingBoundary(0)",
  );
  assert.equal(
    afterSet0.empresa_id,
    empresaA.id,
    "row.empresa_id must remain A after setDmPendingBoundary(0)",
  );

  await clearDmActiveEmpresa(db, user.id);
  const afterClear = await getDmActiveEmpresa(db, user.id);
  assert.equal(
    afterClear ?? null,
    null,
    "getDmActiveEmpresa must return null/absent after clearDmActiveEmpresa",
  );

  db.close();
});
