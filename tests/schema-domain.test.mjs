/**
 * Locked schema-domain contract tests for multi-tenant domain migration.
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
 * @description Column names set for a table.
 * @param {DatabaseSync} db
 * @param {string} table
 */
function columnNames(db, table) {
  return new Set(tableInfo(db, table).map((c) => c.name));
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
 * @description Unique indexes (and PK) covering exact column sets via index_list + index_info.
 * @param {DatabaseSync} db
 * @param {string} table
 * @returns {string[][]}
 */
function uniqueColumnSets(db, table) {
  const indexes = db.prepare(`SELECT * FROM pragma_index_list(?)`).all(table);
  const sets = [];
  for (const idx of indexes) {
    if (idx.unique !== 1) continue;
    const cols = db
      .prepare(`SELECT * FROM pragma_index_info(?)`)
      .all(idx.name)
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    sets.push(cols);
  }
  // Also surface PRIMARY KEY multi-column via table_info if composite PK
  const pkCols = tableInfo(db, table)
    .filter((c) => c.pk)
    .sort((a, b) => {
      const ra = db
        .prepare(`SELECT pk FROM pragma_table_info(?) WHERE name = ?`)
        .get(table, a.name);
      const rb = db
        .prepare(`SELECT pk FROM pragma_table_info(?) WHERE name = ?`)
        .get(table, b.name);
      return (ra?.pk ?? 0) - (rb?.pk ?? 0);
    })
    .map((c) => c.name);
  if (pkCols.length > 1) sets.push(pkCols);
  return sets;
}

/**
 * @description Whether a unique index/constraint covers exactly the given columns (order-insensitive).
 * @param {string[][]} sets
 * @param {string[]} cols
 */
function hasUniqueOn(sets, cols) {
  const want = [...cols].sort().join("\0");
  return sets.some((s) => [...s].sort().join("\0") === want);
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
    // seq orders columns within the FK
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
  db.prepare(
    `INSERT INTO empresas (id, nome) VALUES (?, ?)`,
  ).run(id, `Empresa ${id}`);
  return id;
}

/**
 * @description Seed expert under empresa.
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
 * @description Seed campanha under expert+empresa.
 * @param {DatabaseSync} db
 * @param {string} id
 * @param {string} expertId
 * @param {string} empresaId
 * @param {{tipo?: string, status?: string}} [opts]
 */
function seedCampanha(db, id, expertId, empresaId, opts = {}) {
  const tipo = opts.tipo ?? "gratuito";
  const status = opts.status ?? "aberta";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, empresaId, expertId, `Campanha ${id}`, tipo, status);
  return id;
}

/**
 * @description Seed tarefa under campanha+empresa with required created_by.
 * @param {DatabaseSync} db
 * @param {object} row
 */
