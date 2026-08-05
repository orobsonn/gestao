/**
 * Locked LLM key crypto contract — AES-256-GCM encrypt/decrypt + .dev.vars.example placeholder.
 * Pure service tests; no network, no DB.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decryptLlmApiKey,
  encryptLlmApiKey,
} from "../src/worker/services/llm-key-crypto.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_VARS_EXAMPLE_PATH = resolve(__dirname, "../.dev.vars.example");

const HEX_RE = /^[0-9a-f]+$/;

// ─── lt-encrypt-decrypt-roundtrip ──────────────────────────────────────────

/**
 * @description Given secret S and plaintext api key K, encrypt then decrypt with S yields K exactly.
 */
test("lt-encrypt-decrypt-roundtrip: encrypt then decrypt with same secret equals plaintext K", async () => {
  const secret = "test-llm-key-encryption-secret-S";
  const plaintext = "sk-test-api-key-K-roundtrip";

  const { ciphertextHex, ivHex } = await encryptLlmApiKey(secret, plaintext);

  assert.equal(typeof ciphertextHex, "string");
  assert.equal(typeof ivHex, "string");
  assert.ok(ciphertextHex.length > 0, "ciphertextHex non-empty");
  assert.ok(ivHex.length > 0, "ivHex non-empty");
  assert.match(ciphertextHex, HEX_RE, "ciphertextHex is lowercase hex");
  assert.match(ivHex, HEX_RE, "ivHex is lowercase hex");

  const decrypted = await decryptLlmApiKey(secret, ciphertextHex, ivHex);
  assert.equal(decrypted, plaintext);
});

// ─── lt-decrypt-wrong-secret-fails ─────────────────────────────────────────

/**
 * @description Ciphertext produced with secret S1 fails closed when decrypted with different secret S2 (throws; no plaintext).
 */
test("lt-decrypt-wrong-secret-fails: decrypt with S2 throws and does not return original plaintext", async () => {
  const secretS1 = "secret-S1-correct-material";
  const secretS2 = "secret-S2-different-material";
  const plaintext = "sk-original-plaintext-must-not-leak";

  const { ciphertextHex, ivHex } = await encryptLlmApiKey(secretS1, plaintext);

  await assert.rejects(
    async () => decryptLlmApiKey(secretS2, ciphertextHex, ivHex),
    (err) => {
      assert.ok(err != null, "must throw/reject");
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(
        !msg.includes(plaintext),
        "error must not contain original plaintext",
      );
      return true;
    },
  );

  // Confirm wrong-secret path never resolves to the original key.
  let leaked = null;
  try {
    leaked = await decryptLlmApiKey(secretS2, ciphertextHex, ivHex);
  } catch {
    leaked = null;
  }
  assert.notEqual(leaked, plaintext, "must not return original plaintext");
});

// ─── lt-ciphertext-not-plaintext ───────────────────────────────────────────

/**
 * @description Encrypt output ciphertext hex is not equal to K and does not contain K as a substring.
 */
test("lt-ciphertext-not-plaintext: ciphertext hex ≠ K and does not contain K", async () => {
  const secret = "test-llm-key-encryption-secret-S";
  const plaintext = "sk-visible-plaintext-K-must-not-appear";

  const { ciphertextHex, ivHex } = await encryptLlmApiKey(secret, plaintext);

  assert.notEqual(ciphertextHex, plaintext, "ciphertext must not equal plaintext K");
  assert.ok(
    !ciphertextHex.includes(plaintext),
    "ciphertext must not contain plaintext K as substring",
  );
  assert.notEqual(ivHex, plaintext, "iv must not equal plaintext K");
  assert.ok(!ivHex.includes(plaintext), "iv must not contain plaintext K");
});

// ─── lt-empty-secret-rejected ──────────────────────────────────────────────

/**
 * @description Empty or whitespace-only secret causes encrypt to throw/reject before producing ciphertext.
 */
test("lt-empty-secret-rejected: empty/whitespace secret encrypt throws", async () => {
  const plaintext = "sk-should-never-be-encrypted-without-secret";

  await assert.rejects(
    async () => encryptLlmApiKey("", plaintext),
    (err) => {
      assert.ok(err != null, "empty secret must throw/reject");
      return true;
    },
  );

  await assert.rejects(
    async () => encryptLlmApiKey("   ", plaintext),
    (err) => {
      assert.ok(err != null, "whitespace-only secret must throw/reject");
      return true;
    },
  );

  await assert.rejects(
    async () => encryptLlmApiKey("\t\n", plaintext),
    (err) => {
      assert.ok(err != null, "tab/newline-only secret must throw/reject");
      return true;
    },
  );
});

// ─── lt-dev-vars-example-placeholder ───────────────────────────────────────

/**
 * @description .dev.vars.example contains LLM_KEY_ENCRYPTION_SECRET= with empty value and no real-looking secret.
 */
test("lt-dev-vars-example-placeholder: LLM_KEY_ENCRYPTION_SECRET= empty, no real secret", () => {
  const content = readFileSync(DEV_VARS_EXAMPLE_PATH, "utf8");

  assert.match(
    content,
    /^LLM_KEY_ENCRYPTION_SECRET=/m,
    "contains LLM_KEY_ENCRYPTION_SECRET= placeholder line",
  );

  const secretLine = content.match(/^LLM_KEY_ENCRYPTION_SECRET=(.*)$/m);
  assert.ok(secretLine, "LLM_KEY_ENCRYPTION_SECRET line parseable");

  const secretVal = secretLine[1].trim();
  assert.equal(
    secretVal,
    "",
    "LLM_KEY_ENCRYPTION_SECRET value must be empty placeholder",
  );

  // No real-looking secret on that line (long hex/base64-ish tokens).
  assert.ok(
    !/LLM_KEY_ENCRYPTION_SECRET=\s*[A-Za-z0-9+/=_-]{16,}/m.test(content),
    "must not embed a real-looking secret value",
  );
});
