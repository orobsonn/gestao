/**
 * Locked scripts/smoke-prod.mjs contract: `runSmoke({ baseUrl, fetchImpl })` resolves a result
 * shaped `{ ok, checks: [{ name, url, method, expected, observed, passed }] }`, reports every
 * check passing when GET / is 200, GET /api/auth/me is 401 and POST /agents/gestao-bot/<id> is
 * 403 — and, critically, catches the case where the SPA ASSETS catch-all swallows the agent route
 * (POST /agents/gestao-bot/<id> observed as 200 instead of 403), naming that exact check as
 * failed with both the expected and observed status. No network — fetchImpl is a plain stub.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runSmoke } from "../scripts/smoke-prod.mjs";

const BASE_URL = "https://gestao.robsonlins.workers.dev";

/**
 * @description fetchImpl stub where every probed route reports the healthy status a working
 * deploy is expected to return.
 */
async function fetchImplAllGreen(url, init) {
  const { pathname } = new URL(url);
  const method = init?.method ?? "GET";

  if (method === "GET" && pathname === "/") {
    return new Response("ok", { status: 200 });
  }
  if (method === "GET" && pathname === "/api/auth/me") {
    return new Response("unauthorized", { status: 401 });
  }
  if (method === "POST" && pathname.startsWith("/agents/gestao-bot/")) {
    return new Response("forbidden", { status: 403 });
  }
  throw new Error(`unexpected fetch call in fetchImplAllGreen: ${method} ${pathname}`);
}

/**
 * @description fetchImpl stub where the agent route is SWALLOWED by the SPA ASSETS catch-all and
 * observed as 200 instead of the expected 403 — the exact regression this smoke exists to catch.
 */
async function fetchImplSwallowedAgentRoute(url, init) {
  const { pathname } = new URL(url);
  const method = init?.method ?? "GET";

  if (method === "GET" && pathname === "/") {
    return new Response("ok", { status: 200 });
  }
  if (method === "GET" && pathname === "/api/auth/me") {
    return new Response("unauthorized", { status: 401 });
  }
  if (method === "POST" && pathname.startsWith("/agents/gestao-bot/")) {
    return new Response("ok", { status: 200 });
  }
  throw new Error(`unexpected fetch call in fetchImplSwallowedAgentRoute: ${method} ${pathname}`);
}

// ─── lt-flue2-smoke-all-green ───────────────────────────────────────────────

test("lt-flue2-smoke-all-green: runSmoke resolves ok=true with all three checks passed", async () => {
  const result = await runSmoke({ baseUrl: BASE_URL, fetchImpl: fetchImplAllGreen });

  assert.equal(
    result.ok,
    true,
    `runSmoke must resolve ok === true when GET / is 200, GET /api/auth/me is 401 and POST /agents/gestao-bot/<id> is 403, got ${JSON.stringify(result)}`,
  );
  assert.ok(
    Array.isArray(result.checks),
    `runSmoke result must include a 'checks' array, got ${JSON.stringify(result)}`,
  );
  assert.equal(
    result.checks.length,
    3,
    `runSmoke must report exactly 3 checks (GET /, GET /api/auth/me, POST /agents/gestao-bot/<id>), got ${result.checks.length}`,
  );
  for (const check of result.checks) {
    assert.equal(
      check.passed,
      true,
      `check ${JSON.stringify(check.name)} must be reported as passed, got ${JSON.stringify(check)}`,
    );
  }
});

// ─── lt-flue2-smoke-catches-swallowed-agent-route ──────────────────────────

test("lt-flue2-smoke-catches-swallowed-agent-route: runSmoke resolves ok=false and names the agent-route check with expected 403 vs observed 200", async () => {
  const result = await runSmoke({ baseUrl: BASE_URL, fetchImpl: fetchImplSwallowedAgentRoute });

  assert.equal(
    result.ok,
    false,
    `runSmoke must resolve ok === false when the agent route is swallowed by the SPA ASSETS catch-all, got ${JSON.stringify(result)}`,
  );
  assert.ok(
    Array.isArray(result.checks),
    `runSmoke result must include a 'checks' array, got ${JSON.stringify(result)}`,
  );

  const agentCheck = result.checks.find(
    (check) =>
      check &&
      typeof check === "object" &&
      check.method === "POST" &&
      typeof check.url === "string" &&
      check.url.includes("/agents/gestao-bot/"),
  );
  assert.ok(
    agentCheck,
    `runSmoke result.checks must include a POST /agents/gestao-bot/<id> check, got ${JSON.stringify(result.checks)}`,
  );
  assert.equal(
    agentCheck.passed,
    false,
    `the agent-route check must be reported as failed (passed === false) when the SPA fallback swallowed it, got ${JSON.stringify(agentCheck)}`,
  );
  assert.equal(
    agentCheck.expected,
    403,
    `the agent-route check must record expected status 403, got ${JSON.stringify(agentCheck)}`,
  );
  assert.equal(
    agentCheck.observed,
    200,
    `the agent-route check must record observed status 200 (the SPA ASSETS catch-all swallowed the route instead of returning 403), got ${JSON.stringify(agentCheck)}`,
  );

  const otherChecks = result.checks.filter((check) => check !== agentCheck);
  assert.ok(
    otherChecks.length > 0,
    "runSmoke result.checks must include checks other than the agent-route check (GET / and GET /api/auth/me)",
  );
  for (const check of otherChecks) {
    assert.equal(
      check.passed,
      true,
      `check ${JSON.stringify(check.name)} must still be reported as passed even though the agent-route check fails, got ${JSON.stringify(check)}`,
    );
  }
});
