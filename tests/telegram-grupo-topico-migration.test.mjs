/**
 * Locked telegram grupo/topico migration contract — full migrations/ chain + constraints.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Asserts telegram_bind_codes, empresa_telegram_chats, expert_telegram_topics schema.
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
 * @description Insert a telegram_bind_codes row (minimal required columns).
 * @param {DatabaseSync} db
 * @param {{id: string, empresaId: string, kind: string, expertId: string|null, codeHash?: string, expiresAt?: string, usedAt?: string|null, createdAt?: string}} row
 */
function insertBindCode(db, row) {
  const codeHash = row.codeHash ?? `${row.id}-hash`.padEnd(64, "0").slice(0, 64);
  const expiresAt = row.expiresAt ?? "2026-08-05T12:15:00.000Z";
  const usedAt = row.usedAt === undefined ? null : row.usedAt;
  const createdAt = row.createdAt ?? "2026-08-05T12:00:00.000Z";
  db.prepare(
    `INSERT INTO telegram_bind_codes
      (id, empresa_id, kind, expert_id, code_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.empresaId,
    row.kind,
    row.expertId,
    codeHash,
    expiresAt,
    usedAt,
    createdAt,
  );
}

// ─── lt-mig-grupo-tables-columns ───────────────────────────────────────────

/**
 * @description Full migration chain yields telegram_bind_codes, empresa_telegram_chats, expert_telegram_topics columns.
 */
test("lt-mig-grupo-tables-columns: pragma_table_info includes bind_codes, empresa_chats, expert_topics columns", () => {
  const db = openDb();

  const bindCols = columnNames(db, "telegram_bind_codes");
  for (const col of [
    "id",
    "empresa_id",
    "kind",
    "expert_id",
    "code_hash",
    "expires_at",
    "used_at",
    "created_at",
  ]) {
    assert.ok(
      bindCols.has(col),
      `pragma_table_info('telegram_bind_codes') must include ${col}`,
    );
  }

  const chatCols = columnNames(db, "empresa_telegram_chats");
  for (const col of ["empresa_id", "chat_id", "linked_at"]) {
    assert.ok(
      chatCols.has(col),
      `pragma_table_info('empresa_telegram_chats') must include ${col}`,
    );
  }

  const topicCols = columnNames(db, "expert_telegram_topics");
  for (const col of [
    "expert_id",
    "empresa_id",
    "chat_id",
    "message_thread_id",
    "linked_at",
  ]) {
    assert.ok(
      topicCols.has(col),
      `pragma_table_info('expert_telegram_topics') must include ${col}`,
    );
  }

  db.close();
});

// ─── lt-mig-kind-expert-id-check ───────────────────────────────────────────

/**
 * @description kind/expert_id CHECK rejects empresa+non-null expert_id and expert+null expert_id.
 */
test("lt-mig-kind-expert-id-check: kind=empresa with expert_id or kind=expert with null expert_id fails CHECK", () => {
  const db = openDb();

  const emp = seedEmpresa(db, "emp-chk");
  const ex = seedExpert(db, "ex-chk", emp);

  assert.throws(
    () => {
      insertBindCode(db, {
        id: "code-emp-with-expert",
        empresaId: emp,
        kind: "empresa",
        expertId: ex,
      });
    },
    /CHECK|constraint/i,
    "kind='empresa' WITH non-null expert_id must fail CHECK",
  );

  assert.throws(
    () => {
      insertBindCode(db, {
        id: "code-expert-null",
        empresaId: emp,
        kind: "expert",
        expertId: null,
      });
    },
    /CHECK|constraint/i,
    "kind='expert' WITH null expert_id must fail CHECK",
  );

  db.close();
});

// ─── lt-mig-partial-unique-empresa-unused ──────────────────────────────────

/**
 * @description At most one unused kind=empresa bind code per empresa_id; used row frees the slot.
 */
test("lt-mig-partial-unique-empresa-unused: second unused kind=empresa same empresa fails UNIQUE; after used_at second succeeds", () => {
  const db = openDb();

  const emp = seedEmpresa(db, "emp-pu-a");

  insertBindCode(db, {
    id: "code-emp-1",
    empresaId: emp,
    kind: "empresa",
    expertId: null,
    codeHash: "a".repeat(64),
  });

  assert.throws(
    () => {
      insertBindCode(db, {
        id: "code-emp-2",
        empresaId: emp,
        kind: "empresa",
        expertId: null,
        codeHash: "b".repeat(64),
      });
    },
    /UNIQUE/i,
    "second unused kind=empresa for same empresa_id must fail UNIQUE",
  );

  db.prepare(
    `UPDATE telegram_bind_codes SET used_at = ? WHERE id = ?`,
  ).run("2026-08-05T12:10:00.000Z", "code-emp-1");

  assert.doesNotThrow(() => {
    insertBindCode(db, {
      id: "code-emp-2",
      empresaId: emp,
      kind: "empresa",
      expertId: null,
      codeHash: "b".repeat(64),
    });
  }, "after setting used_at on first, second unused insert must succeed");

  db.close();
});

// ─── lt-mig-partial-unique-expert-unused ───────────────────────────────────

/**
 * @description At most one unused kind=expert bind code per expert_id.
 */
test("lt-mig-partial-unique-expert-unused: second unused kind=expert same expert_id fails UNIQUE", () => {
  const db = openDb();

  const emp = seedEmpresa(db, "emp-pu-ex");
  const ex = seedExpert(db, "ex-pu", emp);

  insertBindCode(db, {
    id: "code-ex-1",
    empresaId: emp,
    kind: "expert",
    expertId: ex,
    codeHash: "c".repeat(64),
  });

  assert.throws(
    () => {
      insertBindCode(db, {
        id: "code-ex-2",
        empresaId: emp,
        kind: "expert",
        expertId: ex,
        codeHash: "d".repeat(64),
      });
    },
    /UNIQUE/i,
    "second unused kind=expert for same expert_id must fail UNIQUE",
  );

  db.close();
});

// ─── lt-mig-two-empresa-null-expert-ok ─────────────────────────────────────

/**
 * @description Two unused kind=empresa rows with expert_id NULL for different empresas both succeed.
 */
test("lt-mig-two-empresa-null-expert-ok: unused kind=empresa for two empresas with expert_id NULL both succeed", () => {
  const db = openDb();

  const empA = seedEmpresa(db, "emp-null-a");
  const empB = seedEmpresa(db, "emp-null-b");

  assert.doesNotThrow(() => {
    insertBindCode(db, {
      id: "code-null-a",
      empresaId: empA,
      kind: "empresa",
      expertId: null,
      codeHash: "e".repeat(64),
    });
  }, "unused kind=empresa for empresa A with expert_id NULL must succeed");

  assert.doesNotThrow(() => {
    insertBindCode(db, {
      id: "code-null-b",
      empresaId: empB,
      kind: "empresa",
      expertId: null,
      codeHash: "f".repeat(64),
    });
  }, "unused kind=empresa for empresa B with expert_id NULL must succeed (no UNIQUE spanning NULL expert_id)");

  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM telegram_bind_codes
       WHERE kind = 'empresa' AND used_at IS NULL AND expert_id IS NULL`,
    )
    .get();
  assert.equal(count.n, 2);

  db.close();
});

