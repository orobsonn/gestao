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
