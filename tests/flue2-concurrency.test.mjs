/**
 * Versioned, executable oracle for the concurrency defect the Flue 2.x migration exists to fix.
 * Runs against a REAL Flue 2.x runtime (Node target) with a faux model provider — never a mock
 * of the runtime itself. A probe agent stands in for the real GestaoBot (which binds
 * cloudflare:workers + D1 and cannot boot on the Node target); the semantics under test belong
 * to the runtime, and the real agent is proven separately by the green build and the production
 * smoke.
 *
 * Fixes the pre-migration defect where a second concurrent delivery to the same instance threw a
 * UNIQUE violation and its reply was lost, and where one abandoned (never-read) submission
 * permanently wedged its instance.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { init, setProvider, useDelivery, useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runAgentTurn } from "../src/worker/agent/run-agent-turn.ts";
import { claimAgentReplySend } from "../src/worker/services/agent-reply-send-guard.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/**
 * @description Open in-memory SQLite, enable FKs, apply every migrations/*.sql sorted by
 * filename — mirrors tests/flue2-reply-send-guard.test.mjs.
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

const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
setProvider(faux.provider);

/** @description Minimal probe agent: binds only the faux model + useDelivery, no cloudflare:workers/D1 dependency. */
export function ProbeAgent() {
  useModel("faux/m1");
  useDelivery();
  return "sys";
}

before(async () => {
  await start({ agents: [ProbeAgent] });
});

// ─── lt-flue2-concurrent-deliveries-both-answered ──────────────────────────

test("lt-flue2-concurrent-deliveries-both-answered: two dispatches to the same instance id both resolve non-empty replies with distinct submissionIds", async () => {
  faux.setResponses(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`concurrent-reply-${i}`)),
  );
  const h = init(ProbeAgent, { id: "tp2:-1001234567:42" });

  const a = await h.dispatch("primeira mensagem concorrente");
  const b = await h.dispatch("segunda mensagem concorrente");
  assert.notEqual(
    a.submissionId,
    b.submissionId,
    "the two concurrent dispatches to the same instance must mint distinct submissionIds",
  );

  const [ra, rb] = await Promise.all([h.read(a), h.read(b)]);
  assert.ok(ra.text.length > 0, "the first delivery's read must resolve a non-empty reply text");
  assert.ok(rb.text.length > 0, "the second delivery's read must resolve a non-empty reply text");
});

// ─── lt-flue2-coalesced-answer-claims-once ─────────────────────────────────

test("lt-flue2-coalesced-answer-claims-once: the resolved dedupe key of two coalescing deliveries matches, and claimAgentReplySend claims it exactly once", async () => {
  faux.setResponses(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`coalesce-reply-${i}`)),
  );
  const h = init(ProbeAgent, { id: "tp2:-1001234567:73" });

  const a = await h.dispatch("primeira mensagem coalescida");
  const b = await h.dispatch("segunda mensagem coalescida");

  let settledA = null;
  let settledB = null;
  const [ra, rb] = await Promise.all([
    h.read(a, {
      onEvent: (chunk) => {
        if (chunk && chunk.type === "submission-settled") settledA = chunk;
      },
    }),
    h.read(b, {
      onEvent: (chunk) => {
        if (chunk && chunk.type === "submission-settled") settledB = chunk;
      },
    }),
  ]);
  assert.ok(ra.text.length > 0, "first coalescing delivery must still resolve a reply text");
  assert.ok(rb.text.length > 0, "second coalescing delivery must still resolve a reply text");

  // Resolved key: settledChunk.answeredBySubmissionId ?? receipt.submissionId — NEVER the raw
  // field alone, which is absent on a solo self-answered submission.
  const keyA = settledA?.answeredBySubmissionId ?? a.submissionId;
  const keyB = settledB?.answeredBySubmissionId ?? b.submissionId;

  assert.ok(keyA, "resolved key for the first receipt's own settled chunk must be a non-empty string");
  assert.ok(keyB, "resolved key for the second receipt's own settled chunk must be a non-empty string");
  assert.equal(
    keyA,
    keyB,
    "the two resolved keys must be the SAME non-empty string — both deliveries answer through one coalesced submission",
  );

  const db = openDb();
  const claimA = await claimAgentReplySend(db, keyA);
  const claimB = await claimAgentReplySend(db, keyB);
  const claimedTrueCount = [claimA.claimed, claimB.claimed].filter(Boolean).length;
  assert.equal(
    claimedTrueCount,
    1,
    "exactly one of the two claims against the shared resolved key must resolve { claimed: true }",
  );
  db.close();
});

// ─── lt-flue2-real-run-agent-turn-through-real-runtime ─────────────────────

test("lt-flue2-real-run-agent-turn-through-real-runtime: runAgentTurn through a REAL port resolves the real model text and a dedupe key equal to the delivery's own submissionId", async () => {
  faux.setResponses([fauxAssistantMessage("resposta do modelo")]);
  const sessionId = "rat3:emp-A:555";
  const realPort = init(ProbeAgent, { id: sessionId });

  /** @type {{ submissionId: string, acceptedAt: string, uid: string } | null} */
  let capturedReceipt = null;
  // A real port built from the real runtime handle — the wrapping only records what the real
  // dispatch() resolves, so the equality check below can be verified independently. dispatch()
  // and read() both delegate straight to the real handle.
  const port = {
    dispatch: async (request) => {
      capturedReceipt = await realPort.dispatch(request);
      return capturedReceipt;
    },
    read: (target, options) => realPort.read(target, options),
  };

  const result = await runAgentTurn({ sessionId, message: "oi, bot", port });

  assert.equal(
    result.text,
    "resposta do modelo",
    "runAgentTurn must resolve the real model text EXACTLY for a solo delivery — never the SAFE_REPLY string",
  );
  assert.ok(capturedReceipt, "the port's dispatch must have produced a receipt");
  assert.ok(result.key, "runAgentTurn must resolve a non-empty dedupe key");
  assert.equal(
    result.key,
    capturedReceipt.submissionId,
    "for a solo (non-coalesced) delivery, the resolved dedupe key must equal that delivery's OWN submissionId",
  );
});

