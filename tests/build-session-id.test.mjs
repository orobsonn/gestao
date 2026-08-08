/**
 * Locked buildSessionId contract — stable topic/dm session ids with String canonicalization.
 * Hermetic pure unit tests; no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionId } from "../src/worker/services/build-session-id.ts";

// ─── lt-session-id-number-string-parity ────────────────────────────────────

/**
 * @description Topic session ids canonicalize number and string chatId/threadId to the same string.
 */
test("lt-session-id-number-string-parity: number and string chat/thread pairs yield topic:-1001:42", () => {
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

  assert.equal(fromNumbers, "topic:-1001:42");
  assert.equal(fromStrings, "topic:-1001:42");
  assert.equal(fromNumbers, fromStrings);
});

// ─── lt-session-id-dm-stable ───────────────────────────────────────────────

/**
 * @description DM session id is stable for the same gestao user id and is not a random UUID.
 */
test("lt-session-id-dm-stable: kind dm for u-1 returns dm:u-1 twice, not a UUID", () => {
  const first = buildSessionId({ kind: "dm", userId: "u-1" });
  const second = buildSessionId({ kind: "dm", userId: "u-1" });

  assert.equal(first, "dm:u-1");
  assert.equal(second, "dm:u-1");
  assert.equal(first, second);

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.equal(uuidPattern.test(first), false);
  assert.equal(uuidPattern.test(second), false);
});
