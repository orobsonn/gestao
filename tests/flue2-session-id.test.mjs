/**
 * Locked buildSessionId 2.0 contract — empresa-scoped dm2 ids and tp2 topic ids.
 * Pins the fix for the cross-tenant DM collision: a DM session id keyed only by telegram
 * user id let one company's message ride another company's live agent response. The new
 * forms are dm2:<empresaId>:<userId> and tp2:<chatId>:<threadId>; neither beta prefix
 * (dm: / topic:) may survive.
 * Hermetic pure unit tests; no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionId } from "../src/worker/services/build-session-id.ts";

// ─── lt-flue2-dm-id-is-empresa-scoped ──────────────────────────────────────

/**
 * @description DM session id is scoped by empresaId, forming dm2:<empresaId>:<userId>.
 */
test("lt-flue2-dm-id-is-empresa-scoped: kind dm with empresaId emp-A and userId 987654 returns dm2:emp-A:987654", () => {
  const result = buildSessionId({
    kind: "dm",
    empresaId: "emp-A",
    userId: "987654",
  });

  assert.equal(
    result,
    "dm2:emp-A:987654",
    "dm session id must be exactly dm2:<empresaId>:<userId>",
  );
});

// ─── lt-flue2-dm-id-differs-per-empresa ────────────────────────────────────

/**
 * @description The same telegram user in two different empresas gets two distinct DM
 * session ids — the assertion that pins the cross-tenant fix itself.
 */
test("lt-flue2-dm-id-differs-per-empresa: same userId 987654 under emp-A and emp-B yields two different ids", () => {
  const fromEmpresaA = buildSessionId({
    kind: "dm",
    empresaId: "emp-A",
    userId: "987654",
  });
  const fromEmpresaB = buildSessionId({
    kind: "dm",
    empresaId: "emp-B",
    userId: "987654",
  });

  assert.notEqual(
    fromEmpresaA,
    fromEmpresaB,
    "same userId under different empresaId must produce different session ids so one company's live agent instance never serves another company's message",
  );
});

// ─── lt-flue2-dm-id-requires-empresa ───────────────────────────────────────

/**
 * @description DM session id construction throws when empresaId is absent — no unscoped
 * dm id may ever be returned. Covers undefined, null, and empty-string absence.
 */
test("lt-flue2-dm-id-requires-empresa: kind dm without empresaId throws for undefined, null, and empty string", () => {
  assert.throws(
    () => buildSessionId({ kind: "dm", userId: "987654" }),
    "buildSessionId must throw when empresaId is undefined (omitted)",
  );
  assert.throws(
    () => buildSessionId({ kind: "dm", userId: "987654", empresaId: null }),
    "buildSessionId must throw when empresaId is null",
  );
  assert.throws(
    () => buildSessionId({ kind: "dm", userId: "987654", empresaId: "" }),
    "buildSessionId must throw when empresaId is the empty string",
  );
});

// ─── lt-flue2-topic-id-number-string-parity ────────────────────────────────

/**
 * @description Topic session ids canonicalize number and string chatId/threadId to the
 * same tp2:<chatId>:<threadId> string.
 */
test("lt-flue2-topic-id-number-string-parity: number chatId/threadId and string chatId/threadId both yield tp2:-1001234567:42", () => {
  const fromNumberChatId = buildSessionId({
    kind: "topic",
    chatId: -1001234567,
    threadId: "42",
  });
  const fromAllStrings = buildSessionId({
    kind: "topic",
    chatId: "-1001234567",
    threadId: "42",
  });

  assert.equal(
    fromNumberChatId,
    "tp2:-1001234567:42",
    "topic session id with numeric chatId must equal tp2:-1001234567:42",
  );
  assert.equal(
    fromAllStrings,
    "tp2:-1001234567:42",
    "topic session id with all-string inputs must equal tp2:-1001234567:42",
  );
  assert.equal(
    fromNumberChatId,
    fromAllStrings,
    "number and string chatId/threadId inputs must canonicalize to the identical topic session id",
  );
});

// ─── lt-flue2-no-beta-prefix-survives ──────────────────────────────────────

/**
 * @description Neither the dm2 nor the tp2 session id contains the retired beta prefixes
 * (dm: / topic:); each carries its new 2.0 prefix instead.
 */
test("lt-flue2-no-beta-prefix-survives: dm2 and tp2 ids never contain dm: or topic: and start with their new prefixes", () => {
  const dmId = buildSessionId({
    kind: "dm",
    empresaId: "emp-A",
    userId: "987654",
  });
  const topicId = buildSessionId({
    kind: "topic",
    chatId: -1001234567,
    threadId: "42",
  });

  assert.equal(
    dmId.includes("dm:"),
    false,
    "dm2 session id must not contain the retired beta substring dm:",
  );
  assert.equal(
    dmId.includes("topic:"),
    false,
    "dm2 session id must not contain the retired beta substring topic:",
  );
  assert.equal(
    topicId.includes("dm:"),
    false,
    "tp2 session id must not contain the retired beta substring dm:",
  );
  assert.equal(
    topicId.includes("topic:"),
    false,
    "tp2 session id must not contain the retired beta substring topic:",
  );
  assert.equal(
    dmId.startsWith("dm2:"),
    true,
    "dm session id must start with the new dm2: prefix",
  );
  assert.equal(
    topicId.startsWith("tp2:"),
    true,
    "topic session id must start with the new tp2: prefix",
  );
});
