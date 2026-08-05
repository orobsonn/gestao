/**
 * Locked MinhaContaPage Desvincular wiring — source-inspection contracts for
 * linked-only actions, no-confirm unlink, and unlink→refreshMe feedback.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINHA_CONTA_PAGE_TSX = resolve(
  __dirname,
  "../src/react-app/pages/MinhaContaPage.tsx",
);

/**
 * @description MinhaContaPage imports resolveTelegramAccountActions and DESVINCULAR_BUTTON_LABEL from minha-conta-ui, renders Desvincular for the linked branch, and keeps Vincular Telegram / Atualizar status only on the pending path.
 */
test("lt-page-linked-renders-desvincular-only", () => {
  const src = readFileSync(MINHA_CONTA_PAGE_TSX, "utf8");

  assert.match(
    src,
    /resolveTelegramAccountActions/,
    "MinhaContaPage must import/use resolveTelegramAccountActions",
  );
  assert.match(
    src,
    /DESVINCULAR_BUTTON_LABEL/,
    "MinhaContaPage must import/use DESVINCULAR_BUTTON_LABEL",
  );
  assert.match(
    src,
    /from\s+["']@\/lib\/minha-conta-ui["']/,
    "MinhaContaPage must import unlink helpers from @/lib/minha-conta-ui",
  );
  assert.match(
    src,
    /DESVINCULAR_BUTTON_LABEL|Desvincular/,
    "MinhaContaPage must render Desvincular for the linked branch",
  );

  // Pending branch still references Vincular Telegram and Atualizar status.
  assert.match(
    src,
    /Vincular Telegram/,
    "pending branch must still reference Vincular Telegram",
  );
  assert.match(
    src,
    /Atualizar status/,
    "pending branch must still reference Atualizar status",
  );

  // Linked-only action path must not hardcode Vincular/Atualizar as the sole actions.
  // When actions are driven by resolveTelegramAccountActions(linked), linked yields
  // only desvincular — page must call the helper with linked and branch on "desvincular".
  assert.match(
    src,
    /resolveTelegramAccountActions\s*\(\s*linked\s*\)/,
    "MinhaContaPage must resolve actions from linked via resolveTelegramAccountActions(linked)",
  );
  assert.match(
    src,
    /["']desvincular["']|===\s*["']desvincular["']|includes\s*\(\s*["']desvincular["']\)/,
    "linked branch must render the desvincular action",
  );

  // Vincular / Atualizar must be gated to pending (not always rendered unconditionally).
  // Reject the pre-wiring pattern: both buttons always present with no actions helper branch.
  const unconditionalVincularAndAtualizar =
    /<div className="flex flex-wrap gap-2">\s*<Button[\s\S]*?>\s*Vincular Telegram\s*<\/Button>\s*<Button[\s\S]*?>\s*Atualizar status\s*<\/Button>\s*<\/div>/.test(
      src,
    );
  assert.equal(
    unconditionalVincularAndAtualizar,
    false,
    "linked-only path must not unconditionally render Vincular Telegram and Atualizar status",
  );
});

/**
 * @description Desvincular handler path has no window.confirm, AlertDialog, or confirm( call; UNLINK_REQUIRES_CONFIRMATION is referenced or unlinkTelegram runs directly on click.
 */
test("lt-page-no-confirm-on-desvincular", () => {
  const src = readFileSync(MINHA_CONTA_PAGE_TSX, "utf8");

  assert.equal(
    src.includes("window.confirm"),
    false,
    "Desvincular path must not call window.confirm",
  );
  assert.equal(
    /AlertDialog/.test(src),
    false,
    "Desvincular path must not use AlertDialog",
  );
  assert.equal(
    /\bconfirm\s*\(/.test(src),
    false,
    "Desvincular path must not call confirm(",
  );

  const referencesUnlinkFlag = /UNLINK_REQUIRES_CONFIRMATION/.test(src);
  const callsUnlinkDirectly = /unlinkTelegram\s*\(/.test(src);
  assert.ok(
    referencesUnlinkFlag || callsUnlinkDirectly,
    "must reference UNLINK_REQUIRES_CONFIRMATION or call unlinkTelegram directly on click",
  );
  assert.match(
    src,
    /unlinkTelegram/,
    "Desvincular handler must invoke unlinkTelegram",
  );
});

/**
 * @description Unlink handler calls unlinkTelegram then refreshMe, feeds refreshMe into resolveUnlinkFeedback (or equivalent next?.telegram?.linked !== false check), toast.success only on success with 'Telegram desvinculado.', and toast.error on catch and non-success feedback.
 */
test("lt-page-unlink-then-refreshme-feedback", () => {
  const src = readFileSync(MINHA_CONTA_PAGE_TSX, "utf8");

  assert.match(
    src,
    /unlinkTelegram/,
    "unlink handler must call unlinkTelegram",
  );
  assert.match(
    src,
    /refreshMe/,
    "unlink handler must call refreshMe after unlink",
  );

  // Order: unlinkTelegram before refreshMe in the success path.
  const unlinkIdx = src.search(/await\s+unlinkTelegram\s*\(|unlinkTelegram\s*\(/);
  const refreshAfterUnlink = src.slice(unlinkIdx === -1 ? 0 : unlinkIdx);
  assert.ok(unlinkIdx !== -1, "must invoke unlinkTelegram");
  assert.match(
    refreshAfterUnlink,
    /refreshMe\s*\(/,
    "refreshMe must follow unlinkTelegram in the handler",
  );

  const usesFeedbackHelper = /resolveUnlinkFeedback\s*\(/.test(src);
  const usesInlineLinkedCheck =
    /next\s*\?\.?\s*telegram\s*\?\.?\s*linked\s*!==\s*false|telegram\s*\?\.?\s*linked\s*===\s*false/.test(
      src,
    );
  assert.ok(
    usesFeedbackHelper || usesInlineLinkedCheck,
    "must pass refreshMe result into resolveUnlinkFeedback or check next?.telegram?.linked !== false",
  );

  if (usesFeedbackHelper) {
    assert.match(
      src,
      /resolveUnlinkFeedback\s*\(\s*\{[\s\S]*?nextMe\s*:/,
      "resolveUnlinkFeedback must receive nextMe from refreshMe",
    );
  }

  assert.match(
    src,
    /toast\.success\s*\(\s*["']Telegram desvinculado\.["']\s*\)/,
    "success toast string must be 'Telegram desvinculado.'",
  );

  // toast.success only on success feedback path — not bare after unlink without check.
  assert.match(
    src,
    /resolveUnlinkFeedback[\s\S]*toast\.success|===\s*["']success["'][\s\S]*toast\.success|toast\.success[\s\S]*success|linked\s*===\s*false[\s\S]*toast\.success/,
    "toast.success must run only on the success feedback path",
  );

  assert.match(
    src,
    /catch\s*\{[\s\S]*?toast\.error|catch\s*\([^)]*\)\s*\{[\s\S]*?toast\.error/,
    "catch path must call toast.error",
  );
  assert.match(
    src,
    /toast\.error/,
    "non-success feedback path must call toast.error",
  );

  // At least two toast.error sites (catch + non-success feedback), or one shared error helper used on both.
  const errorToastCount = (src.match(/toast\.error\s*\(/g) ?? []).length;
  assert.ok(
    errorToastCount >= 2 ||
      /toast\.error[\s\S]*toast\.error|function\s+\w*error\w*|const\s+\w*error\w*/i.test(
        src,
      ),
    "toast.error must cover catch and non-success feedback",
  );
});
