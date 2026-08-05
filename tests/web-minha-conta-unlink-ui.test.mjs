/**
 * @description Locked Minha conta unlink UI helpers — Telegram account actions,
 * desvincular label, no-confirmation constant, and unlink feedback resolution.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESVINCULAR_BUTTON_LABEL,
  UNLINK_REQUIRES_CONFIRMATION,
  resolveTelegramAccountActions,
  resolveUnlinkFeedback,
} from "../src/react-app/lib/minha-conta-ui.ts";

/**
 * @description Given linked===true, resolveTelegramAccountActions returns exactly ['desvincular'] and DESVINCULAR_BUTTON_LABEL is 'Desvincular'.
 */
test("lt-ac-1-linked-actions-desvincular-only", () => {
  const actions = resolveTelegramAccountActions(true);
  assert.deepEqual(actions, ["desvincular"]);
  assert.equal(actions.includes("vincular"), false);
  assert.equal(actions.includes("atualizar"), false);
  assert.equal(DESVINCULAR_BUTTON_LABEL, "Desvincular");
});

/**
 * @description Given linked===false, resolveTelegramAccountActions returns exactly ['vincular','atualizar'] in that order with no desvincular.
 */
test("lt-ac-2-pending-actions-vincular-atualizar", () => {
  const actions = resolveTelegramAccountActions(false);
  assert.deepEqual(actions, ["vincular", "atualizar"]);
  assert.equal(actions.includes("desvincular"), false);
});

/**
 * @description UNLINK_REQUIRES_CONFIRMATION is strictly false.
 */
test("lt-ac-3-no-confirmation-constant", () => {
  assert.equal(UNLINK_REQUIRES_CONFIRMATION, false);
});

/**
 * @description Given unlinkSucceeded===false and any nextMe, resolveUnlinkFeedback returns 'error'.
 */
test("lt-ac-9-unlink-fail-feedback-error", () => {
  assert.equal(
    resolveUnlinkFeedback({
      unlinkSucceeded: false,
      nextMe: { telegram: { linked: false } },
    }),
    "error",
  );
  assert.equal(
    resolveUnlinkFeedback({
      unlinkSucceeded: false,
      nextMe: { telegram: { linked: true } },
    }),
    "error",
  );
  assert.equal(
    resolveUnlinkFeedback({ unlinkSucceeded: false, nextMe: null }),
    "error",
  );
});

/**
 * @description Given unlinkSucceeded===true, resolveUnlinkFeedback returns 'success' only when nextMe.telegram.linked===false; null, linked true, or missing telegram yield 'error'.
 */
test("lt-ac-10-success-only-when-refresh-linked-false", () => {
  assert.equal(
    resolveUnlinkFeedback({
      unlinkSucceeded: true,
      nextMe: { telegram: { linked: false } },
    }),
    "success",
  );
  assert.equal(
    resolveUnlinkFeedback({ unlinkSucceeded: true, nextMe: null }),
    "error",
  );
  assert.equal(
    resolveUnlinkFeedback({
      unlinkSucceeded: true,
      nextMe: { telegram: { linked: true } },
    }),
    "error",
  );
  assert.equal(
    resolveUnlinkFeedback({ unlinkSucceeded: true, nextMe: {} }),
    "error",
  );
});
