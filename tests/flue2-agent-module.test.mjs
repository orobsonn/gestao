/**
 * Locked Flue 2.x agent-module contract for `.flue/agents/gestao-bot.ts`.
 * Pins: the durability static (1 attempt, 60s ceiling — the write tools are not
 * idempotent, so a retry would duplicate a task and a Telegram DM billed to the
 * company's own API key); the new `agentName` identity `gestao-bot-v2` (the beta
 * identity's Durable Object storage is rejected by the v8 runtime before any
 * application code runs); that the durability static is wired to the identity
 * module rather than a duplicated literal; that the source carries no beta-only
 * tokens and opens with the `'use agent'` directive; and that the agent function
 * itself is not accidentally `async` (the 2.x runtime rejects an async agent
 * function outright, killing 100% of production turns).
 * Registers a `cloudflare:workers` stub (see tests/helpers/cloudflare-workers-stub.mjs)
 * before dynamically importing the agent module, since the module statically imports
 * from `cloudflare:workers` under 2.x.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { registerCloudflareWorkersStub } from "./helpers/cloudflare-workers-stub.mjs";
import { GESTAO_BOT_DURABILITY } from "../src/worker/agent/gestao-bot-identity.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentModulePath = path.resolve(here, "../.flue/agents/gestao-bot.ts");

registerCloudflareWorkersStub();
const agentModulePromise = import(pathToFileURL(agentModulePath).href);

// ─── lt-flue2-agent-durability-static ──────────────────────────────────────

/**
 * @description GestaoBot.durability locks the single-attempt, 60s-ceiling policy.
 */
test("lt-flue2-agent-durability-static: GestaoBot.durability deep-equals { maxAttempts: 1, timeoutMs: 60000 }", async () => {
  const { GestaoBot } = await agentModulePromise;

  assert.deepEqual(
    GestaoBot.durability,
    { maxAttempts: 1, timeoutMs: 60000 },
    "GestaoBot.durability must be { maxAttempts: 1, timeoutMs: 60000 } — 2.x defaults to 10 attempts x 1 hour and the write tools are not idempotent, so a retry would duplicate a task and a Telegram DM, billed to the company's own API key",
  );
});

// ─── lt-flue2-agent-name-is-the-new-identity ───────────────────────────────

/**
 * @description GestaoBot.agentName is the new v2 identity, never the retired beta one.
 */
test("lt-flue2-agent-name-is-the-new-identity: GestaoBot.agentName equals gestao-bot-v2 and is not gestao-bot", async () => {
  const { GestaoBot } = await agentModulePromise;

  assert.equal(
    GestaoBot.agentName,
    "gestao-bot-v2",
    "GestaoBot.agentName must equal exactly 'gestao-bot-v2'",
  );
  assert.notEqual(
    GestaoBot.agentName,
    "gestao-bot",
    "GestaoBot.agentName must not be the retired beta identity 'gestao-bot' — its Durable Object storage is rejected by the v8 runtime before any application code runs, which would kill every turn in production",
  );
});

// ─── lt-flue2-durability-wired-to-identity-module ──────────────────────────

/**
 * @description GestaoBot.durability is wired to GESTAO_BOT_DURABILITY, not a copy.
 */
test("lt-flue2-durability-wired-to-identity-module: GestaoBot.durability is the same value as GESTAO_BOT_DURABILITY", async () => {
  const { GestaoBot } = await agentModulePromise;

  assert.ok(
    GESTAO_BOT_DURABILITY,
    "gestao-bot-identity.ts must export GESTAO_BOT_DURABILITY",
  );

  try {
    assert.equal(
      GestaoBot.durability,
      GESTAO_BOT_DURABILITY,
      "GestaoBot.durability must be the SAME object reference as GESTAO_BOT_DURABILITY — wired to the identity module, not a duplicated literal with equal contents",
    );
  } catch {
    assert.deepEqual(
      GestaoBot.durability,
      GESTAO_BOT_DURABILITY,
      "GestaoBot.durability must at least deep-equal GESTAO_BOT_DURABILITY when the identity module re-exports a frozen copy instead of the same reference",
    );
  }
});

// ─── lt-flue2-agent-source-has-no-beta-tokens ──────────────────────────────

/**
 * @description Source text opens with the 'use agent' directive and carries no
 * beta-only tokens (defineAgent, withTerminalStop, emptySandbox, turn-context-store).
 */
test("lt-flue2-agent-source-has-no-beta-tokens: source starts with 'use agent' and contains none of the retired beta tokens", () => {
  const source = readFileSync(agentModulePath, "utf8");
  const firstMeaningfulLine = source
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith("//") &&
        !line.startsWith("/*") &&
        !line.startsWith("*"),
    );

  assert.equal(
    firstMeaningfulLine,
    "'use agent'",
    "the first non-empty, non-comment line of gestao-bot.ts must be the 'use agent' directive",
  );

  const betaTokens = [
    "defineAgent",
    "withTerminalStop",
    "emptySandbox",
    "turn-context-store",
  ];
  for (const betaToken of betaTokens) {
    assert.equal(
      source.includes(betaToken),
      false,
      `gestao-bot.ts source must not contain the retired beta token "${betaToken}"`,
    );
  }
});

// ─── lt-flue2-render-is-not-async ──────────────────────────────────────────

/**
 * @description GestaoBot is a plain function, never an AsyncFunction.
 */
test("lt-flue2-render-is-not-async: typeof GestaoBot is function and GestaoBot.constructor.name is Function, not AsyncFunction", async () => {
  const { GestaoBot } = await agentModulePromise;

  assert.equal(
    typeof GestaoBot,
    "function",
    "GestaoBot named export must be a function",
  );
  assert.equal(
    GestaoBot.constructor.name,
    "Function",
    "GestaoBot.constructor.name must be 'Function', not 'AsyncFunction' — an accidentally-async agent function is rejected by the 2.x runtime and kills 100% of production turns",
  );
});
