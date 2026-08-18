/**
 * Locked buildSessionId contract — empresa-scoped dm2 ids and tp2 topic ids with String
 * canonicalization. Hermetic pure unit tests; no DB.
 *
 * The legacy lt-session-id-dm-stable (asserting the literal `dm:u-1`) is REVOKED — the DM id form
 * changed to dm2:<empresaId>:<userId>. The STABILITY property it encoded (same input → same id,
 * never a UUID) is preserved verbatim in the new form. lt-session-id-number-string-parity stays
 * intact in substance: the topic-id numeric/string parity, only the prefix moved from `topic:` to
 * `tp2:`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionId } from "../src/worker/services/build-session-id.ts";

// ─── lt-session-id-number-string-parity ────────────────────────────────────

/**
 * @description Topic session ids canonicalize number and string chatId/threadId to the same string.
 */
test("lt-session-id-number-string-parity: number and string chat/thread pairs yield tp2:-1001:42", () => {
  const fromNumbers = buildSessionId({
    kind: "topic",
    chatId: -1001,
    threadId: 42,
  });
  const fromStrings = buildSessionId({
    kind: "topic",
    chatId: "-1001",
    threadId: "42",
  });

  assert.equal(fromNumbers, "tp2:-1001:42");
  assert.equal(fromStrings, "tp2:-1001:42");
  assert.equal(fromNumbers, fromStrings);
});

// ─── lt-session-id-dm-stable (reissued) ─────────────────────────────────────

/**
 * @description DM session id is stable for the same empresa+user pair and is not a random UUID.
 * Preserves the STABILITY property of the revoked lt-session-id-dm-stable in the new
 * dm2:<empresaId>:<userId> form — only the FORM changed.
 */
test("lt-session-id-dm-stable: kind dm for emp-A/u-1 returns dm2:emp-A:u-1 twice, not a UUID", () => {
  const first = buildSessionId({ kind: "dm", empresaId: "emp-A", userId: "u-1" });
  const second = buildSessionId({ kind: "dm", empresaId: "emp-A", userId: "u-1" });

  assert.equal(first, "dm2:emp-A:u-1");
  assert.equal(second, "dm2:emp-A:u-1");
  assert.equal(first, second);

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.equal(uuidPattern.test(first), false);
  assert.equal(uuidPattern.test(second), false);
});