function seedTarefa(db, row) {
  const {
    id,
    campanhaId,
    empresaId,
    createdBy,
    titulo = `Tarefa ${row.id}`,
    notas = "",
    status,
    prazo = null,
    donoId = null,
  } = row;
  if (status !== undefined) {
    db.prepare(
      `INSERT INTO tarefas
        (id, empresa_id, campanha_id, titulo, notas, status, prazo, dono_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, empresaId, campanhaId, titulo, notas, status, prazo, donoId, createdBy);
  } else {
    db.prepare(
      `INSERT INTO tarefas
        (id, empresa_id, campanha_id, titulo, notas, prazo, dono_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, empresaId, campanhaId, titulo, notas, prazo, donoId, createdBy);
  }
  return id;
}

/**
 * @description Full tenant chain: user + empresa + expert + campanha (+ optional tarefa).
 * @param {DatabaseSync} db
 * @param {{empresaId: string, expertId: string, campanhaId: string, userId: string, tarefaId?: string}} ids
 */
function seedTenantChain(db, ids) {
  seedUser(db, ids.userId);
  seedEmpresa(db, ids.empresaId);
  seedExpert(db, ids.expertId, ids.empresaId);
  seedCampanha(db, ids.campanhaId, ids.expertId, ids.empresaId);
  if (ids.tarefaId) {
    seedTarefa(db, {
      id: ids.tarefaId,
      campanhaId: ids.campanhaId,
      empresaId: ids.empresaId,
      createdBy: ids.userId,
    });
  }
}

// ─── lt-domain-tables-and-checks ───────────────────────────────────────────

test("lt-domain-tables-and-checks: domain tables, CHECKs, defaults, NOT NULL", () => {
  const db = openDb();

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r) => r.name);

  for (const name of [
    "users",
    "sessions",
    "empresas",
    "empresa_membros",
    "experts",
    "campanhas",
    "tarefas",
  ]) {
    assert.ok(tables.includes(name), `expected table ${name}`);
  }

  // users.role CHECK super_admin|user, default user
  {
    const cols = tableInfo(db, "users");
    const role = cols.find((c) => c.name === "role");
    assert.ok(role, "users.role exists");
    assert.match(String(role.dflt_value ?? ""), /user/, "users.role default user");

    const uid = seedUser(db, "u-role-default");
    const row = db.prepare(`SELECT role FROM users WHERE id = ?`).get(uid);
    assert.equal(row.role, "user");

    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, role)
         VALUES ('u-sa', 'sa@example.com', 'SA', 'h', 's', 'super_admin')`,
      ).run();
    });
    assert.throws(() => {
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, role)
         VALUES ('u-bad', 'bad@example.com', 'Bad', 'h', 's', 'admin')`,
      ).run();
    }, /CHECK|constraint/i);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, role)
         VALUES ('u-bad2', 'bad2@example.com', 'Bad', 'h', 's', 'member')`,
      ).run();
    }, /CHECK|constraint/i);
  }

  // empresa_membros: papel admin|membro, UNIQUE(empresa_id,user_id), no deleted_at
  {
    const cols = columnNames(db, "empresa_membros");
    assert.equal(cols.has("deleted_at"), false, "empresa_membros must not have deleted_at");

    const uniques = uniqueColumnSets(db, "empresa_membros");
    assert.ok(
      hasUniqueOn(uniques, ["empresa_id", "user_id"]),
      "UNIQUE(empresa_id, user_id) on empresa_membros",
    );

    const emp = seedEmpresa(db, "emp-membros");
    const u1 = seedUser(db, "u-membros-1");
    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO empresa_membros (empresa_id, user_id, papel) VALUES (?, ?, 'admin')`,
      ).run(emp, u1);
    });
    const u2 = seedUser(db, "u-membros-2");
    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO empresa_membros (empresa_id, user_id, papel) VALUES (?, ?, 'membro')`,
      ).run(emp, u2);
    });
    assert.throws(() => {
      db.prepare(
        `INSERT INTO empresa_membros (empresa_id, user_id, papel) VALUES (?, ?, 'owner')`,
      ).run(emp, seedUser(db, "u-membros-owner"));
    }, /CHECK|constraint/i);
  }

  // campanhas.tipo / status CHECKs + status default aberta
  {
    const emp = seedEmpresa(db, "emp-camp");
    const ex = seedExpert(db, "ex-camp", emp);
    const tipos = ["lancamento_pago", "gratuito", "perpetuo", "webinario"];
    for (const tipo of tipos) {
      assert.doesNotThrow(() => {
        seedCampanha(db, `camp-tipo-${tipo}`, ex, emp, { tipo });
      }, `tipo ${tipo} allowed`);
    }
    assert.throws(() => {
      seedCampanha(db, "camp-tipo-bad", ex, emp, { tipo: "invalido" });
    }, /CHECK|constraint/i);

    const statuses = ["aberta", "encerrada", "arquivada"];
    for (const status of statuses) {
      assert.doesNotThrow(() => {
        seedCampanha(db, `camp-st-${status}`, ex, emp, { status });
      }, `status ${status} allowed`);
    }
    assert.throws(() => {
      seedCampanha(db, "camp-st-bad", ex, emp, { status: "invalido" });
    }, /CHECK|constraint/i);

    // default status aberta — insert without status column if schema allows default
    db.prepare(
      `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo)
       VALUES ('camp-def', ?, ?, 'Default status', 'gratuito')`,
    ).run(emp, ex);
    const def = db.prepare(`SELECT status FROM campanhas WHERE id = 'camp-def'`).get();
    assert.equal(def.status, "aberta");
  }

  // tarefas columns / CHECKs / defaults / FKs
  {
    const cols = tableInfo(db, "tarefas");
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    assert.ok(byName.titulo?.notnull, "tarefas.titulo NOT NULL");
    assert.ok(byName.notas?.notnull, "tarefas.notas NOT NULL");
    assert.match(String(byName.notas?.dflt_value ?? ""), /''|""/, "notas default ''");
    assert.ok(byName.campanha_id?.notnull, "tarefas.campanha_id NOT NULL");
    assert.ok(byName.created_by?.notnull, "tarefas.created_by NOT NULL");
    assert.equal(byName.prazo?.notnull, false, "tarefas.prazo nullable");
    assert.equal(byName.dono_id?.notnull, false, "tarefas.dono_id nullable");

    for (const t of ["experts", "campanhas", "tarefas"]) {
      const empCol = tableInfo(db, t).find((c) => c.name === "empresa_id");
      assert.ok(empCol, `${t}.empresa_id exists`);
      assert.ok(empCol.notnull, `${t}.empresa_id NOT NULL`);
    }

    const tFks = foreignKeys(db, "tarefas");
    assert.ok(
      hasFk(tFks, "users", ["created_by"], ["id"]),
      "tarefas.created_by → users(id)",
    );

    const userId = seedUser(db, "u-tar-chk");
    const emp = seedEmpresa(db, "emp-tar-chk");
    const ex = seedExpert(db, "ex-tar-chk", emp);
    const camp = seedCampanha(db, "camp-tar-chk", ex, emp);

    // status default a_fazer
    seedTarefa(db, {
      id: "tar-def",
      campanhaId: camp,
      empresaId: emp,
      createdBy: userId,
      titulo: "Com default",
    });
    const defRow = db.prepare(`SELECT status, notas FROM tarefas WHERE id = 'tar-def'`).get();
    assert.equal(defRow.status, "a_fazer");
    assert.equal(defRow.notas, "");

    for (const st of ["a_fazer", "fazendo", "feito"]) {
      assert.doesNotThrow(() => {
        seedTarefa(db, {
          id: `tar-st-${st}`,
          campanhaId: camp,
          empresaId: emp,
          createdBy: userId,
          status: st,
        });
      });
    }
    assert.throws(() => {
      seedTarefa(db, {
        id: "tar-st-bad",
        campanhaId: camp,
        empresaId: emp,
        createdBy: userId,
        status: "invalido",
      });
    }, /CHECK|constraint/i);
  }

  db.close();
});

// ─── lt-no-project-tables ──────────────────────────────────────────────────

test("lt-no-project-tables: projects and tasks tables absent", () => {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('projects', 'tasks')`,
    )
    .all();
  assert.equal(rows.length, 0, "no projects or tasks tables");
  db.close();
});

