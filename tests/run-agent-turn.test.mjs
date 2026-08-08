/**
 * Locked runAgentTurn + buildAgentIdentityPrompt contract.
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 *
 * Expected production exports (executor creates):
 *   buildAgentIdentityPrompt, runAgentTurn from ../src/worker/agent/run-agent-turn.ts
 *   insertTurnContext from ../src/worker/agent/turn-context-store.ts (for seeding gated row)
 *
 * runAgentTurn injectable app.fetch loopback; never throws — SAFE_REPLY pt-br on failure.
 * POST /agents/gestao-bot/<sessionId>?wait=result with body {message} only + secret + turn-token headers.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildAgentIdentityPrompt,
  runAgentTurn,
} from "../src/worker/agent/run-agent-turn.ts";
import { insertTurnContext } from "../src/worker/agent/turn-context-store.ts";
import { encryptLlmApiKey } from "../src/worker/services/llm-key-crypto.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const TEST_ENCRYPTION_SECRET = "test-llm-key-encryption-secret-run-agent-turn";
const AGENT_SECRET = "test-gestao-agent-internal-secret-run-turn";
const SECRET_HEADER = "x-gestao-agent-internal-secret";
const TURN_TOKEN_HEADER = "x-gestao-turn-token";

/**
 * @description Open in-memory SQLite, enable FKs, apply every migrations/*.sql sorted by filename.
 * @returns {DatabaseSync}
 */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
    db.exec(sql);
  }
  return db;
}

/**
 * @description Seed a minimal users row (dummy hash/salt — FK parent only).
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string }} [opts]
 */
function seedUser(db, opts = {}) {
  const id = opts.id ?? "user-run-turn-1";
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Run Turn User";
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, "hash", "salt");
  return { id, email, name };
}

/**
 * @description Seed a minimal empresas row.
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? "emp-run-turn-a";
  const nome = opts.nome ?? "Empresa Run Turn";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  return { id, nome };
}

/**
 * @description Seed a live expert row.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, id?: string, nome?: string }} opts
 */
function seedExpert(db, opts) {
  const id = opts.id ?? "expert-run-turn-e";
  const nome = opts.nome ?? "Expert Run Turn";
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, opts.empresaId, nome);
  return { id, nome, empresaId: opts.empresaId };
}

/**
 * @description True when string looks like non-empty pt-br safe reply (not empty, has letters).
 * @param {unknown} value
 */
function isNonEmptyPtBrSafeReply(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (t.length === 0) return false;
  // pt-br safe copy: accented chars and/or common Portuguese tokens
  return (
    /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(t) ||
    /\b(n[aã]o|consegui|tente|agora|desculpe|erro|indispon|falha|aguarde|depois)\b/i.test(
      t,
    )
  );
}

// ─── lt-minimal-identity-no-task-dump ──────────────────────────────────────

/**
 * @description buildAgentIdentityPrompt includes identity fields and does not dump full task list or tarefa titulos from DB.
 */
