/**
 * Locked empresa-scoped LLM provider contract — pi-ai provider registry is
 * module/isolate-scoped, keyed by provider.id, last-write-wins, with no
 * unregister. Registering a company's API key under the canonical provider
 * id (e.g. "openai") lets a sibling Durable Object in the same isolate
 * overwrite it mid-turn, billing another company for the in-flight turn.
 * buildEmpresaProviderId derives a per-empresa/per-model id so two empresas
 * never collide in the registry; createEmpresaProvider wires the API key
 * ONLY through the async auth.apiKey.resolve callback, never as a plain
 * field, so it never leaks into a serialised structure.
 * Hermetic pure unit tests; no DB, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEmpresaProviderId,
  createEmpresaProvider,
} from "../src/worker/agent/empresa-llm-provider.ts";

/** Minimal AuthContext stub satisfying pi-ai's auth.apiKey.resolve() input shape. */
const stubAuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

// ─── lt-flue2-provider-id-is-derived ───────────────────────────────────────

/**
 * @description buildEmpresaProviderId derives a per-empresa/per-model id that
 * is never the canonical provider id, is prefixed by the provider name, and
 * embeds the lowercase hex encoding of the empresaId's UTF-8 bytes.
 */
test("lt-flue2-provider-id-is-derived: provider openai, empresaId emp-A, nativeModelId gpt-4o-mini derives a non-canonical id", () => {
  const result = buildEmpresaProviderId("openai", "emp-A", "gpt-4o-mini");

  assert.notEqual(
    result,
    "openai",
    "derived provider id must never equal the canonical provider id openai",
  );
  assert.equal(
    result.startsWith("openai--"),
    true,
    "derived provider id must start with the provider name followed by --",
  );
  assert.equal(
    result.includes("656d702d41"),
    true,
    "derived provider id must contain the lowercase hex of the UTF-8 bytes of emp-A (656d702d41)",
  );
});

// ─── lt-flue2-provider-id-differs-per-empresa ──────────────────────────────

/**
 * @description The same provider and nativeModelId under two different
 * empresaIds produce two distinct derived provider ids — the assertion that
 * pins the cross-tenant collision fix itself.
 */
test("lt-flue2-provider-id-differs-per-empresa: same provider and nativeModelId under emp-A and emp-B yields two different ids", () => {
  const fromEmpresaA = buildEmpresaProviderId("openai", "emp-A", "gpt-4o-mini");
  const fromEmpresaB = buildEmpresaProviderId("openai", "emp-B", "gpt-4o-mini");

  assert.notEqual(
    fromEmpresaA,
    fromEmpresaB,
    "same provider and nativeModelId under different empresaId must produce different derived ids so one company's key never overwrites another's in the isolate-scoped registry",
  );
});

// ─── lt-flue2-api-key-only-through-resolver ────────────────────────────────

/**
 * @description The API key reaches the pi-ai provider ONLY through the
 * async auth.apiKey.resolve callback — awaiting it yields the resolved key
 * value, but no serialisation of the provider object ever contains that
 * value as a plain field.
 */
test("lt-flue2-api-key-only-through-resolver: API key is retrievable only via awaiting auth.apiKey.resolve, never as a plain serialised field", async () => {
  const secretApiKey = "sk-live-empresa-a-secret";
  const provider = createEmpresaProvider({
    provider: "openai",
    empresaId: "emp-A",
    nativeModelId: "gpt-4o-mini",
    resolveApiKey: async () => secretApiKey,
  });

  const authResult = await provider.auth.apiKey.resolve({
    ctx: stubAuthContext,
    credential: undefined,
  });

  assert.equal(
    authResult?.auth?.apiKey,
    secretApiKey,
    "awaiting provider.auth.apiKey.resolve(...) must yield an AuthResult whose auth.apiKey equals exactly the resolved secret",
  );

  let serialised;
  try {
    serialised = JSON.stringify(provider);
  } catch {
    const snapshot = {};
    for (const key of Object.keys(provider)) {
      snapshot[key] = provider[key];
    }
    serialised = JSON.stringify(snapshot);
  }

  assert.equal(
    serialised == null ? false : serialised.includes(secretApiKey),
    false,
    "no serialisation of the provider object (via JSON.stringify, directly or via a shallow own-properties snapshot) may contain the plaintext API key",
  );
});

// ─── lt-flue2-catalog-metadata-is-real ─────────────────────────────────────

/**
 * @description The provider's model catalog carries real, non-zero metadata
 * (contextWindow, maxTokens) and the model entry's provider field matches
 * the derived empresa-scoped id — proving the real catalog is used instead
 * of the beta's zero-filled metadata (max_tokens: 0) that silently broke
 * every turn.
 */
test("lt-flue2-catalog-metadata-is-real: gpt-4o-mini catalog entry has the derived provider id and non-zero contextWindow/maxTokens", () => {
  const provider = createEmpresaProvider({
    provider: "openai",
    empresaId: "emp-A",
    nativeModelId: "gpt-4o-mini",
    resolveApiKey: async () => "sk-live-empresa-a-secret",
  });
  const expectedProviderId = buildEmpresaProviderId(
    "openai",
    "emp-A",
    "gpt-4o-mini",
  );

  const models = provider.getModels();
  const modelEntry = models.find((model) => model.id === "gpt-4o-mini");

  assert.ok(
    modelEntry,
    "provider.getModels() must include an entry with id gpt-4o-mini",
  );
  assert.equal(
    modelEntry.provider,
    expectedProviderId,
    "the gpt-4o-mini catalog entry's provider field must equal the derived empresa-scoped provider id",
  );
  assert.equal(
    typeof modelEntry.contextWindow,
    "number",
    "contextWindow must be a number",
  );
  assert.equal(
    typeof modelEntry.maxTokens,
    "number",
    "maxTokens must be a number",
  );
  assert.equal(
    modelEntry.contextWindow > 0,
    true,
    "contextWindow must be strictly greater than 0 — a real catalog value, not the beta's zero-filled metadata",
  );
  assert.equal(
    modelEntry.maxTokens > 0,
    true,
    "maxTokens must be strictly greater than 0 — a real catalog value, not the beta's zero-filled max_tokens: 0 that silently broke every turn",
  );
});