// ─── lt-flue2-real-run-agent-turn-coalesced-key-is-the-head ────────────────

test("lt-flue2-real-run-agent-turn-coalesced-key-is-the-head: for two deliveries that coalesce on the same instance, runAgentTurn resolves the SAME key for both — the HEAD's id, never a reader's own submissionId", async () => {
  faux.setResponses(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`real-coalesce-reply-${i}`)),
  );
  const sessionId = "rat3:emp-B:909";

  // Two REAL ports built from the real runtime, targeting the SAME shared instance id — mirrors
  // production, where each concurrent request builds its own port via
  // init(GestaoBot, { id: sessionId }) against the same conversation instance.
  const realPortA = init(ProbeAgent, { id: sessionId });
  const realPortB = init(ProbeAgent, { id: sessionId });

  /** @type {{ submissionId: string, acceptedAt: string, uid: string } | null} */
  let receiptA = null;
  /** @type {{ submissionId: string, acceptedAt: string, uid: string } | null} */
  let receiptB = null;

  // Wrapping only records what each real dispatch() resolves; read() delegates straight through —
  // same convention as lt-flue2-real-run-agent-turn-through-real-runtime above.
  const portA = {
    dispatch: async (request) => {
      receiptA = await realPortA.dispatch(request);
      return receiptA;
    },
    read: (target, options) => realPortA.read(target, options),
  };
  const portB = {
    dispatch: async (request) => {
      receiptB = await realPortB.dispatch(request);
      return receiptB;
    },
    read: (target, options) => realPortB.read(target, options),
  };

  // Start both turns close together (via Promise.all, both dispatches begin before either
  // resolves) — mirrors how lt-flue2-concurrent-deliveries-both-answered and
  // lt-flue2-coalesced-answer-claims-once above produce a coalescing pair on a shared instance.
  const [resultA, resultB] = await Promise.all([
    runAgentTurn({ sessionId, message: "primeira mensagem via runAgentTurn", port: portA }),
    runAgentTurn({ sessionId, message: "segunda mensagem via runAgentTurn", port: portB }),
  ]);

  assert.ok(resultA.key, "the first delivery's runAgentTurn must resolve a non-empty key");
  assert.ok(resultB.key, "the second delivery's runAgentTurn must resolve a non-empty key");
  assert.equal(
    resultA.key,
    resultB.key,
    "the two resolved keys must be the SAME non-empty string — both must resolve to the HEAD's id, not each reader's own submissionId",
  );

  assert.ok(receiptA, "the first delivery's wrapped dispatch must have produced a receipt");
  assert.ok(receiptB, "the second delivery's wrapped dispatch must have produced a receipt");
  const someOwnIdDiffersFromResolvedKey =
    receiptA.submissionId !== resultA.key || receiptB.submissionId !== resultB.key;
  assert.ok(
    someOwnIdDiffersFromResolvedKey,
    "at least one receipt's OWN submissionId must differ from the resolved key — otherwise the two deliveries never actually coalesced and this test would pass vacuously",
  );

  const db = openDb();
  const claimA = await claimAgentReplySend(db, resultA.key);
  const claimB = await claimAgentReplySend(db, resultB.key);
  const claimedTrueCount = [claimA.claimed, claimB.claimed].filter(Boolean).length;
  assert.equal(
    claimedTrueCount,
    1,
    "exactly one of the two claims against the shared resolved key must resolve { claimed: true }",
  );
  db.close();
});

// ─── lt-flue2-abandoned-submission-does-not-wedge ──────────────────────────
// ─── lt-flue2-abandoned-receipt-is-re-attachable ───────────────────────────
// These two share state: the never-read receipt dispatched in the first test is read again,
// after settlement, in the second. node:test runs top-level tests in one file serially in
// definition order, so the second test relies on the first having already run.

/** @type {{ submissionId: string, acceptedAt: string, uid: string } | null} */
let abandonedReceipt = null;

test("lt-flue2-abandoned-submission-does-not-wedge: a second dispatch to the same instance still resolves a reply after an earlier receipt is left unread", async () => {
  faux.setResponses(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`abandon-reply-${i}`)),
  );
  const h = init(ProbeAgent, { id: "dm2:emp-A:987654" });

  abandonedReceipt = await h.dispatch("mensagem abandonada, nunca lida");
  const next = await h.dispatch("mensagem seguinte, deve funcionar");
  const reply = await h.read(next);
  assert.ok(
    reply.text.length > 0,
    "the second dispatch must resolve a non-empty reply — the abandoned submission must not wedge the instance",
  );
});

test("lt-flue2-abandoned-receipt-is-re-attachable: reading the abandoned receipt after the later submission has already settled still resolves a non-empty reply", async () => {
  assert.ok(
    abandonedReceipt,
    "lt-flue2-abandoned-submission-does-not-wedge must have run first and captured the abandoned receipt",
  );
  const h = init(ProbeAgent, { id: "dm2:emp-A:987654" });

  const late = await h.read(abandonedReceipt);
  assert.ok(
    late.text.length > 0,
    "the abandoned receipt must resolve a non-empty reply text on a later re-attached read — settlement records are durable",
  );
});
