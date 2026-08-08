/**
 * Locked empresa LLM health-and-decrypt gate for bot turns.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 * Uses encryptLlmApiKey to seed ciphertext; loadEmpresaLlmForBot under test.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEmpresaLlmForBot } from "../src/worker/services/empresa-llm-gate.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const TEST_ENCRYPTION_SECRET = "test-llm-key-encryption-secret-hermetic-gate";
const PLAINTEXT_KEY = "sk-test-bot-gate-plaintext-xyz";

const FAIL_REASONS = new Set([
  "llm_not_configured",
  "llm_key_missing",
  "llm_key_unvalidated",
  "llm_key_invalid",
]);

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
 * @description Seed a minimal empresa row (active — deleted_at NULL).
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Empresa LLM Gate";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  return { id, nome };
}

/**
 * @description Insert empresa_llm_settings row (nullable key material allowed by CHECK).
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   provider?: string | null,
 *   ciphertext?: string | null,
 *   iv?: string | null,
 *   status: string,
 * }} opts
 */
function seedLlmSettings(db, opts) {
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, api_key_ciphertext, api_key_iv, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.empresaId,
    opts.provider ?? null,
    opts.ciphertext ?? null,
    opts.iv ?? null,
    opts.status,
  );
}

/**
 * @description Assert fail-closed gate result: ok false, reason in allowlist, apiKey absent.
 * @param {unknown} result
 */
function assertGateFail(result) {
  assert.ok(result && typeof result === "object", "result is object");
  assert.equal(/** @type {{ ok?: unknown }} */ (result).ok, false);
  const reason = /** @type {{ reason?: unknown }} */ (result).reason;
  assert.equal(typeof reason, "string");
  assert.ok(
    FAIL_REASONS.has(/** @type {string} */ (reason)),
    `reason must be one of ${[...FAIL_REASONS].join(",")}, got ${String(reason)}`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "apiKey"),
    false,
    "apiKey must be absent on fail",
  );
  assert.equal(
    /** @type {{ apiKey?: unknown }} */ (result).apiKey,
    undefined,
    "apiKey must be undefined on fail",
  );
}

// ─── lt-llm-gate-valid-decrypts ────────────────────────────────────────────

/**
 * @description Given empresa_llm_settings with has_key ciphertext and status valid under a known test secret, loadEmpresaLlmForBot returns ok true, apiKey equals original plaintext, and provider is openai or anthropic.
 */
test("lt-llm-gate-valid-decrypts: valid has_key row decrypts to plaintext with openai|anthropic provider", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-llm-gate-valid", nome: "Empresa Gate Valid" });

  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    TEST_ENCRYPTION_SECRET,
    PLAINTEXT_KEY,
  );
  seedLlmSettings(db, {
    empresaId: emp.id,
    provider: "openai",
    ciphertext: ciphertextHex,
    iv: ivHex,
    status: "valid",
  });

  const result = await loadEmpresaLlmForBot(
    db,
    emp.id,
    TEST_ENCRYPTION_SECRET,
  );

  assert.ok(result && typeof result === "object", "result is object");
  assert.equal(result.ok, true);
  assert.equal(result.apiKey, PLAINTEXT_KEY);
  assert.ok(
    result.provider === "openai" || result.provider === "anthropic",
    `provider must be openai or anthropic, got ${String(result.provider)}`,
  );

  db.close();
});

// ─── lt-llm-gate-invalid-no-ok ─────────────────────────────────────────────

/**
 * @description Given status invalid, missing row, or has_key false, loadEmpresaLlmForBot returns ok false with reason in the fail-closed set and apiKey absent.
 */
test("lt-llm-gate-invalid-no-ok: invalid status / missing row / has_key false → ok false, reason allowlisted, no apiKey", async () => {
  const db = openDb();
  const secret = TEST_ENCRYPTION_SECRET;

  // ── missing row ──────────────────────────────────────────────────────────
  const empMissing = seedEmpresa(db, {
    id: "emp-llm-gate-missing",
    nome: "Empresa Gate Missing",
  });
  const missingResult = await loadEmpresaLlmForBot(db, empMissing.id, secret);
  assertGateFail(missingResult);
  assert.equal(
    /** @type {{ reason: string }} */ (missingResult).reason,
    "llm_not_configured",
  );

  // ── has_key false (null ciphertext/iv) ───────────────────────────────────
  const empNoKey = seedEmpresa(db, {
    id: "emp-llm-gate-nokey",
    nome: "Empresa Gate No Key",
  });
  seedLlmSettings(db, {
    empresaId: empNoKey.id,
    provider: "openai",
    ciphertext: null,
    iv: null,
    status: "unvalidated",
  });
  const noKeyResult = await loadEmpresaLlmForBot(db, empNoKey.id, secret);
  assertGateFail(noKeyResult);
  assert.equal(
    /** @type {{ reason: string }} */ (noKeyResult).reason,
    "llm_key_missing",
  );

  // ── status invalid (with ciphertext present) ─────────────────────────────
  const empInvalid = seedEmpresa(db, {
    id: "emp-llm-gate-invalid",
    nome: "Empresa Gate Invalid",
  });
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(secret, PLAINTEXT_KEY);
  seedLlmSettings(db, {
    empresaId: empInvalid.id,
    provider: "anthropic",
    ciphertext: ciphertextHex,
    iv: ivHex,
    status: "invalid",
  });
  const invalidResult = await loadEmpresaLlmForBot(db, empInvalid.id, secret);
  assertGateFail(invalidResult);
  assert.equal(
    /** @type {{ reason: string }} */ (invalidResult).reason,
    "llm_key_invalid",
  );
  // Fail path must not surface the plaintext key on the result object.
  const invalidJson = JSON.stringify(invalidResult);
  assert.equal(
    invalidJson.includes(PLAINTEXT_KEY),
    false,
    "fail result must not include plaintext api key",
  );

  db.close();
});
