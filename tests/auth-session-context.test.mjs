/**
 * Locked session context contract — getSessionContext, mintSession activeEmpresaId, setActiveEmpresa.
 * Applies migrations/0001_init.sql against ephemeral SQLite (foreign_keys=ON).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getSessionContext,
  mintSession,
  setActiveEmpresa,
} from "../src/worker/auth/session.ts";

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
 * @description Seed a minimal users row for session tests.
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

/**
 * @description SHA-256 hex digest of a raw session token.
 * @param {string} rawToken
 */
function sha256Hex(rawToken) {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

// ─── lt-get-session-context-null-active ────────────────────────────────────

/**
 * @description mintSession without active empresa; getSessionContext returns userId and activeEmpresaId null.
 */
test("lt-get-session-context-null-active: mint without active → getSessionContext { userId, activeEmpresaId: null }", async () => {
  const db = openDb();
  const userId = seedUser(db, "user-ctx-null");

  const rawToken = await mintSession(db, userId);
  const ctx = await getSessionContext(db, rawToken);

  assert.deepEqual(ctx, { userId, activeEmpresaId: null });

  db.close();
});

// ─── lt-mint-session-with-active-empresa ───────────────────────────────────

/**
 * @description mintSession with activeEmpresaId persists it; getSessionContext and sessions row match.
 */
test("lt-mint-session-with-active-empresa: mint with E.id → context and row active_empresa_id === E.id", async () => {
  const db = openDb();
  const userId = seedUser(db, "user-ctx-mint");
  const empresaId = seedEmpresa(db, "emp-ctx-mint");

  const rawToken = await mintSession(db, userId, empresaId);
  const ctx = await getSessionContext(db, rawToken);

  assert.equal(ctx.activeEmpresaId, empresaId);
  assert.equal(ctx.userId, userId);

  const row = db
    .prepare(`SELECT active_empresa_id FROM sessions WHERE token_hash = ?`)
    .get(sha256Hex(rawToken));
  assert.ok(row, "sessions row exists");
  assert.equal(row.active_empresa_id, empresaId);

  db.close();
});

// ─── lt-set-active-empresa-updates-row ──────────────────────────────────────

/**
 * @description setActiveEmpresa updates activeEmpresaId to E.id then back to null via getSessionContext.
 */
test("lt-set-active-empresa-updates-row: set E.id then null updates getSessionContext.activeEmpresaId", async () => {
  const db = openDb();
  const userId = seedUser(db, "user-ctx-set");
  const empresaId = seedEmpresa(db, "emp-ctx-set");

  const rawToken = await mintSession(db, userId);
  const before = await getSessionContext(db, rawToken);
  assert.equal(before.activeEmpresaId, null);

  await setActiveEmpresa(db, rawToken, empresaId);
  const afterSet = await getSessionContext(db, rawToken);
  assert.equal(afterSet.activeEmpresaId, empresaId);

  await setActiveEmpresa(db, rawToken, null);
  const afterClear = await getSessionContext(db, rawToken);
  assert.equal(afterClear.activeEmpresaId, null);

  db.close();
});
