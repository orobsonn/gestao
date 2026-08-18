/**
 * Locked Flue 2.x agent mount guard contract.
 *
 * A mounted Flue 2.x agent has no built-in authentication: createAgentRouter
 * serves POST /:id, GET|HEAD /:id (full conversation history — a tenant-data
 * READ, not just a write surface), POST /:id/abort, and
 * GET /:id/attachments/:attachmentId per conversation. Conversation ids are
 * guessable. The beta's per-agent `export const route` middleware convention
 * was deleted in the 2.0.3 migration, so the internal-secret guard is re-homed
 * as ordinary Hono middleware registered with a `/*` suffix BEFORE the mount.
 *
 * This suite drives the REAL composed app (src/worker/index.ts) over
 * app.fetch(request, env) and asserts real status codes — it does not regex
 * for a symbol name across files.
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { registerCloudflareWorkersStub } from "./helpers/cloudflare-workers-stub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORKER_INDEX_PATH = resolve(ROOT, "src/worker/index.ts");

const SECRET_HEADER = "x-gestao-agent-internal-secret";
const CONFIGURED_SECRET = "test-secret";

/**
 * @description Minimal env stubs so an unrelated D1/ASSETS access does not
 * mask the guard's own status code with an unrelated throw. The guard itself
 * must answer before any of this is touched.
 * @param {string | undefined} secret
 */
function buildEnv(secret) {
  return {
    GESTAO_AGENT_INTERNAL_SECRET: secret,
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({}),
        };
      },
    },
    ASSETS: {
      fetch: async () => new Response("not-agent-route", { status: 404 }),
    },
  };
}

/**
 * @description True when the response body looks like a successful agent
 * turn or a conversation/history payload (must NOT appear on 403).
 * @param {string} bodyText
 */