// ─── lt-mig-chat-id-global-unique ──────────────────────────────────────────

/**
 * @description empresa_telegram_chats.chat_id is globally UNIQUE — cannot map same chat to two empresas.
 */
test("lt-mig-chat-id-global-unique: second empresa_telegram_chats row with same chat_id fails UNIQUE", () => {
  const db = openDb();

  const empA = seedEmpresa(db, "emp-chat-a");
  const empB = seedEmpresa(db, "emp-chat-b");
  const chatX = "-1001";
  const linkedAt = "2026-08-05T12:00:00.000Z";

  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(empA, chatX, linkedAt);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
         VALUES (?, ?, ?)`,
      ).run(empB, chatX, linkedAt);
    },
    /UNIQUE/i,
    "INSERT (B, chatX) when (A, chatX) exists must fail UNIQUE(chat_id)",
  );

  db.close();
});

// ─── lt-mig-topic-fk-requires-empresa-chat ─────────────────────────────────

/**
 * @description expert_telegram_topics requires matching empresa_telegram_chats (empresa_id, chat_id).
 */
test("lt-mig-topic-fk-requires-empresa-chat: topic insert fails without empresa chat; succeeds after matching chat row", () => {
  const db = openDb();

  const emp = seedEmpresa(db, "emp-topic-fk");
  const ex = seedExpert(db, "ex-topic-fk", emp);
  const chatId = "-1001";
  const threadId = "42";
  const linkedAt = "2026-08-05T12:00:00.000Z";

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO expert_telegram_topics
          (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ex, emp, chatId, threadId, linkedAt);
    },
    /FOREIGN KEY/i,
    "INSERT expert_telegram_topics without empresa_telegram_chats must fail FOREIGN KEY",
  );

  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(emp, chatId, linkedAt);

  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO expert_telegram_topics
        (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ex, emp, chatId, threadId, linkedAt);
  }, "after matching empresa_telegram_chats, topic insert must succeed");

  db.close();
});

// ─── lt-mig-topic-thread-unique ────────────────────────────────────────────

/**
 * @description UNIQUE(chat_id, message_thread_id) — one expert per thread in a chat.
 */
test("lt-mig-topic-thread-unique: second expert on same (chat_id, message_thread_id) fails UNIQUE", () => {
  const db = openDb();

  const emp = seedEmpresa(db, "emp-thread-u");
  const ex1 = seedExpert(db, "ex-thread-1", emp);
  const ex2 = seedExpert(db, "ex-thread-2", emp);
  const chatX = "-1001";
  const thread1 = "1";
  const linkedAt = "2026-08-05T12:00:00.000Z";

  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(emp, chatX, linkedAt);

  db.prepare(
    `INSERT INTO expert_telegram_topics
      (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ex1, emp, chatX, thread1, linkedAt);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO expert_telegram_topics
          (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ex2, emp, chatX, thread1, linkedAt);
    },
    /UNIQUE/i,
    "second expert with same (chatX, thread1) must fail UNIQUE(chat_id, message_thread_id)",
  );

  db.close();
});

