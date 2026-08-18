/**
 * Locked GESTAO_AGENT_INTERNAL_SECRET env surface.
 * Hermetic file reads only; no network.
 *
 * The Flue 2.0.3 migration (t1-build-wiring) REVOKED the beta exact-pin assertion
 * (lt-flue-deps-exact-pin), which pinned @flue/runtime/@flue/cli/agents/valibot to
 * the beta stack. The 2.0.3 exact-pin invariant now lives in
 * tests/flue2-build-wiring.test.mjs::lt-flue2-exact-pins; the 'agents' package is
 * gone entirely. Only the secret env surface assertion is retained here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORKER_INDEX_PATH = resolve(ROOT, "src/worker/index.ts");
const DEV_VARS_EXAMPLE_PATH = resolve(ROOT, ".dev.vars.example");
const WRANGLER_JSONC_PATH = resolve(ROOT, "wrangler.jsonc");

const AGENT_SECRET_KEY = "GESTAO_AGENT_INTERNAL_SECRET";

/**
 * @description Strip // and block comments from JSONC so JSON.parse can read wrangler.jsonc.
 */
function parseJsonc(raw) {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

// ─── lt-agent-secret-env-surface ───────────────────────────────────────────

/**
 * @description GESTAO_AGENT_INTERNAL_SECRET is on WorkerEnv and in .dev.vars.example; wrangler.jsonc vars must not contain it.
 */
test("lt-agent-secret-env-surface: WorkerEnv + .dev.vars.example declare secret; wrangler vars omit it", () => {
  const workerEnvSrc = readFileSync(WORKER_INDEX_PATH, "utf8");
  const devVarsExample = readFileSync(DEV_VARS_EXAMPLE_PATH, "utf8");
  const wranglerRaw = readFileSync(WRANGLER_JSONC_PATH, "utf8");

  assert.ok(
    workerEnvSrc.includes(AGENT_SECRET_KEY),
    `WorkerEnv source must declare ${AGENT_SECRET_KEY}`,
  );

  assert.ok(
    devVarsExample.includes(AGENT_SECRET_KEY),
    `.dev.vars.example must include placeholder for ${AGENT_SECRET_KEY}`,
  );
  assert.match(
    devVarsExample,
    new RegExp(`^${AGENT_SECRET_KEY}=`, "m"),
    `.dev.vars.example must have a ${AGENT_SECRET_KEY}= line`,
  );

  const wrangler = parseJsonc(wranglerRaw);
  const vars = wrangler.vars ?? {};
  assert.equal(
    Object.hasOwn(vars, AGENT_SECRET_KEY),
    false,
    `wrangler.jsonc vars must not contain ${AGENT_SECRET_KEY}`,
  );
  if (typeof vars === "object" && vars !== null) {
    assert.equal(
      Object.keys(vars).includes(AGENT_SECRET_KEY),
      false,
      `wrangler.jsonc vars keys must not include ${AGENT_SECRET_KEY}`,
    );
  }
});