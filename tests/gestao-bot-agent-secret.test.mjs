/**
 * Locked gestao-bot agent HTTP secret guard contract.
 * Asserts middleware/guard rejects missing/wrong secret and empty env secret with 403.
 *
 * Expected production export (executor creates):
 *   createAgentSecretGuard from ../.flue/agents/gestao-bot.ts
 *
 * Contract:
 *   createAgentSecretGuard(env) → async (request: Request) => Response | null
 *   - Response status 403 when unauthorized (missing/wrong header, or env secret empty/missing)
 *   - null when header x-gestao-agent-internal-secret matches non-empty env secret
 *   Body of 403 must not look like a successful agent turn payload
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSecretGuard } from "../.flue/agents/gestao-bot.ts";

const SECRET_HEADER = "x-gestao-agent-internal-secret";
const AGENT_PATH = "http://localhost/agents/gestao-bot/session-test-1";
const CONFIGURED_SECRET = "test-gestao-agent-internal-secret-hermetic";

/**
 * @description True when body looks like a successful agent turn payload (must NOT appear on 403).
 * @param {string} bodyText
 */
function looksLikeSuccessfulAgentTurn(bodyText) {
  if (!bodyText || bodyText.trim() === "") return false;
  const lower = bodyText.toLowerCase();
  if (lower.includes("error") && (lower.includes("forbidden") || lower.includes("unauthorized"))) {
    return false;
  }
  try {
    const json = JSON.parse(bodyText);
    if (json && typeof json === "object") {
      if (json.error != null || json.ok === false) return false;
      if (
        typeof json.result === "string" ||
        typeof json.message === "string" ||
        typeof json.output === "string" ||
        typeof json.text === "string" ||
        json.status === "ok" ||
        json.ok === true
      ) {
        return true;
      }
    }
  } catch {
    // non-JSON body: treat long non-error prose as potential success payload
    if (bodyText.length > 40 && !/forbidden|unauthorized|secret|negad/i.test(bodyText)) {
      return true;
    }
  }
  return false;
}

/**
 * @description Invoke guard; supports Promise or sync Response|null.
 * @param {(req: Request) => unknown} guard
 * @param {Request} request
 * @returns {Promise<Response | null | undefined>}
 */
async function invokeGuard(guard, request) {
  assert.equal(typeof guard, "function", "createAgentSecretGuard must return a function guard");
  const out = await Promise.resolve(guard(request));
  return /** @type {Response | null | undefined} */ (out);
}

/**
 * @description Build a POST Request to the gestao-bot agent path.
 * @param {HeadersInit} [headers]
 * @param {string} [body]
 */
function agentRequest(headers = {}, body = JSON.stringify({ message: "oi" })) {
  return new Request(AGENT_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

// ─── lt-agent-http-403-without-secret ──────────────────────────────────────

/**
 * @description With configured non-empty internal secret, request without secret header or with wrong secret yields 403 and body is not a successful agent turn payload.
 */
test("lt-agent-http-403-without-secret: missing or wrong secret header → 403, not success payload", async () => {
  const env = { GESTAO_AGENT_INTERNAL_SECRET: CONFIGURED_SECRET };
  const guard = createAgentSecretGuard(env);

  const missing = await invokeGuard(guard, agentRequest());
  assert.ok(missing instanceof Response, "missing secret must return Response");
  assert.equal(missing.status, 403, "missing secret header → 403");
  const missingBody = await missing.text();
  assert.equal(
    looksLikeSuccessfulAgentTurn(missingBody),
    false,
    "403 body must not be a successful agent turn payload (missing secret)",
  );

  const wrong = await invokeGuard(
    guard,
    agentRequest({ [SECRET_HEADER]: "wrong-secret-value" }),
  );
  assert.ok(wrong instanceof Response, "wrong secret must return Response");
  assert.equal(wrong.status, 403, "wrong secret header → 403");
  const wrongBody = await wrong.text();
  assert.equal(
    looksLikeSuccessfulAgentTurn(wrongBody),
    false,
    "403 body must not be a successful agent turn payload (wrong secret)",
  );
});

// ─── lt-agent-http-403-empty-env-secret ────────────────────────────────────

/**
 * @description When GESTAO_AGENT_INTERNAL_SECRET is missing or empty string, any request to gestao-bot agent path is always 403 (fail closed), body not a successful agent turn payload.
 */
test("lt-agent-http-403-empty-env-secret: missing or empty env secret → always 403", async () => {
  /** @type {Array<Record<string, string | undefined>>} */
  const emptyEnvs = [
    {},
    { GESTAO_AGENT_INTERNAL_SECRET: "" },
    { GESTAO_AGENT_INTERNAL_SECRET: "   " },
  ];

  for (const env of emptyEnvs) {
    const guard = createAgentSecretGuard(env);
    const label = JSON.stringify(env);

    const noHeader = await invokeGuard(guard, agentRequest());
    assert.ok(
      noHeader instanceof Response,
      `empty env (${label}) without header must return Response`,
    );
    assert.equal(
      noHeader.status,
      403,
      `empty/missing env secret must always 403 (no header); env=${label}`,
    );
    assert.equal(
      looksLikeSuccessfulAgentTurn(await noHeader.text()),
      false,
      `403 body must not be success payload; env=${label}`,
    );

    // Even a non-empty header must not open the agent when env secret is empty/missing
    const withHeader = await invokeGuard(
      guard,
      agentRequest({ [SECRET_HEADER]: "any-client-supplied-secret" }),
    );
    assert.ok(
      withHeader instanceof Response,
      `empty env (${label}) with header must return Response`,
    );
    assert.equal(
      withHeader.status,
      403,
      `empty/missing env secret must always 403 (with header); env=${label}`,
    );
    assert.equal(
      looksLikeSuccessfulAgentTurn(await withHeader.text()),
      false,
      `403 body must not be success payload with header; env=${label}`,
    );
  }
});
