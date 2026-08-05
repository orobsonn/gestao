/** @description Pure Minha conta UI helpers — Telegram badge labels, path, refetch policy. */

/** @description Shell path for the account page. */
export const MINHA_CONTA_PATH = "/minha-conta";

/** @description Badge label when Telegram is linked. */
export const BADGE_LINKED_LABEL = "vinculado";

/** @description Badge label when Telegram is not yet linked. */
export const BADGE_PENDING_LABEL = "pendente";

/** @description Primary action: mint deep-link and open Telegram. */
export const VINCULAR_BUTTON_LABEL = "Vincular Telegram";

/** @description Secondary action: refresh me.telegram.linked via refreshMe. */
export const ATUALIZAR_BUTTON_LABEL = "Atualizar status";

/** @description Action label to unlink Telegram from the account. */
export const DESVINCULAR_BUTTON_LABEL = "Desvincular";

/** @description Unlink runs immediately — no confirm dialog. */
export const UNLINK_REQUIRES_CONFIRMATION = false;

/**
 * @description Map me.telegram.linked to the badge label shown on Minha conta.
 */
export function mapTelegramLinkBadge(linked: boolean): "vinculado" | "pendente" {
  return linked ? BADGE_LINKED_LABEL : BADGE_PENDING_LABEL;
}

/**
 * @description True when the page should re-fetch Telegram status on window focus/visibility
 * (only while still pending / not linked).
 */
export function shouldRefetchTelegramStatusOnFocus(linked: boolean): boolean {
  return !linked;
}

/**
 * @description Which Telegram account actions to show: desvincular when linked, vincular+atualizar when pending.
 */
export function resolveTelegramAccountActions(
  linked: boolean,
): ("desvincular" | "vincular" | "atualizar")[] {
  return linked ? ["desvincular"] : ["vincular", "atualizar"];
}

/**
 * @description Map unlink API + refreshMe result to toast feedback; success only when refresh shows linked===false.
 */
export function resolveUnlinkFeedback(input: {
  unlinkSucceeded: boolean;
  nextMe: { telegram?: { linked?: boolean } } | null;
}): "success" | "error" {
  if (!input.unlinkSucceeded) return "error";
  if (input.nextMe?.telegram?.linked === false) return "success";
  return "error";
}