test("lt-minimal-identity-no-task-dump: identity fields present; no serialized full task list or titulo dumps", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-identity-a", nome: "Empresa Identity" });
  const user = seedUser(db, { id: "user-identity-1", name: "Identity User" });
  const expert = seedExpert(db, {
    id: "expert-identity-e",
    empresaId: emp.id,
    nome: "Expert Identity",
  });

  // Empty task table (no tarefas rows) — identity must still work and must not invent dumps
  const taskCount = db.prepare(`SELECT count(*) AS n FROM tarefas`).get();
  assert.equal(Number(taskCount?.n ?? -1), 0, "tarefas table must be empty for this test");

  const identity = {
    empresaId: emp.id,
    expertId: expert.id,
    userId: user.id,
    surface: /** @type {const} */ ("topic"),
    activeEmpresaId: emp.id,
  };

  // Contract: buildAgentIdentityPrompt({ empresaId, expertId, userId, surface, activeEmpresaId })
  // Optional db may be accepted but must never dump task lists/titulos.
  const prompt = buildAgentIdentityPrompt(identity);

  assert.equal(typeof prompt, "string", "buildAgentIdentityPrompt must return a string");
  assert.ok(prompt.length > 0, "identity prompt must be non-empty");

  // Identity fields present (ids appear in prompt)
  assert.ok(
    prompt.includes(identity.empresaId),
    "prompt must include empresaId",
  );
  assert.ok(
    prompt.includes(identity.expertId),
    "prompt must include expertId",
  );
  assert.ok(
    prompt.includes(identity.userId),
    "prompt must include userId",
  );
  assert.ok(
    /topic/i.test(prompt) || prompt.includes(identity.surface),
    "prompt must include surface",
  );
  assert.ok(
    prompt.includes(identity.activeEmpresaId),
    "prompt must include activeEmpresaId",
  );

  // Must NOT include a serialized full task list or tarefa titulo dumps from DB
  assert.equal(
    /"tarefas"\s*:/.test(prompt) ||
      /tarefas\s*:\s*\[/.test(prompt) ||
      /full\s*task\s*list/i.test(prompt),
    false,
    "prompt must not include a serialized full task list",
  );

  // Seed a decoy titulo; re-call with optional db if supported — must still not dump.
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, 'Camp', 'gratuito', 'aberta')`,
  ).run("camp-identity-1", emp.id, expert.id);
  const decoyTitulo = "TITULO-DECOY-NAO-DEVE-APARECER-NO-PROMPT-xyz";
  db.prepare(
    `INSERT INTO tarefas
       (id, empresa_id, campanha_id, titulo, notas, status, created_by)
     VALUES (?, ?, ?, ?, '', 'a_fazer', ?)`,
  ).run("tar-identity-1", emp.id, "camp-identity-1", decoyTitulo, user.id);

  const promptWithTasks = buildAgentIdentityPrompt({ ...identity, db });
  assert.equal(
    promptWithTasks.includes(decoyTitulo),
    false,
    "prompt must not dump tarefa titulo from DB",
  );
  assert.equal(
    /TITULO-DECOY/i.test(promptWithTasks),
    false,
    "prompt must not include decoy task titulo fragments",
  );

  db.close();
});

// ─── lt-run-agent-turn-request-body-shape ──────────────────────────────────

/**
 * @description runAgentTurn POSTs Flue-legal body {message} only with secret + turn-token headers; D1 turn row holds gated fields.
 */
test("lt-run-agent-turn-request-body-shape: path/headers/body {message} only; D1 holds gated fields", async () => {
  const db = openDb();
  const emp = seedEmpresa(db, { id: "emp-body-a", nome: "Empresa Body" });
  const user = seedUser(db, { id: "user-body-1", name: "Body User" });
  const expert = seedExpert(db, {
    id: "expert-body-e",
    empresaId: emp.id,
  });

  const plaintextKey = "sk-test-run-agent-turn-body-shape";
  const sessionId = "topic:-1001:42";
  const message = "criar tarefa de teste";

  const inserted = await insertTurnContext(db, {
    empresaId: emp.id,
    expertId: expert.id,
    actorUserId: user.id,
    surface: "topic",
    provider: "openai",
    apiKey: plaintextKey,
    message,
    encryptionSecret: TEST_ENCRYPTION_SECRET,
  });

  const turnToken =
    inserted?.turn_token ??
    inserted?.turnToken ??
    (typeof inserted === "string" ? inserted : null);
  assert.ok(
    typeof turnToken === "string" && turnToken.length > 0,
    "insertTurnContext must return turn_token",
  );

  /** @type {Request | null} */
  let capturedRequest = null;
  const mockApp = {
    /**
     * @param {Request | string} input
     * @param {RequestInit} [init]
     */
    fetch: async (input, init) => {
      capturedRequest =
        input instanceof Request
          ? input
          : new Request(String(input), init);
      return new Response(JSON.stringify({ result: "ok mock" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };

  await runAgentTurn({
    sessionId,
    message,
    turnToken,
    agentInternalSecret: AGENT_SECRET,
    app: mockApp,
    // gated identity (must NOT appear in JSON body — only in D1 / headers path)
    empresaId: emp.id,
    expertId: expert.id,
    userId: user.id,
    surface: "topic",
    provider: "openai",
    apiKey: plaintextKey,
    db,
  });

  assert.ok(capturedRequest instanceof Request, "app.fetch must receive a Request");
  const url = new URL(capturedRequest.url);
  assert.equal(
    url.pathname,
    `/agents/gestao-bot/${sessionId}`,
    "POST path must be /agents/gestao-bot/<sessionId>",
  );
  assert.equal(url.searchParams.get("wait"), "result", "query must include wait=result");
  assert.equal(
    capturedRequest.headers.get(SECRET_HEADER),
    AGENT_SECRET,
    "header x-gestao-agent-internal-secret must be set",
  );
  assert.equal(
    capturedRequest.headers.get(TURN_TOKEN_HEADER),
    turnToken,
    "header x-gestao-turn-token must be set",
  );

  const rawBody = await capturedRequest.text();
  const bodyJson = JSON.parse(rawBody);
  assert.ok(bodyJson && typeof bodyJson === "object", "body must be JSON object");
  const keys = Object.keys(bodyJson).sort();
  assert.deepEqual(
    keys,
    ["message"],
    "JSON body keys must be exactly {message}",
  );
  assert.equal(bodyJson.message, message);

  // Forbidden keys must not appear in body
  for (const forbidden of [
    "empresa_id",
    "empresaId",
    "apiKey",
    "api_key",
    "bot_token",
    "botToken",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(bodyJson, forbidden),
      false,
      `JSON body must not include ${forbidden}`,
    );
  }

  // Turn row in D1 holds gated fields
  const row = db
    .prepare(
      `SELECT turn_token, empresa_id, expert_id, actor_user_id, surface, provider,
              api_key_ciphertext, api_key_iv, message
       FROM telegram_agent_turn_context WHERE turn_token = ?`,
    )
    .get(turnToken);
  assert.ok(row, "turn row must exist in D1");
  assert.equal(row.empresa_id, emp.id);
  assert.equal(row.expert_id, expert.id);
  assert.equal(row.actor_user_id, user.id);
  assert.equal(row.surface, "topic");
  assert.equal(row.provider, "openai");
  assert.equal(row.message, message);
  assert.equal(typeof row.api_key_ciphertext, "string");
  assert.ok(row.api_key_ciphertext.length > 0, "api_key_ciphertext must be non-empty");
  assert.equal(typeof row.api_key_iv, "string");
  assert.ok(row.api_key_iv.length > 0, "api_key_iv must be non-empty");
  assert.notEqual(
    row.api_key_ciphertext,
    plaintextKey,
    "ciphertext must not equal plaintext apiKey",
  );

  // Sanity: encrypt shape matches encryptLlmApiKey pair (hex-ish non-empty)
  const sample = await encryptLlmApiKey(TEST_ENCRYPTION_SECRET, "x");
  assert.equal(typeof sample.ciphertextHex, "string");
  assert.equal(typeof sample.ivHex, "string");

  db.close();
});

// ─── lt-run-agent-turn-safe-on-failure ─────────────────────────────────────

/**
 * @description When injected fetch/app throws or returns non-2xx, runAgentTurn resolves to non-empty pt-br safe reply and does not throw.
 */
test("lt-run-agent-turn-safe-on-failure: throw or non-2xx → non-empty pt-br safe reply, no throw", async () => {
  const sessionId = "dm:user-safe-1";
  const baseArgs = {
    sessionId,
    message: "oi",
    turnToken: "turn-token-safe-fail",
    agentInternalSecret: AGENT_SECRET,
  };

  // Case 1: fetch throws
  const throwingApp = {
    fetch: async () => {
      throw new Error("simulated network failure");
    },
  };
  let threw1 = false;
  /** @type {unknown} */
  let result1;
  try {
    result1 = await runAgentTurn({ ...baseArgs, app: throwingApp });
  } catch {
    threw1 = true;
  }
  assert.equal(threw1, false, "runAgentTurn must not throw when fetch throws");
  assert.ok(
    isNonEmptyPtBrSafeReply(result1),
    `throw path must resolve to non-empty pt-br safe reply, got: ${String(result1)}`,
  );

  // Case 2: non-2xx response
  const non2xxApp = {
    fetch: async () =>
      new Response(JSON.stringify({ error: "upstream" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
  };
  let threw2 = false;
  /** @type {unknown} */
  let result2;
  try {
    result2 = await runAgentTurn({ ...baseArgs, app: non2xxApp });
  } catch {
    threw2 = true;
  }
  assert.equal(threw2, false, "runAgentTurn must not throw on non-2xx");
  assert.ok(
    isNonEmptyPtBrSafeReply(result2),
    `non-2xx path must resolve to non-empty pt-br safe reply, got: ${String(result2)}`,
  );
});
