/**
 * Locked Flue dependency pins + GESTAO_AGENT_INTERNAL_SECRET env surface.
 * Hermetic file reads only; no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");
const WORKER_INDEX_PATH = resolve(ROOT, "src/worker/index.ts");
const DEV_VARS_EXAMPLE_PATH = resolve(ROOT, ".dev.vars.example");
const WRANGLER_JSONC_PATH = resolve(ROOT, "wrangler.jsonc");

/** @description Exact versions pinned for the Flue/agents stack (no caret/tilde). */
const EXACT_PINS = {
  "@flue/runtime": "1.0.0-beta.9",
  "@flue/cli": "1.0.0-beta.9",
  agents: "0.14.5",
  valibot: "1.4.2",
};

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

/**
 * @description Resolve a package version from dependencies or devDependencies.
 */
function resolveDepVersion(pkg, name) {
  const fromDeps = pkg.dependencies?.[name];
  const fromDev = pkg.devDependencies?.[name];
  if (fromDeps != null && fromDev != null) {
    assert.equal(
      fromDeps,
      fromDev,
      `${name} must not disagree between dependencies and devDependencies`,
    );
  }
  return fromDeps ?? fromDev;
}

// ─── lt-flue-deps-exact-pin ────────────────────────────────────────────────

/**
 * @description package.json pins @flue/runtime, @flue/cli, agents, and valibot to exact versions with no caret/tilde ranges.
 */
test("lt-flue-deps-exact-pin: @flue/runtime, @flue/cli, agents, valibot exact pins", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));

  for (const [name, expected] of Object.entries(EXACT_PINS)) {
    const version = resolveDepVersion(pkg, name);
    assert.ok(
      version != null,
      `${name} must be declared in package.json dependencies or devDependencies`,
    );
    assert.equal(
      typeof version,
      "string",
      `${name} version must be a string`,
    );
    assert.equal(
      version,
      expected,
      `${name} must be exactly ${expected} (got ${version})`,
    );
    assert.equal(
      version.startsWith("^"),
      false,
      `${name} must not use a caret range`,
    );
    assert.equal(
      version.startsWith("~"),
      false,
      `${name} must not use a tilde range`,
    );
    assert.equal(
      /^[\^~]/.test(version),
      false,
      `${name} must not start with a semver range prefix`,
    );
  }
});

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
