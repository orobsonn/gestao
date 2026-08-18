/**
 * Locked forward model migration contract.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, migrations sorted lexically.
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
 * @description Returns every SQL migration in lexical filename order.
 * @returns {string[]}
 */
function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * @description Applies migration files to an open database in their supplied order.
 * @param {DatabaseSync} db
 * @param {string[]} files
 */
function applyMigrations(db, files) {
  for (const name of files) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"));
  }
}

/**
 * @description Returns one column's SQLite table metadata.
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string} column
 */
function columnInfo(db, table, column) {
  return db
    .prepare(
      'SELECT name, type, "notnull" AS is_not_null FROM pragma_table_info(?) WHERE name = ?',
    )
    .get(table, column);
}

/**
 * @description Forward migrations add nullable TEXT model columns and preserve legacy settings as null.
 */
test("lt-forward-model-migrations: 0008 and 0009 add nullable model_id columns and preserve legacy settings", () => {
  const db = new DatabaseSync(":memory:");

  try {
    db.exec("PRAGMA foreign_keys = ON");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);

    const files = migrationFiles();
    const through0007 = files.filter((name) => name <= "0007_\uffff");
    const forwardModelMigrations = [
      "0008_empresa_llm_model.sql",
      "0009_telegram_turn_model.sql",
    ];

    applyMigrations(db, through0007);

    db.prepare("INSERT INTO empresas (id, nome) VALUES (?, ?)").run(
      "emp-existing",
      "Empresa Existing",
    );
    db.prepare(
      `INSERT INTO empresa_llm_settings (empresa_id, provider, status)
       VALUES (?, ?, ?)`,
    ).run("emp-existing", "openai", "unvalidated");

    applyMigrations(db, forwardModelMigrations);

    for (const table of [
      "empresa_llm_settings",
      "telegram_agent_turn_context",
    ]) {
      const column = columnInfo(db, table, "model_id");
      assert.ok(column, `${table}.model_id must exist`);
      assert.equal(column.type.toUpperCase(), "TEXT", `${table}.model_id is TEXT`);
      assert.equal(column.is_not_null, 0, `${table}.model_id is nullable`);
    }

    const existing = db
      .prepare(
        "SELECT model_id FROM empresa_llm_settings WHERE empresa_id = ?",
      )
      .get("emp-existing");
    assert.equal(existing.model_id, null);
  } finally {
    db.close();
  }
});
