/**
 * Locked deploy composition: Flue agent mount ordering before the ASSETS catch-all,
 * the Telegram webhook dispatch with its LD-21 deps, and the agent secret guard.
 * Source-inspection style (hermetic file reads); the guard test invokes the agent
 * module for the 403 contract.
 *
 * The Flue 2.0.3 migration (t1-build-wiring) REVOKED two assertions that pinned the
 * retired Vite-owned worker entry and the `flue build` deploy step:
 *   - lt-wrangler-assets-and-main   (wrangler main + additive DO migration)
 *   - lt-deploy-script-runs-flue-build (deploy/build includes a flue build step)
 * Flue 2.0.3 now generates the worker entry and DO bindings via flueWorkerConfig();
 * `scripts/deploy-gestao.mjs` is retired in favor of plain `wrangler deploy`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORKER_INDEX_PATH = resolve(ROOT, "src/worker/index.ts");
const FLUE_APP_PATH = resolve(ROOT, ".flue/app.ts");
const GESTAO_BOT_AGENT_PATH = resolve(ROOT, ".flue/agents/gestao-bot.ts");

const ASSETS_CATCHALL_RE = /app\.all\(\s*['"`]\*['"`]\s*,/;
const SECRET_HEADER = "x-gestao-agent-internal-secret";
const AGENT_SECRET_ENV = "GESTAO_AGENT_INTERNAL_SECRET";

/**
 * @description Index of first flue()/agents mount marker in source, or -1.
 * @param {string} src
 */
