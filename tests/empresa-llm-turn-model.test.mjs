/**
 * Hermetic empresa LLM turn-model resolution tests.
 * Uses in-memory SQLite with the complete lexical migration chain.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEmpresaLlmForBot } from "../src/worker/services/empresa-llm-gate.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";
import {
  getLlmModelCatalog,
  isCuratedLlmModel,
} from "../src/worker/services/llm-model-catalog.ts";
import { resolveEmpresaLlmTurnModel } from "../src/worker/services/llm-turn-model.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(TEST_DIR, "../migrations");
const ENCRYPTION_SECRET = "test-empresa-llm-turn-model-secret";
const API_KEY = "test-empresa-llm-turn-model-api-key";

/** @description Opens an in-memory database with foreign keys and all migrations applied lexically. */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, migration), "utf8"));
  }
  return db;
}

/** @description Seeds valid encrypted LLM settings for one empresa. */
async function seedValidSettings(db, { empresaId, provider, modelId }) {
  db.prepare("INSERT INTO empresas (id, nome) VALUES (?, ?)").run(
    empresaId,
    `Empresa ${empresaId}`,
  );
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    ENCRYPTION_SECRET,
    API_KEY,
  );
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, model_id, api_key_ciphertext, api_key_iv, status)
     VALUES (?, ?, ?, ?, ?, 'valid')`,
  ).run(empresaId, provider, modelId, ciphertextHex, ivHex);
}

/** @description Valid Anthropic settings resolve a configured provider-native model to its exact namespaced turn model. */
test("lt-exact-provider-namespaced-model: returns the exact Anthropic namespaced model", async () => {
  const db = openDb();
  await seedValidSettings(db, {
    empresaId: "empresa-anthropic-opus",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
  });

  const result = await loadEmpresaLlmForBot(
    db,
    "empresa-anthropic-opus",
    ENCRYPTION_SECRET,
  );

  assert.equal(result.model, "anthropic/claude-opus-4-8");
  db.close();
});

/** @description Valid OpenAI and Anthropic settings with null model identifiers resolve to the exact provider defaults. */
test("lt-provider-default-models: returns exact defaults for null model_id", async () => {
  const db = openDb();
  await seedValidSettings(db, {
    empresaId: "empresa-openai-default",
    provider: "openai",
    modelId: null,
  });
  await seedValidSettings(db, {
    empresaId: "empresa-anthropic-default",
    provider: "anthropic",
    modelId: null,
  });

  const openaiResult = await loadEmpresaLlmForBot(
    db,
    "empresa-openai-default",
    ENCRYPTION_SECRET,
  );
  const anthropicResult = await loadEmpresaLlmForBot(
    db,
    "empresa-anthropic-default",
    ENCRYPTION_SECRET,
  );

  assert.equal(openaiResult.model, "openai/gpt-4o-mini");
  assert.equal(anthropicResult.model, "anthropic/claude-sonnet-4-6");
  db.close();
});

/**
 * @description Each provider's locked default must be selectable in its own catalog. Otherwise an
 * empresa that never chose a model cannot pick the model it is actually running on, and clearing
 * the model back to the default becomes a one-way door.
 */
test("lt-catalog-contains-provider-defaults: every locked default is a curated model", () => {
  for (const provider of ["openai", "anthropic"]) {
    // Derive from the observable contract, not a test-only helper: if the resolver ever built
    // the default differently, this must fail rather than keep asserting against a parallel path.
    const namespaced = resolveEmpresaLlmTurnModel(provider, null);
    assert.equal(
      namespaced.startsWith(`${provider}/`),
      true,
      `${provider} default must be namespaced exactly once`,
    );
    const native = namespaced.slice(provider.length + 1);
    assert.equal(
      isCuratedLlmModel(provider, native),
      true,
      `${provider} default ${native} must appear in its own catalog`,
    );
  }
});

/**
 * @description An unusable stored model degrades to the locked default instead of propagating a
 * value the turn path cannot resolve — where the exception would be swallowed by the webhook and
 * the empresa's bot would go silent with no alarm.
 */
test("lt-unusable-model-degrades-to-default: blank and pre-namespaced values fall back", async () => {
  const db = openDb();
  const cases = [
    { empresaId: "empresa-blank-model", modelId: "" },
    { empresaId: "empresa-whitespace-model", modelId: "   " },
    { empresaId: "empresa-double-namespaced", modelId: "openai/gpt-5.6-sol" },
    { empresaId: "empresa-inner-space", modelId: "gpt 4o mini" },
  ];
  for (const { empresaId, modelId } of cases) {
    await seedValidSettings(db, { empresaId, provider: "openai", modelId });
  }

  for (const { empresaId, modelId } of cases) {
    const result = await loadEmpresaLlmForBot(db, empresaId, ENCRYPTION_SECRET);
    assert.equal(result.ok, true, `${empresaId} must still resolve`);
    assert.equal(
      result.model,
      "openai/gpt-4o-mini",
      `unusable model_id ${JSON.stringify(modelId)} must fall back to the default`,
    );
  }
  db.close();
});

/**
 * @description Edge whitespace is normalized and the model is USED, not discarded. Asserted with a
 * curated model that is NOT the default, so a bug that interpolated the raw value — or one that
 * degraded instead of trimming — produces a different string and fails.
 */
test("lt-edge-whitespace-model-is-trimmed-and-used: padded model resolves to its trimmed self", async () => {
  const db = openDb();
  await seedValidSettings(db, {
    empresaId: "empresa-edge-space",
    provider: "openai",
    modelId: "  gpt-5.6-sol  ",
  });

  const result = await loadEmpresaLlmForBot(db, "empresa-edge-space", ENCRYPTION_SECRET);

  assert.equal(result.ok, true);
  assert.equal(result.model, "openai/gpt-5.6-sol");
  assert.notEqual(
    result.model,
    "openai/gpt-4o-mini",
    "a trimmed usable model must NOT degrade to the default",
  );
  db.close();
});

/**
 * @description Every curated id must resolve in the runtime's own model registry.
 *
 * The catalog is a second source of truth: an id that is a real provider model but unknown to the
 * bundled registry resolves to zero metadata (`maxTokens: 0`), so the request goes out with
 * `max_tokens: 0` and an unknown model — every turn fails while the dashboard still shows the
 * model saved and the key valid.
 */
test("lt-catalog-models-resolve-in-runtime: every curated id resolves with a usable token budget", async () => {
  const { getModel } = await import("@earendil-works/pi-ai/compat");

  for (const provider of ["openai", "anthropic"]) {
    for (const modelId of getLlmModelCatalog(provider)) {
      let resolved = null;
      try {
        resolved = getModel(provider, modelId);
      } catch {
        resolved = null;
      }
      assert.ok(
        resolved,
        `${provider}/${modelId} is offered to admins but does not resolve in the runtime registry`,
      );
      assert.ok(
        Number(resolved.maxTokens) > 0,
        `${provider}/${modelId} resolves with a zero token budget`,
      );
      // The registration transports only api/baseUrl/maxTokens/contextWindow, so a model whose
      // per-model constraints are load-bearing cannot be offered: they are silently dropped.
      assert.ok(
        typeof resolved.api === "string" && resolved.api.length > 0,
        `${provider}/${modelId} has no api to transport`,
      );
      assert.ok(
        typeof resolved.baseUrl === "string" && resolved.baseUrl.length > 0,
        `${provider}/${modelId} has no baseUrl to transport`,
      );
      // Deliberately NOT asserted here: that the model carries no `compat`. It is the real loss
      // under a per-empresa provider id, but guarding on it would evict the locked default
      // `claude-sonnet-4-6` — an operator decision, escalated rather than taken. See AGENTS.md.
    }
  }
});

/**
 * @description A model that LEFT the catalog degrades to the locked default at read time.
 *
 * The value is well-FORMED, so the format guard passes it through — but the runtime registry no
 * longer knows it, and an unknown id resolves to zero metadata: every turn would fail while the
 * dashboard still showed the model saved and the key valid. Distinct from
 * `lt-unusable-model-degrades-to-default`, which only covers MALFORMED values.
 */
test("lt-retired-model-degrades-in-gate: a well-formed non-curated model falls back", async () => {
  const db = openDb();
  await seedValidSettings(db, {
    empresaId: "empresa-retired",
    provider: "openai",
    modelId: "text-embedding-3-large",
  });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let result;
  try {
    result = await loadEmpresaLlmForBot(db, "empresa-retired", ENCRYPTION_SECRET);
  } finally {
    console.warn = realWarn;
  }

  // The degrade must be observable: every sibling degrade on this path logs, and without one the
  // operator cannot correlate "why did the bot change model".
  const degrade = warnings
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.reason === "stored_model_left_catalog");
  assert.equal(degrade.length, 1, "the catalog degrade must emit exactly one structured warning");
  assert.equal(degrade[0].op, "loadEmpresaLlmForBot");
  for (const line of warnings) {
    assert.doesNotMatch(line, /api_key|ciphertext|sk-/i, "the warning must not carry key material");
  }

  assert.equal(result.ok, true);
  assert.equal(
    result.model,
    "openai/gpt-4o-mini",
    "a model no longer in the catalog must degrade to the locked default",
  );
  assert.notEqual(result.model, "openai/text-embedding-3-large");
  db.close();
});
