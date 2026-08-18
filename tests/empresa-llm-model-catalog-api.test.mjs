/**
 * Locked empresa LLM model catalog metadata contract.
 * Hermetic: node:sqlite + Hono app.request via createEmpresaApp(db, deps).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/worker/auth/password.ts";
import {
  buildSessionCookie,
  mintSession,
} from "../src/worker/auth/session.ts";
import { createEmpresaApp } from "../src/worker/routes/empresa.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const LLM_SETTINGS_PATH = "/api/empresa/llm-settings";
const SESSION_COOKIE_NAME = "gestao_session";
const TEST_ENCRYPTION_SECRET = "test-catalog-encryption-secret";

const OPENAI_MODELS = [
  "gpt-4o-mini",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];
const ANTHROPIC_MODELS = [
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];

/** @description Opens an in-memory database and applies all migrations lexically. */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

/** @description Seeds authenticated empresa-admin settings for one provider catalog. */
async function seedCatalogAdmin({ provider, modelId, suffix }) {
  const db = openDb();
  const userId = `user-catalog-${suffix}`;
  const empresaId = `empresa-catalog-${suffix}`;
  // Encrypt for real: seeding a fake ciphertext would make the "no plaintext in the response"
  // assertion vacuous, because no code path could ever have emitted that plaintext.
  const plaintextKey = `plaintext-key-${suffix}`;
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    TEST_ENCRYPTION_SECRET,
    plaintextKey,
  );
  const ciphertext = ciphertextHex;
  const iv = ivHex;
  const { hash, salt } = await hashPassword("secure-pass-ok");

  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(
    userId,
    `admin-catalog-${suffix}@example.com`,
    `Admin Catalog ${suffix}`,
    hash,
    salt,
  );
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(
    empresaId,
    `Empresa Catalog ${suffix}`,
  );
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, 'admin')`,
  ).run(`membership-catalog-${suffix}`, empresaId, userId);
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, model_id, api_key_ciphertext, api_key_iv, status)
     VALUES (?, ?, ?, ?, ?, 'valid')`,
  ).run(empresaId, provider, modelId, ciphertext, iv);

  const rawToken = await mintSession(db, userId, empresaId);
  const setCookie = buildSessionCookie(rawToken);
  const token = setCookie.split(";")[0]?.split("=").slice(1).join("=");
  assert.ok(token, "minted session token");

  return {
    app: createEmpresaApp(db, {
      llmKeyEncryptionSecret: TEST_ENCRYPTION_SECRET,
    }),
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    ciphertext,
    db,
    iv,
    plaintextKey,
  };
}

/** @description Requests authenticated LLM settings metadata as serialized text and JSON. */
async function getMetadata(app, cookie) {
  const response = await app.request(LLM_SETTINGS_PATH, {
    method: "GET",
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200, "GET settings returns 200");
  const text = await response.text();
  return { body: JSON.parse(text), text };
}

/** @description Verifies metadata serialization contains no key fields or seeded secret values. */
function assertSecretFree(text, secretValues) {
  for (const field of [
    "api_key",
    "api_key_ciphertext",
    "api_key_iv",
    "ciphertext",
    "iv",
  ]) {
    assert.equal(
      new RegExp(`"${field}"\\s*:`, "i").test(text),
      false,
      `metadata excludes ${field}`,
    );
  }
  for (const value of secretValues) {
    assert.equal(text.includes(value), false, `metadata excludes secret value ${value}`);
  }
}

/** @description OpenAI admin metadata returns the selected model and exact secret-free catalog. */
test("lt-openai-catalog-metadata: GET returns selected OpenAI model and exact curated catalog without secrets", async () => {
  const fixture = await seedCatalogAdmin({
    provider: "openai",
    modelId: "gpt-5.6-terra",
    suffix: "openai",
  });

  const { body, text } = await getMetadata(fixture.app, fixture.cookie);
  assert.equal(body.model_id, "gpt-5.6-terra");
  assert.deepEqual(body.models, OPENAI_MODELS);
  assertSecretFree(text, [
    fixture.plaintextKey,
    fixture.ciphertext,
    fixture.iv,
  ]);

  fixture.db.close();
});

/** @description Anthropic admin metadata returns the selected model and exact secret-free catalog. */
test("lt-anthropic-catalog-metadata: GET returns selected Anthropic model and exact curated catalog without secrets", async () => {
  const fixture = await seedCatalogAdmin({
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    suffix: "anthropic",
  });

  const { body, text } = await getMetadata(fixture.app, fixture.cookie);
  assert.equal(body.model_id, "claude-sonnet-5");
  assert.deepEqual(body.models, ANTHROPIC_MODELS);
  assertSecretFree(text, [
    fixture.plaintextKey,
    fixture.ciphertext,
    fixture.iv,
  ]);

  fixture.db.close();
});

/** @description Both provider catalogs exclude nonconversational and unknown identifiers. */
test("lt-catalog-excludes-nonconversational-models: returned arrays contain only curated conversational identifiers", async () => {
  const fixtures = [
    await seedCatalogAdmin({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      suffix: "excluded-openai",
    }),
    await seedCatalogAdmin({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      suffix: "excluded-anthropic",
    }),
  ];
  const expectedCatalogs = [OPENAI_MODELS, ANTHROPIC_MODELS];
  const excludedFamilies =
    /image|audio|moderation|embedding|realtime|transcri|fine[-_]?tun/i;

  for (const [index, fixture] of fixtures.entries()) {
    const { body } = await getMetadata(fixture.app, fixture.cookie);
    assert.deepEqual(body.models, expectedCatalogs[index]);
    assert.equal(
      body.models.some((modelId) => excludedFamilies.test(modelId)),
      false,
      "catalog excludes every nonconversational family",
    );
    assert.equal(
      body.models.includes("unknown-model"),
      false,
      "catalog excludes unknown identifiers",
    );
    fixture.db.close();
  }
});

/** @description The dashboard must not name a model the bot is no longer running. */
test("lt-retired-model-reads-as-default: a non-curated stored model is reported as the default", async () => {
  const fixture = await seedCatalogAdmin({
    provider: "openai",
    modelId: "gpt-5.6-terra",
    suffix: "retired",
  });
  fixture.db
    .prepare(`UPDATE empresa_llm_settings SET model_id = ? WHERE empresa_id = ?`)
    .run("text-embedding-3-large", "empresa-catalog-retired");

  const { body } = await getMetadata(fixture.app, fixture.cookie);

  assert.equal(
    body.model_id,
    null,
    "a model that left the catalog must read as the provider default, not as itself",
  );
  assert.equal(
    body.retired_model_id,
    "text-embedding-3-large",
    "the discarded choice must be surfaced, not silently dropped",
  );
  assert.deepEqual(
    body.models,
    OPENAI_MODELS,
    "the full catalog must still be offered so the admin can pick again",
  );
  fixture.db.close();
});