// ─── lt-fk-hierarchy-and-composite ─────────────────────────────────────────

test("lt-fk-hierarchy-and-composite: composite tenant FKs and UNIQUE(id,empresa_id)", () => {
  const db = openDb();

  const expertFks = foreignKeys(db, "experts");
  assert.ok(
    hasFk(expertFks, "empresas", ["empresa_id"], ["id"]),
    "experts.empresa_id → empresas",
  );

  const campFks = foreignKeys(db, "campanhas");
  assert.ok(
    hasFk(campFks, "experts", ["expert_id", "empresa_id"], ["id", "empresa_id"]),
    "campanhas (expert_id,empresa_id) → experts(id,empresa_id)",
  );
  assert.ok(
    hasFk(campFks, "empresas", ["empresa_id"], ["id"]),
    "campanhas.empresa_id → empresas",
  );

  const tarFks = foreignKeys(db, "tarefas");
  assert.ok(
    hasFk(tarFks, "campanhas", ["campanha_id", "empresa_id"], ["id", "empresa_id"]),
    "tarefas (campanha_id,empresa_id) → campanhas(id,empresa_id)",
  );
  assert.ok(
    hasFk(tarFks, "empresas", ["empresa_id"], ["id"]),
    "tarefas.empresa_id → empresas",
  );
  assert.ok(
    hasFk(tarFks, "users", ["created_by"], ["id"]),
    "tarefas.created_by → users",
  );

  const expertUniques = uniqueColumnSets(db, "experts");
  assert.ok(
    hasUniqueOn(expertUniques, ["id", "empresa_id"]),
    "experts UNIQUE(id, empresa_id)",
  );

  const campUniques = uniqueColumnSets(db, "campanhas");
  assert.ok(
    hasUniqueOn(campUniques, ["id", "empresa_id"]),
    "campanhas UNIQUE(id, empresa_id)",
  );

  // Hierarchy only Empresa→Expert→Campanha→Tarefa: no reverse/orphan parent FKs
  // experts must not FK to campanhas/tarefas; campanhas must not FK to tarefas
  for (const g of groupForeignKeys(expertFks).values()) {
    assert.notEqual(g.table, "campanhas");
    assert.notEqual(g.table, "tarefas");
    assert.notEqual(g.table, "experts");
  }
  for (const g of groupForeignKeys(campFks).values()) {
    assert.notEqual(g.table, "tarefas");
    assert.notEqual(g.table, "campanhas");
  }
  // tarefas parents are only campanhas, empresas, users (and optionally dono→users)
  for (const g of groupForeignKeys(tarFks).values()) {
    assert.ok(
      ["campanhas", "empresas", "users"].includes(g.table),
      `unexpected tarefas FK parent ${g.table}`,
    );
  }

  db.close();
});

