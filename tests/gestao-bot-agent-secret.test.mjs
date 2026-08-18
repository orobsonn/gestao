/**
 * Locked gestao-bot agent HTTP secret guard contract.
 * Asserts middleware/guard rejects missing/wrong secret and empty env secret with 403.
 *
 * Expected production export (re-homed from .flue/agents/gestao-bot.ts):
 *   createAgentSecretGuard from ../src/worker/middleware/agent-secret-guard.ts
 *
 * Contract (Hono middleware form):
 *   createAgentSecretGuard(env) → MiddlewareHandler (c, next) => Response | void
 *   - Response status 403 when unauthorized (missing/wrong header, or env secret empty/missing)
 *   - calls next() (passes through) when header x-gestao-agent-internal-secret matches non-empty env secret
 *   - Body of 403 must not look like a successful agent turn payload
 *
 * The guard module is node-importable (no `cloudflare:` import), so it is driven
 * directly via a minimal Hono app — no composed-worker fetch needed here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createAgentSecretGuard } from "../src/worker/middleware/agent-secret-guard.ts";

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
 * @description Build a minimal Hono app with the guard mounted on the agent
 * path and a downstream marker handler that only runs on pass-through.
 * @param {Record<string, unknown>} env
 * @returns {Hono}
 */
function buildApp(env) {
  const app = new Hono();
  app.use("/agents/gestao-bot/*", createAgentSecretGuard(env));
  app.all("/agents/gestao-bot/*", (c) => c.json({ ok: true, result: "reached" }));
  return app;
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

/**
 * @description Drive the guarded app and return the response.
 * @param {Record<string, unknown>} env
 * @param {Request} request
 */
async function guardedFetch(env, request) {
  const app = buildApp(env);
  return app.fetch(request);
}

// ─── lt-agent-http-403-without-secret ──────────────────────────────────────

/**
 * @description With configured non-empty internal secret, request without secret header or with wrong secret yields 403 and body is not a successful agent turn payload.
 */
test("lt-agent-http-403-without-secret: missing or wrong secret header → 403, not success payload", async () => {
  const env = { GESTAO_AGENT_INTERNAL_SECRET: CONFIGURED_SECRET };

  const missing = await guardedFetch(env, agentRequest());
  assert.equal(missing.status, 403, "missing secret header → 403");
  const missingBody = await missing.text();
  assert.equal(
    looksLikeSuccessfulAgentTurn(missingBody),
    false,
    "403 body must not be a successful agent turn payload (missing secret)",
  );

  const wrong = await guardedFetch(
    env,
    agentRequest({ [SECRET_HEADER]: "wrong-secret-value" }),
  );
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
    const label = JSON.stringify(env);

    const noHeader = await guardedFetch(env, agentRequest());
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
    const withHeader = await guardedFetch(
      env,
      agentRequest({ [SECRET_HEADER]: "any-client-supplied-secret" }),
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