function looksLikeConversationOrTurnPayload(bodyText) {
  if (!bodyText || bodyText.trim() === "") return false;
  const lower = bodyText.toLowerCase();
  if (
    lower.includes("error") &&
    (lower.includes("forbidden") || lower.includes("unauthorized"))
  ) {
    return false;
  }
  try {
    const json = JSON.parse(bodyText);
    if (json && typeof json === "object") {
      if (json.error != null || json.ok === false) return false;
      if (Array.isArray(json)) return true;
      if (
        Array.isArray(json.entries) ||
        Array.isArray(json.messages) ||
        Array.isArray(json.records) ||
        typeof json.conversationId === "string" ||
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
    if (
      bodyText.length > 40 &&
      !/forbidden|unauthorized|secret|negad|403/i.test(bodyText)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @description Dynamically import the real composed worker app after the
 * cloudflare:workers stub is registered (the agent module statically
 * imports it, which fails under plain node --test otherwise).
 */
async function loadApp() {
  registerCloudflareWorkersStub();
  const mod = await import("../src/worker/index.ts");
  return mod.default;
}

// ─── lt-flue2-guard-covers-every-agent-route ───────────────────────────────

/**
 * @description Every route a Flue 2.x agent mount serves for a conversation
 * (POST /:id, GET /:id, POST /:id/abort, GET /:id/attachments/:attachmentId)
 * is denied with 403 when the internal secret header is absent, and none of
 * the four responses carries a conversation-history or agent-turn payload.
 */
test("lt-flue2-guard-covers-every-agent-route: all four agent routes 403 without secret header", async () => {
  const app = await loadApp();
  const env = buildEnv(CONFIGURED_SECRET);

  const routes = [
    {
      label: "POST /:id",
      method: "POST",
      path: "/agents/gestao-bot/dm2:emp-A:1",
      body: JSON.stringify({ message: "oi" }),
    },
    {
      label: "GET /:id",
      method: "GET",
      path: "/agents/gestao-bot/dm2:emp-A:1",
      body: undefined,
    },
    {
      label: "POST /:id/abort",
      method: "POST",
      path: "/agents/gestao-bot/dm2:emp-A:1/abort",
      body: undefined,
    },
    {
      label: "GET /:id/attachments/:attachmentId",
      method: "GET",
      path: "/agents/gestao-bot/dm2:emp-A:1/attachments/a1",
      body: undefined,
    },
  ];

  for (const route of routes) {
    const request = new Request(`http://localhost${route.path}`, {
      method: route.method,
      headers: route.body ? { "content-type": "application/json" } : {},
      body: route.body,
    });
    const response = await app.fetch(request, env);
    assert.equal(
      response.status,
      403,
      `${route.label} without secret header must be 403 (got ${response.status})`,
    );
    const bodyText = await response.text();
    assert.equal(
      looksLikeConversationOrTurnPayload(bodyText),
      false,
      `${route.label} 403 body must not look like a conversation/history or agent-turn payload`,
    );
  }
});

// ─── lt-flue2-guard-passes-correct-caller-through ──────────────────────────

/**
 * @description With the correct internal secret header, the guard lets the
 * caller through instead of denying unconditionally: the response status is
 * not 403. (A downstream 500 outside a Flue-built server is expected and
 * acceptable — the point is the guard distinguishes a correct caller from an
 * incorrect one rather than 403ing everything.)
 */
test("lt-flue2-guard-passes-correct-caller-through: correct secret header is not denied by the guard", async () => {
  const app = await loadApp();
  const env = buildEnv(CONFIGURED_SECRET);

  const request = new Request(
    "http://localhost/agents/gestao-bot/dm2:emp-A:1",
    {
      method: "GET",
      headers: { [SECRET_HEADER]: CONFIGURED_SECRET },
    },
  );
  const response = await app.fetch(request, env);
  assert.notEqual(
    response.status,
    403,
    `correct secret header must not be denied by the guard (got ${response.status})`,
  );
});

// ─── lt-flue2-empty-secret-fails-closed ────────────────────────────────────

/**
 * @description When GESTAO_AGENT_INTERNAL_SECRET is the empty string, every
 * request is 403 regardless of the header value sent — including an empty
 * header and a correct-looking header. An unset secret must fail closed,
 * never open.
 */
test("lt-flue2-empty-secret-fails-closed: empty env secret always 403, any header value", async () => {
  const app = await loadApp();
  const env = buildEnv("");

  const headerValues = ["", CONFIGURED_SECRET, "wrong-secret-value"];

  for (const headerValue of headerValues) {
    const request = new Request(
      "http://localhost/agents/gestao-bot/dm2:emp-A:1",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SECRET_HEADER]: headerValue,
        },
        body: JSON.stringify({ message: "oi" }),
      },
    );
    const response = await app.fetch(request, env);
    assert.equal(
      response.status,
      403,
      `empty env secret with header ${JSON.stringify(headerValue)} must fail closed with 403 (got ${response.status})`,
    );
  }
});

// ─── lt-flue2-registration-order ───────────────────────────────────────────

/**
 * @description Source-inspection contract on src/worker/index.ts: the
 * gestao-bot guard middleware registration precedes the agent route mount,
 * which in turn precedes the ASSETS catch-all — and the retired beta
 * registration shapes (a direct app.post('/agents ...) route, or a flue()
 * mount) are absent. Every indexOf result is guarded against -1 so a missing
 * string fails the assertion rather than silently satisfying a < comparison.
 */
test("lt-flue2-registration-order: guard before agent mount before ASSETS catch-all, no beta shapes", () => {
  const src = readFileSync(WORKER_INDEX_PATH, "utf8");

  /**
   * @description indexOf a required needle, failing (not silently -1) when absent.
   * @param {string} needle
   * @param {string} label
   */
  function requireIndex(needle, label) {
    const idx = src.indexOf(needle);
    assert.notEqual(idx, -1, `${label} must be present in src/worker/index.ts`);
    return idx;
  }

  const guardIdx = requireIndex(
    "app.use('/agents/gestao-bot/*'",
    "the gestao-bot guard middleware registration (app.use('/agents/gestao-bot/*', ...))",
  );
  const mountIdx = requireIndex(
    "app.route('/agents/gestao-bot'",
    "the gestao-bot agent route mount (app.route('/agents/gestao-bot', ...))",
  );
  const assetsIdx = requireIndex(
    "app.all('*'",
    "the ASSETS catch-all (app.all('*', ...))",
  );

  assert.ok(
    guardIdx < mountIdx,
    "the guard middleware must be registered before the gestao-bot agent route mount",
  );
  assert.ok(
    mountIdx < assetsIdx,
    "the gestao-bot agent route mount must be registered before the ASSETS catch-all",
  );

  assert.equal(
    src.includes("app.post('/agents"),
    false,
    "index.ts must not register a direct app.post('/agents ...) route (retired beta shape)",
  );
  assert.equal(
    src.includes("flue()"),
    false,
    "index.ts must not mount flue() directly (retired beta shape)",
  );
});
