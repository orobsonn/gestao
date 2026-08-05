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

// ─── lt-llm-settings-table-exists ──────────────────────────────────────────

/**
 * @description empresa_llm_settings columns after full lexical migration chain.
 */
test("lt-llm-settings-table-exists: pragma_table_info includes required columns", () => {
  const db = openDb();

  const cols = tableInfo(db, "empresa_llm_settings");
  const names = new Set(cols.map((c) => c.name));

  for (const col of [
    "empresa_id",
    "provider",
    "api_key_ciphertext",
    "api_key_iv",
    "status",
    "validated_at",
    "last_error",
  ]) {
    assert.ok(
      names.has(col),
      `pragma_table_info('empresa_llm_settings') must include ${col}`,
    );
  }

  db.close();
});

// ─── lt-llm-settings-pk-one-row ────────────────────────────────────────────

/**
 * @description One row per empresa — second INSERT with same empresa_id fails PK/UNIQUE.
 */
test("lt-llm-settings-pk-one-row: second INSERT same empresa_id fails PRIMARY KEY/UNIQUE", () => {
  const db = openDb();

  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-1",
    "Empresa 1",
  );

  db.prepare(
    `INSERT INTO empresa_llm_settings (empresa_id, status) VALUES (?, ?)`,
  ).run("emp-1", "unvalidated");

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, status) VALUES (?, ?)`,
      ).run("emp-1", "unvalidated");
    },
    /UNIQUE|PRIMARY KEY/i,
    "second INSERT with same empresa_id must fail PRIMARY KEY / UNIQUE",
  );

  db.close();
});

// ─── lt-llm-settings-fk-empresa ────────────────────────────────────────────

/**
 * @description empresa_llm_settings.empresa_id FK rejects missing empresas row.
 */
test("lt-llm-settings-fk-empresa: INSERT with missing empresa fails FOREIGN KEY", () => {
  const db = openDb();

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, status) VALUES (?, ?)`,
      ).run("emp-missing", "unvalidated");
    },
    /FOREIGN KEY/i,
    "INSERT empresa_llm_settings with empresa_id=emp-missing must fail FOREIGN KEY",
  );

  db.close();
});

// ─── lt-llm-settings-status-check ──────────────────────────────────────────

/**
 * @description status CHECK accepts unvalidated|valid|invalid; rejects bogus and none.
 */
test("lt-llm-settings-status-check: CHECK rejects bogus/none; accepts unvalidated|valid|invalid", () => {
  const db = openDb();

  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-1",
    "Empresa 1",
  );

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, status) VALUES (?, ?)`,
      ).run("emp-1", "bogus");
    },
    /CHECK|constraint/i,
    "status='bogus' must fail CHECK",
  );

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, status) VALUES (?, ?)`,
      ).run("emp-1", "none");
    },
    /CHECK|constraint/i,
    "status='none' is Metadata-only and must fail DB CHECK",
  );

  for (const status of ["unvalidated", "valid", "invalid"]) {
    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, status) VALUES (?, ?)`,
      ).run("emp-1", status);
    }, `status='${status}' must be accepted`);
    db.prepare(`DELETE FROM empresa_llm_settings WHERE empresa_id = ?`).run(
      "emp-1",
    );
  }

  db.close();
});

// ─── lt-llm-settings-provider-check ────────────────────────────────────────

/**
 * @description provider CHECK accepts openai|anthropic and NULL; rejects gemini.
 */
test("lt-llm-settings-provider-check: gemini rejected; NULL/openai/anthropic accepted", () => {
  const db = openDb();

  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-1",
    "Empresa 1",
  );

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, provider, status)
         VALUES (?, ?, ?)`,
      ).run("emp-1", "gemini", "unvalidated");
    },
    /CHECK|constraint/i,
    "provider='gemini' must fail CHECK",
  );

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO empresa_llm_settings (empresa_id, provider, status)
       VALUES (?, ?, ?)`,
    ).run("emp-1", null, "unvalidated");
  }, "provider NULL must be accepted");
  db.prepare(`DELETE FROM empresa_llm_settings WHERE empresa_id = ?`).run(
    "emp-1",
  );

  for (const provider of ["openai", "anthropic"]) {
    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO empresa_llm_settings (empresa_id, provider, status)
         VALUES (?, ?, ?)`,
      ).run("emp-1", provider, "unvalidated");
    }, `provider='${provider}' must be accepted`);
    db.prepare(`DELETE FROM empresa_llm_settings WHERE empresa_id = ?`).run(
      "emp-1",
    );
  }

  db.close();
});

// ─── lt-llm-settings-nullable-key-columns ──────────────────────────────────

/**
 * @description Nullable key/provider/error columns accept NULL with status unvalidated.
 */
test("lt-llm-settings-nullable-key-columns: NULL ciphertext/iv/validated_at/last_error/provider succeeds", () => {
  const db = openDb();

  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    "emp-1",
    "Empresa 1",
  );

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO empresa_llm_settings
        (empresa_id, provider, api_key_ciphertext, api_key_iv, status, validated_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("emp-1", null, null, null, "unvalidated", null, null);
  }, "INSERT with all nullable columns NULL + status='unvalidated' must succeed");

  const row = db
    .prepare(
      `SELECT provider, api_key_ciphertext, api_key_iv, status, validated_at, last_error
       FROM empresa_llm_settings WHERE empresa_id = ?`,
    )
    .get("emp-1");

  assert.equal(row.provider, null);
  assert.equal(row.api_key_ciphertext, null);
  assert.equal(row.api_key_iv, null);
  assert.equal(row.status, "unvalidated");
  assert.equal(row.validated_at, null);
  assert.equal(row.last_error, null);

  db.close();
});
