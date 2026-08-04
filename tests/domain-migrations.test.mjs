/**
 * Locked migration-chain contract — full migrations/ apply + campanha optional columns.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
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

// ─── lt-migration-chain-applies ────────────────────────────────────────────

test("lt-migration-chain-applies: full chain applies; sessions.active_empresa_id exists", () => {
  let db;
  assert.doesNotThrow(() => {
    db = openDb();
  });

  const fkOn = db.prepare("PRAGMA foreign_keys").get();
  assert.equal(
    fkOn.foreign_keys,
    1,
    "PRAGMA foreign_keys must be ON (1) after openDb",
  );

  const cols = tableInfo(db, "sessions");
  const names = new Set(cols.map((c) => c.name));
  assert.ok(
    names.has("active_empresa_id"),
    "pragma_table_info('sessions') must include active_empresa_id",
  );

  // Composite FK: expert belongs to A; campanha cannot claim empresa B with that expert_id
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-a",
    "Empresa A",
  );
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-b",
    "Empresa B",
  );
  db.prepare(`INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`).run(
    "ex-a",
    "emp-a",
    "Expert A",
  );

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("camp-x", "emp-b", "ex-a", "Cross-tenant", "gratuito");
    },
    /FOREIGN KEY/i,
    "composite FK must reject campanha with expert_id from A and empresa_id=B",
  );

  db.close();
});

// ─── lt-campanha-optional-columns ──────────────────────────────────────────

test("lt-campanha-optional-columns: data_inicio, data_fim, notas with NOT NULL default ''", () => {
  const db = openDb();

  const cols = tableInfo(db, "campanhas");
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

  assert.ok(byName.data_inicio, "campanhas.data_inicio exists");
  assert.ok(byName.data_fim, "campanhas.data_fim exists");
  assert.ok(byName.notas, "campanhas.notas exists");

  assert.equal(byName.notas.notnull, true, "campanhas.notas is NOT NULL");
  assert.match(
    String(byName.notas.dflt_value ?? ""),
    /''|""/,
    "campanhas.notas default is ''",
  );

  db.close();
});

// ─── lt-campanha-optional-insert-roundtrip ─────────────────────────────────

test("lt-campanha-optional-insert-roundtrip: optional fields persist exactly", () => {
  const db = openDb();

  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-1",
    "Empresa 1",
  );
  db.prepare(`INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`).run(
    "ex-1",
    "emp-1",
    "Expert 1",
  );

  db.prepare(
    `INSERT INTO campanhas
      (id, empresa_id, expert_id, nome, tipo, data_inicio, data_fim, notas)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "camp-1",
    "emp-1",
    "ex-1",
    "Campanha 1",
    "gratuito",
    "2026-01-01",
    "2026-02-01",
    "hello",
  );

  const row = db
    .prepare(
      `SELECT data_inicio, data_fim, notas FROM campanhas WHERE id = ?`,
    )
    .get("camp-1");

  assert.equal(row.data_inicio, "2026-01-01");
  assert.equal(row.data_fim, "2026-02-01");
  assert.equal(row.notas, "hello");

  db.close();
});
