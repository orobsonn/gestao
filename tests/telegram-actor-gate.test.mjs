/**
 * Locked telegram actor link + membership gate contract.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Asserts resolveTelegramActor unlinked / non-member / live-member outcomes.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveTelegramActor } from "../src/worker/services/telegram-actor-gate.ts";

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
 * @description Seed a minimal users row (dummy hash/salt — FK parent only).
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-actor-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Actor User";
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, "hash", "salt");
  return { id, email, name };
}

/**
 * @description Seed a minimal empresas row (FK parent only).
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string, deleted_at?: string | null }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-actor-a";
  const nome = opts.nome ?? "Empresa A";
  if (opts.deleted_at != null) {
    db.prepare(
      `INSERT INTO empresas (id, nome, deleted_at) VALUES (?, ?, ?)`,
    ).run(id, nome, opts.deleted_at);
  } else {
    db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  }
  return { id, nome };
}

/**
 * @description Seed user_telegram_links row.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {string} telegramUserId
 */
function seedTelegramLink(db, userId, telegramUserId) {
  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(userId, telegramUserId);
}

/**
 * @description Seed empresa_membros link.
 * @param {DatabaseSync} db
 * @param {string} empresaId
 * @param {string} userId
 * @param {string} [papel]
 */
function seedMembro(db, empresaId, userId, papel = "membro") {
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, ?)`,
  ).run(`mem-${empresaId}-${userId}`, empresaId, userId, papel);
}

// ─── lt-actor-unlinked-fail ────────────────────────────────────────────────

/**
 * @description resolveTelegramActor returns ok false reason not_linked when telegram_user_id has no user_telegram_links row.
 */
test("lt-actor-unlinked-fail: no user_telegram_links row → ok false reason not_linked", async () => {
  const db = openDb();
  const empresaA = seedEmpresa(db, { id: "emp-A", nome: "Empresa A" });
  const tgId = "tg-unlinked-99";

  const result = await resolveTelegramActor(db, tgId, empresaA.id);

  assert.equal(result.ok, false, "ok must be false when telegram user is not linked");
  assert.equal(
    result.reason,
    "not_linked",
    "reason must be not_linked when no user_telegram_links row",
  );

  db.close();
});

// ─── lt-actor-linked-non-member-fail ───────────────────────────────────────

/**
 * @description resolveTelegramActor returns ok false reason not_member when linked user is not in empresa_membros for empresa A.
 */
test("lt-actor-linked-non-member-fail: linked but not empresa_membros for A → ok false reason not_member", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-linked-non-member" });
  const empresaA = seedEmpresa(db, { id: "emp-A", nome: "Empresa A" });
  const tgId = "tg-linked-non-member-7";
  seedTelegramLink(db, user.id, tgId);
  // deliberately no empresa_membros row for empresa A

  const result = await resolveTelegramActor(db, tgId, empresaA.id);

  assert.equal(
    result.ok,
    false,
    "ok must be false when linked user is not a member of empresa A",
  );
  assert.equal(
    result.reason,
    "not_member",
    "reason must be not_member when user has no empresa_membros row for A",
  );

  db.close();
});

// ─── lt-actor-linked-member-ok ─────────────────────────────────────────────

/**
 * @description resolveTelegramActor returns ok true and userId when linked user is a live member of empresa A.
 */
test("lt-actor-linked-member-ok: linked live member of A → ok true userId equals gestao user id", async () => {
  const db = openDb();
  const user = seedUser(db, { id: "user-live-member" });
  const empresaA = seedEmpresa(db, { id: "emp-A", nome: "Empresa A" });
  const tgId = "tg-live-member-3";
  seedTelegramLink(db, user.id, tgId);
  seedMembro(db, empresaA.id, user.id, "membro");

  const result = await resolveTelegramActor(db, tgId, empresaA.id);

  assert.equal(result.ok, true, "ok must be true for linked live member of empresa A");
  assert.equal(
    result.userId,
    user.id,
    "userId must equal the gestao user id from user_telegram_links",
  );

  db.close();
});
