/**
 * Locked runAgentTurn + buildAgentIdentityPrompt contract (Flue 2.x, in-process port).
 * Hermetic: node:sqlite :memory:, PRAGMA foreign_keys=ON, every migrations/*.sql sorted.
 *
 * Production exports under test:
 *   buildAgentIdentityPrompt, runAgentTurn, SAFE_REPLY from ../src/worker/agent/run-agent-turn.ts
 *
 * `?wait=result` does not exist in Flue 2.x — runAgentTurn takes an injected agent-handle PORT
 * (`dispatch({ message }) -> receipt`, `read(receipt, { signal, onEvent }) -> reply`) and
 * resolves `{ text, key }`. Never throws — SAFE_REPLY + null key on a rejected read.
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
  SAFE_REPLY,
} from "../src/worker/agent/run-agent-turn.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

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

// ─── lt-run-agent-turn-dispatches-message-only ─────────────────────────────

/**
 * @description runAgentTurn dispatches ONLY { message } to the injected port (no gated identity,
 * no turnToken/HTTP concept), reads via the receipt, and resolves { text, key } from the port's
 * settlement — this is the Flue 2.x in-process replacement for the retired ?wait=result hop.
 */
test("lt-run-agent-turn-dispatches-message-only: port.dispatch receives { message } only; text/key resolved from port.read", async () => {
  const sessionId = "topic:-1001:42";
  const message = "criar tarefa de teste";

  /** @type {unknown} */
  let capturedDispatchRequest;
  const port = {
    /**
     * @param {unknown} request
     */
    dispatch: async (request) => {
      capturedDispatchRequest = request;
      return {
        submissionId: "sub-dispatch-only",
        acceptedAt: new Date().toISOString(),
        uid: "uid-dispatch-only",
      };
    },
    /**
     * @param {{ submissionId: string }} receipt
     * @param {{ onEvent?: (chunk: unknown) => void }} options
     */
    read: async (receipt, options) => {
      options.onEvent?.({
        type: "submission-settled",
        submissionId: receipt.submissionId,
        outcome: "completed",
      });
      return { text: "ok dispatch only", data: {}, submissionId: receipt.submissionId };
    },
  };

  const result = await runAgentTurn({ sessionId, message, port });

  assert.ok(
    capturedDispatchRequest && typeof capturedDispatchRequest === "object",
    "port.dispatch must be called with an object",
  );
  const dispatchKeys = Object.keys(
    /** @type {Record<string, unknown>} */ (capturedDispatchRequest),
  ).sort();
  assert.deepEqual(
    dispatchKeys,
    ["message"],
    "port.dispatch request keys must be exactly {message} — no gated identity, no turnToken",
  );
  assert.equal(
    /** @type {{ message: unknown }} */ (capturedDispatchRequest).message,
    message,
    "dispatched message must equal the input message",
  );

  assert.equal(result.text, "ok dispatch only");
  assert.equal(result.key, "sub-dispatch-only");
});

// ─── lt-run-agent-turn-safe-on-failure ─────────────────────────────────────

/**
 * @description When the injected port's read() rejects (AgentRunError-shaped failure) or the
 * dispatch itself throws, runAgentTurn resolves a non-empty pt-br safe reply with a null key and
 * never throws.
 */
test("lt-run-agent-turn-safe-on-failure: read()/dispatch() rejection → SAFE_REPLY, null key, no throw", async () => {
  const sessionId = "dm:user-safe-1";
  const message = "oi";

  // Case 1: read() rejects
  const rejectingReadPort = {
    dispatch: async () => ({
      submissionId: "sub-safe-1",
      acceptedAt: new Date().toISOString(),
      uid: "uid-safe-1",
    }),
    read: async () => {
      throw new Error("simulated failed/aborted submission");
    },
  };
  let threw1 = false;
  /** @type {{ text: string, key: string | null } | undefined} */
  let result1;
  try {
    result1 = await runAgentTurn({ sessionId, message, port: rejectingReadPort });
  } catch {
    threw1 = true;
  }
  assert.equal(threw1, false, "runAgentTurn must not throw when port.read() rejects");
  assert.ok(result1, "runAgentTurn must resolve a result on the failure path");
  assert.equal(result1.text, SAFE_REPLY, "failed read must resolve exactly SAFE_REPLY");
  assert.equal(result1.key, null, "failed read must resolve a null dedupe key");
  assert.ok(
    isNonEmptyPtBrSafeReply(result1.text),
    `SAFE_REPLY must be non-empty pt-br, got: ${String(result1.text)}`,
  );

  // Case 2: dispatch() itself throws
  const throwingDispatchPort = {
    dispatch: async () => {
      throw new Error("simulated dispatch failure");
    },
    read: async () => {
      throw new Error("unreachable — dispatch already failed");
    },
  };
  let threw2 = false;
  /** @type {{ text: string, key: string | null } | undefined} */
  let result2;
  try {
    result2 = await runAgentTurn({ sessionId, message, port: throwingDispatchPort });
  } catch {
    threw2 = true;
  }
  assert.equal(threw2, false, "runAgentTurn must not throw when port.dispatch() throws");
  assert.ok(result2, "runAgentTurn must resolve a result on the dispatch-failure path");
  assert.equal(result2.text, SAFE_REPLY);
  assert.equal(result2.key, null);
});
