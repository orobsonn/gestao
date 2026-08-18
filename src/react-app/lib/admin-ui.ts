/** @description Pure Admin UI contracts — tab ids, create-membro body, LLM status/health copy. */

import type { MembershipPapel } from "../../shared/domain/enums.ts";

/** @description Admin page tabs — Pessoas | IA | Telegram. */
export const ADMIN_TAB_IDS = ["pessoas", "ia", "telegram"] as const;

export type AdminTabId = (typeof ADMIN_TAB_IDS)[number];

/** @description Fields for building POST /api/empresa/membros body. */
export type CreateMembroFields = {
  name: string;
  email: string;
  password: string;
  papel: MembershipPapel;
};

/** @description Built create-membro body — exactly name, email, password, papel. */
export type BuiltCreateMembroBody = {
  name: string;
  email: string;
  password: string;
  papel: MembershipPapel;
};

/**
 * @description Build POST membros body with exactly four fields; no password hash.
 */
export function buildCreateMembroBody(
  fields: CreateMembroFields,
): BuiltCreateMembroBody {
  return {
    name: fields.name,
    email: fields.email,
    password: fields.password,
    papel: fields.papel,
  };
}

/** @description Metadata status values shown on the IA badge. */
export type LlmStatusBadgeKey = "valid" | "invalid" | "unvalidated" | "none";

const LLM_STATUS_BADGE_LABELS: Record<LlmStatusBadgeKey, string> = {
  valid: "Válida",
  invalid: "Inválida",
  unvalidated: "Não validada",
  none: "Não configurada",
};

/**
 * @description pt-br Badge label for LLM Metadata status — never includes key material.
 */
export function mapLlmStatusBadge(status: LlmStatusBadgeKey): string {
  return LLM_STATUS_BADGE_LABELS[status];
}

/** @description Health reason codes from GET llm-settings/health when ok is false. */
export type LlmHealthReason =
  | "llm_key_unvalidated"
  | "llm_key_invalid"
  | "llm_not_configured"
  | "llm_key_missing";

const LLM_HEALTH_REASON_COPY: Record<LlmHealthReason, string> = {
  llm_key_unvalidated:
    "A chave de API ainda não foi validada. Clique em Validar para testar a conexão.",
  llm_key_invalid:
    "A chave de API foi rejeitada pelo provedor. Verifique a chave e salve novamente.",
  llm_not_configured:
    "Nenhuma configuração de IA foi salva para esta empresa.",
  llm_key_missing:
    "A configuração existe, mas não há chave de API armazenada.",
};

/**
 * @description pt-br alert copy for LLM health reasons — never embeds secret material.
 */
export function mapLlmHealthReasonCopy(reason: string): string {
  if (reason in LLM_HEALTH_REASON_COPY) {
    return LLM_HEALTH_REASON_COPY[reason as LlmHealthReason];
  }
  return "Não foi possível verificar o status da IA.";
}

/**
 * @description Identity passthrough for Telegram mint command display — preserves full '/vincular_* <64hex>' string exactly as returned by API (no stripping).
 */
export function displayTelegramMintCommand(command: string): string {
  return command;
}

/** Sentinel for the "use the provider default" option — Select cannot carry a null value. */
export const LLM_MODEL_DEFAULT_OPTION = "__default__";

/** @description pt-br label for the option that restores the per-provider default. */
export const LLM_MODEL_DEFAULT_LABEL = "Padrão do provedor";

/**
 * @description Maps the Select value to the PUT body value: the sentinel clears the choice.
 * The empty string is never produced — the API rejects it, and persisting it would make the
 * empresa's bot go silent.
 */
export function resolveLlmModelSelection(value: string): string | null {
  return value === LLM_MODEL_DEFAULT_OPTION || value.length === 0
    ? null
    : value;
}

/** @description Select value for the saved model — the sentinel whenever no model is chosen. */
export function llmModelSelectValue(modelId: string | null): string {
  return modelId ?? LLM_MODEL_DEFAULT_OPTION;
}

/** @description pt-br feedback for a model save, by outcome. */
export function mapLlmModelSaveFeedback(
  outcome: "saved" | "cleared" | "invalid" | "conflict" | "error",
): string {
  if (outcome === "saved") return "Modelo salvo. Vale a partir da próxima mensagem do bot.";
  if (outcome === "cleared") {
    return "Modelo padrão restaurado. Vale a partir da próxima mensagem do bot.";
  }
  if (outcome === "invalid") return "Esse modelo não é compatível com o provedor salvo.";
  if (outcome === "conflict") {
    return "As configurações mudaram enquanto você editava. Recarregue e tente de novo.";
  }
  return "Não foi possível salvar o modelo. Tente de novo.";
}

/**
 * @description Whether an in-flight LLM write may still apply its result to component state.
 *
 * Two writers hit the same row (model save, credential save, validate). Only the newest may
 * apply, or a slow response re-applies a value the server has already replaced.
 */
export function shouldApplyLlmWrite(seq: number, current: number): boolean {
  return seq === current;
}

/** @description Inputs deciding whether the model-only save is available. */
export type LlmModelSaveState = {
  saving: boolean;
  savingModel: boolean;
  validating: boolean;
  savedProvider: string | null;
  selectedProvider: string;
  modelSelection: string;
  savedModelId: string | null;
  /** The id that was dropped for leaving the catalog, when the stored choice degraded. */
  retiredModelId: string | null;
};

/**
 * @description Whether "Salvar modelo" may be pressed.
 *
 * The model PUT carries no provider — the server validates against the SAVED one. So while the
 * provider dropdown disagrees with what is saved, saving would silently change the model of the
 * OLD provider while the screen claims the new one.
 *
 * A retired stored model reads back as `savedModelId: null`, which is also what the default option
 * maps to — so the plain change check would call "return to the default" a no-op and disable the
 * one save that clears the dead id. That leaves the operator told to act with the cheap action
 * barred, and the notice returning on every load. A pending retirement is therefore always saveable.
 */
export function canSaveLlmModel(state: LlmModelSaveState): boolean {
  if (state.saving || state.savingModel || state.validating) return false;
  if (!state.savedProvider) return false;
  if (state.selectedProvider !== state.savedProvider) return false;
  if (state.retiredModelId) return true;
  return state.modelSelection !== llmModelSelectValue(state.savedModelId);
}

/** @description pt-br helper copy under the model Select, by configuration state. */
export function llmModelHelpCopy(
  savedProvider: string | null,
  selectedProvider: string,
): string {
  if (!savedProvider) {
    return "Salve a chave de API da empresa antes de escolher o modelo.";
  }
  if (selectedProvider !== savedProvider) {
    return "Salve a chave do novo provedor antes de escolher o modelo dele.";
  }
  return "Vale a partir da próxima mensagem do bot. Salvar uma chave nova volta o modelo para o padrão.";
}

/** @description pt-br notice when the empresa's stored model is no longer offered. */
export function llmRetiredModelCopy(retiredModelId: string | null): string | null {
  if (!retiredModelId) return null;
  return `O modelo ${retiredModelId} não está mais disponível. O bot voltou ao padrão do provedor — escolha um modelo da lista.`;
}
