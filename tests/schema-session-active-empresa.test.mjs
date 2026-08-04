/**
 * Locked schema contract: sessions.active_empresa_id nullable FK → empresas(id).
 * Applies migrations/0001_init.sql against ephemeral SQLite (foreign_keys=ON).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(__dirname, "../migrations/0001_init.sql");

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
      type: r.type,
      notnull: r.notnull === 1,
      dflt_value: r.dflt_value,
      pk: r.pk === 1,
    }));
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
 * @description Seed a minimal user row.
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
 * @description Seed empresa.
 * @param {DatabaseSync} db
 * @param {string} id
 */
function seedEmpresa(db, id = "emp-a") {
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    id,
    `Empresa ${id}`,
  );
  return id;
}

// ─── lt-sessions-active-empresa-column ─────────────────────────────────────

test("lt-sessions-active-empresa-column: sessions.active_empresa_id nullable TEXT FK to empresas(id)", () => {
  const db = openDb();

  const cols = tableInfo(db, "sessions");
  const active = cols.find((c) => c.name === "active_empresa_id");
  assert.ok(active, "sessions.active_empresa_id exists");
  assert.match(String(active.type), /TEXT/i, "active_empresa_id type TEXT");
  assert.equal(active.notnull, false, "active_empresa_id is nullable");

  const fks = foreignKeys(db, "sessions");
  assert.ok(
    hasFk(fks, "empresas", ["active_empresa_id"], ["id"]),
    "sessions.active_empresa_id → empresas(id)",
  );

  db.close();
});

// ─── lt-sessions-active-empresa-fk-roundtrip ───────────────────────────────

test("lt-sessions-active-empresa-fk-roundtrip: NULL and valid empresa ok; unknown empresa FK error", () => {
  const db = openDb();

  const userId = seedUser(db, "user-sess");
  const empresaId = seedEmpresa(db, "emp-sess");

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, active_empresa_id)
       VALUES (?, ?, ?, datetime('now', '+1 day'), NULL)`,
    ).run("sess-null", userId, "token-hash-null");
  }, "INSERT session with active_empresa_id NULL succeeds");

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, active_empresa_id)
       VALUES (?, ?, ?, datetime('now', '+1 day'), ?)`,
    ).run("sess-valid", userId, "token-hash-valid", empresaId);
  }, "INSERT session with valid empresa id succeeds");

  const row = db
    .prepare(`SELECT active_empresa_id FROM sessions WHERE id = ?`)
    .get("sess-valid");
  assert.equal(row.active_empresa_id, empresaId);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, active_empresa_id)
         VALUES (?, ?, ?, datetime('now', '+1 day'), ?)`,
      ).run("sess-bad", userId, "token-hash-bad", "empresa-unknown");
    },
    /FOREIGN KEY|foreign key/i,
    "INSERT with unknown empresa id raises foreign key constraint error",
  );

  db.close();
});