// ─── lt-tenant-list-isolation ──────────────────────────────────────────────

test("lt-tenant-list-isolation: SELECT by empresa_id returns only that tenant", () => {
  const db = openDb();

  seedTenantChain(db, {
    empresaId: "emp-A",
    expertId: "ex-A",
    campanhaId: "camp-A",
    userId: "user-A",
    tarefaId: "tar-A",
  });
  seedTenantChain(db, {
    empresaId: "emp-B",
    expertId: "ex-B",
    campanhaId: "camp-B",
    userId: "user-B",
    tarefaId: "tar-B",
  });

  const expertsA = db
    .prepare(`SELECT id, empresa_id FROM experts WHERE empresa_id = ?`)
    .all("emp-A");
  const campanhasA = db
    .prepare(`SELECT id, empresa_id FROM campanhas WHERE empresa_id = ?`)
    .all("emp-A");
  const tarefasA = db
    .prepare(`SELECT id, empresa_id FROM tarefas WHERE empresa_id = ?`)
    .all("emp-A");

  assert.ok(expertsA.length >= 1);
  assert.ok(campanhasA.length >= 1);
  assert.ok(tarefasA.length >= 1);

  for (const row of [...expertsA, ...campanhasA, ...tarefasA]) {
    assert.equal(row.empresa_id, "emp-A");
  }

  const bIds = new Set(["ex-B", "camp-B", "tar-B"]);
  for (const row of [...expertsA, ...campanhasA, ...tarefasA]) {
    assert.equal(bIds.has(row.id), false, `B id ${row.id} must not appear in A list`);
  }

  db.close();
});

// ─── lt-composite-fk-blocks-cross-tenant ───────────────────────────────────

