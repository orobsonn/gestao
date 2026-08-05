/** @description Pure Admin UI contracts — tab ids, create-membro body, LLM status/health copy. */

import type { MembershipPapel } from "../../shared/domain/enums.ts";

/** @description Admin page tabs — Pessoas | IA only (no Telegram). */
export const ADMIN_TAB_IDS = ["pessoas", "ia"] as const;

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