// ─── lt-mig-bind-codes-expert-fk-orphan-or-wrong-pair ──────────────────────

/**
 * @description telegram_bind_codes composite FK (expert_id, empresa_id)→experts rejects orphan and wrong pair; no row stored.
 */
test("lt-mig-bind-codes-expert-fk-orphan-or-wrong-pair: missing expert or wrong empresa pair fails FOREIGN KEY; no row stored", () => {
  const db = openDb();

  const empA = seedEmpresa(db, "emp-bind-a");
  const empB = seedEmpresa(db, "emp-bind-b");
  seedExpert(db, "ex-bind-a", empA);
  const exB = seedExpert(db, "ex-bind-b", empB);

  assert.throws(
    () => {
      insertBindCode(db, {
        id: "code-orphan",
        empresaId: empA,
        kind: "expert",
        expertId: "ex-does-not-exist",
        codeHash: "1".repeat(64),
      });
    },
    /FOREIGN KEY/i,
    "kind=expert with non-existent expert_id must fail FOREIGN KEY",
  );

  assert.throws(
    () => {
      insertBindCode(db, {
        id: "code-wrong-pair",
        empresaId: empA,
        kind: "expert",
        expertId: exB,
        codeHash: "2".repeat(64),
      });
    },
    /FOREIGN KEY/i,
    "kind=expert with expert_id of B while empresa_id=A must fail FOREIGN KEY",
  );

  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM telegram_bind_codes
       WHERE id IN ('code-orphan', 'code-wrong-pair')`,
    )
    .get();
  assert.equal(count.n, 0, "no bind code row must be stored after FK failures");

  db.close();
});

// ─── lt-mig-topic-fk-bad-expert-empresa-pair ───────────────────────────────

/**
 * @description expert_telegram_topics composite FK (expert_id, empresa_id)→experts rejects cross-tenant and missing pairs.
 */
test("lt-mig-topic-fk-bad-expert-empresa-pair: wrong or missing expert/empresa pair fails FOREIGN KEY", () => {
  const db = openDb();

  const empA = seedEmpresa(db, "emp-topic-a");
  const empB = seedEmpresa(db, "emp-topic-b");
  seedExpert(db, "ex-topic-e", empA);
  const exF = seedExpert(db, "ex-topic-f", empB);
  const chatA = "-1001";
  const linkedAt = "2026-08-05T12:00:00.000Z";

  db.prepare(
    `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
     VALUES (?, ?, ?)`,
  ).run(empA, chatA, linkedAt);

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO expert_telegram_topics
          (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(exF, empA, chatA, "10", linkedAt);
    },
    /FOREIGN KEY/i,
    "topic with expert_id=F (of B) and empresa_id=A must fail FOREIGN KEY",
  );

  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO expert_telegram_topics
          (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("ex-missing-pair", empA, chatA, "11", linkedAt);
    },
    /FOREIGN KEY/i,
    "topic with expert_id/empresa_id pair not in experts must fail FOREIGN KEY",
  );

  db.close();
});
