/**
 * Locked bootstrap super-admin contract — ensureBootstrapSuperAdmin from secrets args.
 * Applies migrations/0001_init.sql against ephemeral SQLite (foreign_keys=ON).
 * Secrets are passed as args (not process.env) for hermetic tests.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureBootstrapSuperAdmin } from "../src/worker/auth/bootstrap.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(__dirname, "../migrations/0001_init.sql");
const DEV_VARS_EXAMPLE_PATH = resolve(__dirname, "../.dev.vars.example");

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
 * @description Count users rows with role=super_admin.
 * @param {DatabaseSync} db
 */
function countSuperAdmins(db) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin'`)
    .get();
  return Number(row.c);
}

/**
 * @description Fetch the single users row for an email (or undefined).
 * @param {DatabaseSync} db
 * @param {string} email
 */
function getUserByEmail(db, email) {
  return db
    .prepare(
      `SELECT id, email, name, password_hash, password_salt, role FROM users WHERE email = ?`,
    )
    .get(email);
}

// ─── lt-bootstrap-creates-once ─────────────────────────────────────────────

/**
 * @description ensureBootstrapSuperAdmin twice with valid secrets creates exactly one super_admin; name is Super Admin; password_hash unchanged on second call.
 */
test("lt-bootstrap-creates-once: valid secrets + empty users → one super_admin; second call leaves password_hash unchanged", async () => {
  const db = openDb();
  const email = "super@example.com";
  const password = "secure-pass-ok";
  assert.ok(password.length >= 8);

  await ensureBootstrapSuperAdmin(db, { email, password });

  const afterFirst = getUserByEmail(db, email);
  assert.ok(afterFirst, "user row exists after first bootstrap");
  assert.equal(afterFirst.role, "super_admin");
  assert.equal(afterFirst.email, email);
  assert.equal(afterFirst.name, "Super Admin");
  assert.equal(typeof afterFirst.password_hash, "string");
  assert.ok(afterFirst.password_hash.length > 0, "password_hash non-empty");
  const hashAfterFirst = afterFirst.password_hash;

  await ensureBootstrapSuperAdmin(db, { email, password });

  assert.equal(countSuperAdmins(db), 1, "exactly one super_admin after two calls");
  const afterSecond = getUserByEmail(db, email);
  assert.ok(afterSecond);
  assert.equal(afterSecond.role, "super_admin");
  assert.equal(afterSecond.name, "Super Admin");
  assert.equal(
    afterSecond.password_hash,
    hashAfterFirst,
    "password_hash unchanged on second call",
  );

  db.close();
});

// ─── lt-bootstrap-short-password-skips ──────────────────────────────────────

/**
 * @description ensureBootstrapSuperAdmin with password length < 8 creates zero super_admin rows.
 */
test("lt-bootstrap-short-password-skips: password < 8 → zero super_admin rows", async () => {
  const db = openDb();
  const email = "super@example.com";
  const password = "short"; // length 5 < 8
  assert.ok(password.length < 8);

  await ensureBootstrapSuperAdmin(db, { email, password });

  assert.equal(countSuperAdmins(db), 0);
  assert.equal(getUserByEmail(db, email), undefined);

  db.close();
});

// ─── lt-bootstrap-missing-secrets-skips ─────────────────────────────────────

/**
 * @description ensureBootstrapSuperAdmin with missing or empty email/password creates zero super_admin rows.
 */
test("lt-bootstrap-missing-secrets-skips: missing/empty email or password → zero super_admin", async () => {
  const cases = [
    { email: "", password: "secure-pass-ok", label: "empty email" },
    { email: "super@example.com", password: "", label: "empty password" },
    { email: "", password: "", label: "both empty" },
    { email: undefined, password: "secure-pass-ok", label: "missing email" },
    { email: "super@example.com", password: undefined, label: "missing password" },
    { email: undefined, password: undefined, label: "both missing" },
  ];

  for (const c of cases) {
    const db = openDb();
    await ensureBootstrapSuperAdmin(db, { email: c.email, password: c.password });
    assert.equal(
      countSuperAdmins(db),
      0,
      `zero super_admin when ${c.label}`,
    );
    db.close();
  }
});

// ─── lt-bootstrap-user-collision-no-promote ─────────────────────────────────

/**
 * @description existing role=user with same email is not promoted; bootstrap reports failure/not-succeeded.
 */
test("lt-bootstrap-user-collision-no-promote: existing user email stays role=user; result not ok", async () => {
  const db = openDb();
  const email = "collision@example.com";
  const password = "secure-pass-ok";
  assert.ok(password.length >= 8);

  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("user-existing", email, "Existing User", "existing-hash", "existing-salt", "user");

  const result = await ensureBootstrapSuperAdmin(db, { email, password });

  const user = getUserByEmail(db, email);
  assert.ok(user);
  assert.equal(user.role, "user", "must not promote existing user to super_admin");
  assert.equal(user.name, "Existing User");
  assert.equal(user.password_hash, "existing-hash", "must not overwrite password_hash");
  assert.equal(countSuperAdmins(db), 0);

  // Pin failure mode: return failed result, do not throw.
  assert.ok(result && typeof result === "object", "returns a result object");
  assert.equal(result.ok, false, "bootstrap reports failure/not-succeeded");

  db.close();
});

// ─── lt-dev-vars-example-keys ───────────────────────────────────────────────

/**
 * @description .dev.vars.example documents SUPER_ADMIN_EMAIL= and SUPER_ADMIN_PASSWORD= placeholders without a real password value.
 */
test("lt-dev-vars-example-keys: .dev.vars.example has SUPER_ADMIN placeholders, no real password", () => {
  const content = readFileSync(DEV_VARS_EXAMPLE_PATH, "utf8");

  assert.match(
    content,
    /^SUPER_ADMIN_EMAIL=/m,
    "contains SUPER_ADMIN_EMAIL= placeholder line",
  );
  assert.match(
    content,
    /^SUPER_ADMIN_PASSWORD=/m,
    "contains SUPER_ADMIN_PASSWORD= placeholder line",
  );

  const emailLine = content.match(/^SUPER_ADMIN_EMAIL=(.*)$/m);
  const passwordLine = content.match(/^SUPER_ADMIN_PASSWORD=(.*)$/m);
  assert.ok(emailLine, "SUPER_ADMIN_EMAIL line parseable");
  assert.ok(passwordLine, "SUPER_ADMIN_PASSWORD line parseable");

  const emailVal = emailLine[1].trim();
  const passwordVal = passwordLine[1].trim();

  // Placeholders only — empty value (same style as other .dev.vars.example keys).
  assert.equal(emailVal, "", "SUPER_ADMIN_EMAIL value must be empty placeholder");
  assert.equal(
    passwordVal,
    "",
    "SUPER_ADMIN_PASSWORD must not embed a real password value",
  );
});