test("lt-composite-fk-blocks-cross-tenant: cross-tenant parent link rejected", () => {
  const db = openDb();

  seedTenantChain(db, {
    empresaId: "emp-A",
    expertId: "ex-A",
    campanhaId: "camp-A",
    userId: "user-A",
  });
  seedTenantChain(db, {
    empresaId: "emp-B",
    expertId: "ex-B",
    campanhaId: "camp-B",
    userId: "user-B",
  });

  // campanha with expert from B but empresa_id A
  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo)
         VALUES ('camp-x', 'emp-A', 'ex-B', 'Cross', 'gratuito')`,
      ).run();
    },
    /FOREIGN KEY|foreign key/i,
    "cross-tenant campanha insert must fail FK",
  );

  // tarefa with campanha from B but empresa_id A
  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO tarefas
          (id, empresa_id, campanha_id, titulo, notas, created_by)
         VALUES ('tar-x', 'emp-A', 'camp-B', 'Cross', '', 'user-A')`,
      ).run();
    },
    /FOREIGN KEY|foreign key/i,
    "cross-tenant tarefa insert must fail FK",
  );

  db.close();
});

// ─── lt-tarefa-prazo-null ──────────────────────────────────────────────────

test("lt-tarefa-prazo-null: prazo and dono_id nullable; created_by required; status default", () => {
  const db = openDb();

  const userId = seedUser(db, "user-prazo");
  const emp = seedEmpresa(db, "emp-prazo");
  const ex = seedExpert(db, "ex-prazo", emp);
  const camp = seedCampanha(db, "camp-prazo", ex, emp);

  seedTarefa(db, {
    id: "tar-prazo-null",
    campanhaId: camp,
    empresaId: emp,
    createdBy: userId,
    prazo: null,
    donoId: null,
    titulo: "Sem prazo",
  });

  const row = db
    .prepare(
      `SELECT prazo, dono_id, created_by, status FROM tarefas WHERE id = 'tar-prazo-null'`,
    )
    .get();

  assert.equal(row.prazo, null);
  assert.equal(row.dono_id, null);
  assert.equal(row.created_by, userId);
  assert.equal(row.status, "a_fazer");

  db.close();
});

// ─── lt-check-rejects-invalid-enums ────────────────────────────────────────

test("lt-check-rejects-invalid-enums: invalid tipo/status/papel rejected", () => {
  const db = openDb();

  const userId = seedUser(db, "user-enum");
  const emp = seedEmpresa(db, "emp-enum");
  const ex = seedExpert(db, "ex-enum", emp);
  const camp = seedCampanha(db, "camp-enum", ex, emp);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo)
       VALUES ('c-bad-tipo', ?, ?, 'x', 'invalido')`,
    ).run(emp, ex);
  }, /CHECK|constraint/i);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
       VALUES ('c-bad-st', ?, ?, 'x', 'gratuito', 'invalido')`,
    ).run(emp, ex);
  }, /CHECK|constraint/i);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO tarefas
        (id, empresa_id, campanha_id, titulo, notas, status, created_by)
       VALUES ('t-bad-st', ?, ?, 'x', '', 'invalido', ?)`,
    ).run(emp, camp, userId);
  }, /CHECK|constraint/i);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO empresa_membros (empresa_id, user_id, papel)
       VALUES (?, ?, 'owner')`,
    ).run(emp, userId);
  }, /CHECK|constraint/i);

  db.close();
});

// ─── lt-membership-hard-delete-reinvite ────────────────────────────────────

test("lt-membership-hard-delete-reinvite: DELETE then re-INSERT same pair succeeds", () => {
  const db = openDb();

  const userId = seedUser(db, "user-reinvite");
  const emp = seedEmpresa(db, "emp-reinvite");

  db.prepare(
    `INSERT INTO empresa_membros (empresa_id, user_id, papel) VALUES (?, ?, 'admin')`,
  ).run(emp, userId);

  db.prepare(
    `DELETE FROM empresa_membros WHERE empresa_id = ? AND user_id = ?`,
  ).run(emp, userId);

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO empresa_membros (empresa_id, user_id, papel) VALUES (?, ?, 'membro')`,
    ).run(emp, userId);
  });

  const row = db
    .prepare(
      `SELECT papel FROM empresa_membros WHERE empresa_id = ? AND user_id = ?`,
    )
    .get(emp, userId);
  assert.equal(row.papel, "membro");

  db.close();
});