function flueMountIndex(src) {
  const markers = [
    /flue\s*\(/,
    /from\s+['"]@flue\/runtime['"]/,
    /['"`]\/agents/,
    /\/agents\//,
    /routeAgentRequest/,
    /mountFlue|flueRoutes|flueApp|\.flue\/app/,
  ];
  let best = -1;
  for (const re of markers) {
    const m = re.exec(src);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

/**
 * @description Index of ASSETS catch-all app.all('*') in source, or -1.
 * @param {string} src
 */
function assetsCatchallIndex(src) {
  const m = ASSETS_CATCHALL_RE.exec(src);
  return m ? m.index : -1;
}

/**
 * @description True when body looks like a successful agent turn payload (must NOT appear on 403).
 * @param {string} bodyText
 */
function looksLikeSuccessfulAgentTurn(bodyText) {
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
    if (
      bodyText.length > 40 &&
      !/forbidden|unauthorized|secret|negad/i.test(bodyText)
    ) {
      return true;
    }
  }
  return false;
}

// ─── lt-flue-mount-before-assets-catchall ──────────────────────────────────

/**
 * @description flue() or /agents route mounting appears textually before the ASSETS catch-all app.all('*') so agent HTTP is not swallowed by SPA assets.
 */
test("lt-flue-mount-before-assets-catchall: flue/agents mount before app.all('*') ASSETS", () => {
  const indexSrc = readFileSync(WORKER_INDEX_PATH, "utf8");
  const flueAppSrc = existsSync(FLUE_APP_PATH)
    ? readFileSync(FLUE_APP_PATH, "utf8")
    : "";

  // Composition surface: worker entry must participate in flue mount ordering.
  const combined = indexSrc + "\n" + flueAppSrc;
  const catchallIdx = assetsCatchallIndex(indexSrc);
  assert.ok(
    catchallIdx >= 0,
    "src/worker/index.ts must still register ASSETS catch-all via app.all('*')",
  );

  // Prefer mount markers in index.ts (actual registration order); fall back to combined.
  let mountIdx = flueMountIndex(indexSrc);
  if (mountIdx < 0 && flueAppSrc) {
    // .flue/app.ts may define the app; index must still import/mount it before catch-all.
    const importsFlueApp =
      /from\s+['"][^'"]*\.flue\/app['"]/.test(indexSrc) ||
      /from\s+['"][^'"]*flue\/app['"]/.test(indexSrc) ||
      /flue\s*\(/.test(indexSrc) ||
      /\/agents/.test(indexSrc) ||
      /routeAgentRequest/.test(indexSrc) ||
      /mount.*[Ff]lue|[Ff]lue.*mount|flueApp|flueRoutes/.test(indexSrc);
    assert.ok(
      importsFlueApp || flueMountIndex(flueAppSrc) >= 0,
      "flue() or /agents routes must be mounted from index.ts and/or .flue/app.ts",
    );
    // If index imports/wires flue before catch-all, treat import site as mount order.
    const wireRe =
      /from\s+['"][^'"]*\.flue\/app['"]|from\s+['"][^'"]*flue\/app['"]|flue\s*\(|routeAgentRequest|flueApp|flueRoutes|\/agents/;
    const wireMatch = wireRe.exec(indexSrc);
    mountIdx = wireMatch ? wireMatch.index : flueMountIndex(combined);
  }

  assert.ok(
    mountIdx >= 0,
    "flue() or /agents route mounting must appear in src/worker/index.ts and/or .flue/app.ts",
  );
  assert.ok(
    mountIdx < catchallIdx,
    "flue()/agents mount must appear textually before ASSETS catch-all app.all('*') so agent HTTP is not swallowed by SPA assets",
  );

  // Catch-all must still serve ASSETS (not a bare 404).
  const afterCatchall = indexSrc.slice(catchallIdx, catchallIdx + 200);
  assert.ok(
    /ASSETS\.fetch/.test(afterCatchall) || /ASSETS/.test(afterCatchall),
    "ASSETS catch-all must still delegate to ASSETS.fetch",
  );
});

// ─── lt-index-webhook-still-mounted ────────────────────────────────────────

/**
 * @description index.ts still dispatches /api/telegram/* via createTelegramApp with LD-21 deps (botUsername, llmKeyEncryptionSecret, waitUntil from executionCtx, GESTAO_AGENT_INTERNAL_SECRET) and serves non-API via ASSETS.fetch.
 */
test("lt-index-webhook-still-mounted: createTelegramApp LD-21 deps + ASSETS for non-API", () => {
  const src = readFileSync(WORKER_INDEX_PATH, "utf8");

  assert.ok(
    /createTelegramApp/.test(src),
    "index.ts must still dispatch via createTelegramApp",
  );
  assert.ok(
    /\/api\/telegram\//.test(src) || /['"`]\/api\/telegram\/\*/.test(src),
    "index.ts must still mount /api/telegram/*",
  );

  // LD-21 deps wired into createTelegramApp call site / surrounding dispatch.
  const telegramBlockMatch = src.match(
    /createTelegramApp\s*\([\s\S]{0,1200}?\)/,
  );
  assert.ok(
    telegramBlockMatch,
    "index.ts must invoke createTelegramApp(...)",
  );
  const telegramBlock = telegramBlockMatch[0];

  assert.ok(
    /botUsername/.test(telegramBlock),
    "createTelegramApp dispatch must pass botUsername",
  );
  assert.ok(
    /llmKeyEncryptionSecret/.test(telegramBlock),
    "createTelegramApp dispatch must pass llmKeyEncryptionSecret",
  );
  assert.ok(
    /waitUntil/.test(telegramBlock),
    "createTelegramApp dispatch must pass waitUntil",
  );
  assert.ok(
    /executionCtx/.test(telegramBlock) || /executionCtx/.test(src),
    "waitUntil must come from executionCtx (c.executionCtx)",
  );
  assert.ok(
    new RegExp(AGENT_SECRET_ENV).test(telegramBlock) ||
      /agentInternalSecret/.test(telegramBlock),
    `createTelegramApp dispatch must pass ${AGENT_SECRET_ENV} (as agentInternalSecret or env read)`,
  );

  // Non-API still hits ASSETS.
  assert.ok(
    /ASSETS\.fetch/.test(src),
    "index.ts must still serve non-API via ASSETS.fetch",
  );
  assert.ok(
    ASSETS_CATCHALL_RE.test(src),
    "index.ts must keep app.all('*') ASSETS catch-all for SPA",
  );
});

// ─── lt-agent-route-secret-guard-composition ───────────────────────────────

/**
 * @description Composed worker entry mounts gestao-bot agent routes with secret guard: HTTP without internal secret → 403; with correct secret wiring, agent routes stay mounted (not stripped by ASSETS) and guard middleware is present on the agent path.
 */
test("lt-agent-route-secret-guard-composition: agent HTTP without secret → 403; secret guard present on mounted agent path", async () => {
  const indexSrc = readFileSync(WORKER_INDEX_PATH, "utf8");
  const flueAppSrc = existsSync(FLUE_APP_PATH)
    ? readFileSync(FLUE_APP_PATH, "utf8")
    : "";
  const agentSrc = existsSync(GESTAO_BOT_AGENT_PATH)
    ? readFileSync(GESTAO_BOT_AGENT_PATH, "utf8")
    : "";

  // Agent routes must be part of composition (index and/or .flue/app), not only a side file.
  const compositionSrc = `${indexSrc}\n${flueAppSrc}`;
  const agentMountedInComposition =
    /\/agents/.test(compositionSrc) ||
    /flue\s*\(/.test(compositionSrc) ||
    /routeAgentRequest/.test(compositionSrc) ||
    /gestao-bot/.test(compositionSrc) ||
    /from\s+['"][^'"]*\.flue\/app['"]/.test(indexSrc) ||
    /from\s+['"][^'"]*flue\/app['"]/.test(indexSrc);
  assert.ok(
    agentMountedInComposition,
    "composed worker entry must mount gestao-bot / flue agent routes (not stripped by ASSETS catch-all)",
  );

  // Mount order: agent path before ASSETS catch-all in index.ts.
  const catchallIdx = assetsCatchallIndex(indexSrc);
  assert.ok(catchallIdx >= 0, "ASSETS catch-all must remain in index.ts");
  const mountIdx = flueMountIndex(indexSrc);
  if (mountIdx >= 0) {
    assert.ok(
      mountIdx < catchallIdx,
      "agent routes must remain mounted before ASSETS catch-all (not stripped)",
    );
  } else {
    // Wire via .flue/app import still counts if import appears before catch-all.
    const wireMatch =
      /from\s+['"][^'"]*\.flue\/app['"]|from\s+['"][^'"]*flue\/app['"]|flueApp|flueRoutes|gestao-bot/.exec(
        indexSrc,
      );
    assert.ok(
      wireMatch && wireMatch.index < catchallIdx,
      "flue/agent composition wire must appear before ASSETS catch-all",
    );
  }

  // Secret guard middleware present on agent path (composition sources + agent module).
  const guardSurface = `${compositionSrc}\n${agentSrc}`;
  assert.ok(
    /createAgentSecretGuard/.test(guardSurface) ||
      new RegExp(SECRET_HEADER).test(guardSurface) ||
      new RegExp(AGENT_SECRET_ENV).test(guardSurface),
    "secret guard middleware must be present on the agent path (createAgentSecretGuard / secret header / env)",
  );
  assert.ok(
    /403/.test(guardSurface) || /forbidden/i.test(guardSurface),
    "agent path secret guard must fail closed with 403/forbidden semantics",
  );

  // Behavioral: agent HTTP without internal secret header → 403 (not success payload).
  assert.ok(
    existsSync(GESTAO_BOT_AGENT_PATH),
    ".flue/agents/gestao-bot.ts must exist for secret guard composition",
  );
  const { createAgentSecretGuard } = await import("../.flue/agents/gestao-bot.ts");
  assert.equal(
    typeof createAgentSecretGuard,
    "function",
    "createAgentSecretGuard must be exported for composition guard",
  );

  const configuredSecret = "test-deploy-composition-agent-secret";
  const guard = createAgentSecretGuard({
    [AGENT_SECRET_ENV]: configuredSecret,
  });
  assert.equal(typeof guard, "function", "guard factory must return a function");

  const bareReq = new Request(
    "http://localhost/agents/gestao-bot/session-composition-1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "oi" }),
    },
  );
  const denied = await Promise.resolve(guard(bareReq));
  assert.ok(denied instanceof Response, "missing secret must return Response");
  assert.equal(denied.status, 403, "agent HTTP without internal secret header → 403");
  const deniedBody = await denied.text();
  assert.equal(
    looksLikeSuccessfulAgentTurn(deniedBody),
    false,
    "403 body must not be a successful agent turn payload",
  );

  // Correct secret wiring: guard allows through (null) — routes remain usable, not ASSETS-stripped.
  const okReq = new Request(
    "http://localhost/agents/gestao-bot/session-composition-1",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SECRET_HEADER]: configuredSecret,
      },
      body: JSON.stringify({ message: "oi" }),
    },
  );
  const allowed = await Promise.resolve(guard(okReq));
  assert.equal(
    allowed,
    null,
    "with correct internal secret wiring, guard must pass (null) so agent route remains mounted/usable",
  );
});