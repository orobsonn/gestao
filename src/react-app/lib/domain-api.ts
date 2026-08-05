/** @description Typed authFetch wrappers for experts, campanhas, tarefas, membros, and LLM settings APIs. */

import { authFetch } from "./auth-api.ts";
import type {
  CampanhaStatus,
  CampanhaTipo,
  MembershipPapel,
  TarefaStatus,
} from "../../shared/domain/enums.ts";

// ── Re-exports (campanha-task UI contracts from domain-routes) ──────────────

export {
  CAMPANHA_TASK_FILTER_CONTROL_IDS,
  buildCreateTarefaBody,
} from "./domain-routes.ts";

export type {
  CreateTarefaFields,
  BuiltCreateTarefaBody,
} from "./domain-routes.ts";

// ── Paths ──────────────────────────────────────────────────────────────────

export const EXPERTS_API_PATH = "/api/empresa/experts";
export const CAMPANHAS_API_PATH = "/api/empresa/campanhas";
export const TAREFAS_API_PATH = "/api/empresa/tarefas";
export const MEMBROS_API_PATH = "/api/empresa/membros";
export const LLM_SETTINGS_API_PATH = "/api/empresa/llm-settings";
export const LLM_VALIDATE_API_PATH = "/api/empresa/llm-settings/validate";
export const LLM_HEALTH_API_PATH = "/api/empresa/llm-settings/health";

export const TELEGRAM_BINDINGS_API_PATH = "/api/empresa/telegram-bindings";
export const TELEGRAM_EMPRESA_COMMAND_API_PATH =
  "/api/empresa/telegram-bindings/empresa-command";
export const TELEGRAM_EXPERT_COMMAND_API_PATH =
  "/api/empresa/telegram-bindings/expert-command";

/**
 * @description GET path for campanhas under an expert.
 */
export function expertCampanhasApiPath(expertId: string): string {
  return `${EXPERTS_API_PATH}/${expertId}/campanhas`;
}

/**
 * @description GET path for tarefas under a campanha.
 */
export function campanhaTarefasApiPath(campanhaId: string): string {
  return `${CAMPANHAS_API_PATH}/${campanhaId}/tarefas`;
}

// ── Row types ──────────────────────────────────────────────────────────────

/** @description Live expert row from GET /api/empresa/experts (with open/late counts). */
export type ExpertListRow = {
  id: string;
  nome: string;
  abertas: number;
  atrasadas: number;
};

/** @description Live expert row from get/create/patch (id + nome). */
export type ExpertRow = {
  id: string;
  nome: string;
};

/** @description Live campanha row from list/get/create/patch. */
export type CampanhaRow = {
  id: string;
  expert_id: string;
  nome: string;
  tipo: string;
  status: string;
  data_inicio: string | null;
  data_fim: string | null;
  notas: string;
};

/** @description Live tarefa row from list/get/create/patch. */
export type TarefaRow = {
  id: string;
  campanha_id: string;
  titulo: string;
  notas: string;
  status: string;
  prazo: string | null;
  dono_id: string | null;
  created_by: string;
};

/** @description Member row from GET /api/empresa/membros. */
export type MembroListRow = {
  user_id: string;
  name: string;
  email: string;
  papel: string;
};

// ── Body types ─────────────────────────────────────────────────────────────

/** @description POST /api/empresa/experts body. */
export type CreateExpertBody = {
  nome: string;
};

/** @description PATCH /api/empresa/experts/:id body. */
export type PatchExpertBody = {
  nome?: string;
};

/** @description POST /api/empresa/campanhas body. */
export type CreateCampanhaBody = {
  expert_id: string;
  nome: string;
  tipo: CampanhaTipo;
  status?: CampanhaStatus;
  data_inicio?: string;
  data_fim?: string;
  notas?: string;
};

/** @description PATCH /api/empresa/campanhas/:id body. */
export type PatchCampanhaBody = {
  nome?: string;
  tipo?: CampanhaTipo;
  status?: CampanhaStatus;
  data_inicio?: string | null;
  data_fim?: string | null;
  notas?: string;
};

/** @description POST /api/empresa/tarefas body. */
export type CreateTarefaBody = {
  campanha_id: string;
  titulo: string;
  notas?: string;
  status?: TarefaStatus;
  prazo?: string;
  dono_id?: string;
};

/** @description PATCH /api/empresa/tarefas/:id body. */
export type PatchTarefaBody = {
  titulo?: string;
  notas?: string;
  status?: TarefaStatus;
  prazo?: string | null;
  dono_id?: string | null;
};

/** @description POST /api/empresa/membros body. */
export type CreateMembroBody = {
  name: string;
  email: string;
  password: string;
  papel: MembershipPapel;
};

/** @description LLM provider values accepted by PUT llm-settings. */
export type LlmProvider = "openai" | "anthropic";

/** @description Metadata DTO from GET/PUT/validate llm-settings — never includes key material. */
export type LlmSettingsMetadata = {
  provider: LlmProvider | null;
  has_key: boolean;
  status: "none" | "unvalidated" | "valid" | "invalid";
  validated_at: string | null;
  last_error: string | null;
};

/** @description PUT /api/empresa/llm-settings body. */
export type PutLlmSettingsBody = {
  provider: LlmProvider;
  api_key: string;
};

/** @description Health payload from GET llm-settings/health. */
export type LlmHealthResponse =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "llm_not_configured"
        | "llm_key_missing"
        | "llm_key_unvalidated"
        | "llm_key_invalid";
    };

// ── UI contracts (pure) ────────────────────────────────────────────────────

/** @description Primary Experts page heading — must stay exactly "Experts" for e2e */

export const EXPERTS_PAGE_HEADING = "Experts";

/**
 * @description Tarefa detail delete is immediate — no AlertDialog/confirm (LD-3).
 */
export const TAREFA_DELETE_REQUIRES_CONFIRMATION = false;

/**
 * @description Build PATCH tarefa body — allowlisted keys only; null clears dono_id/prazo.
 */
export function buildTarefaPatchBody(form: {
  titulo: string;
  dono_id: string | null;
  prazo: string | null;
  status: string;
  notas: string;
}): Record<string, string | null> {
  return {
    titulo: form.titulo,
    dono_id: form.dono_id,
    prazo: form.prazo,
    status: form.status,
    notas: form.notas,
  };
}

/**
 * @description True when domain create actions (+ Expert / + Campanha) should show.
 * Admin papel only; membro and null are hidden.
 */
export function shouldShowDomainCreateActions(papel: string | null): boolean {
  return papel === "admin";
}

/** @description Dialog fields for creating a campanha (expert_id comes from the route). */
export type CreateCampanhaFields = {
  nome: string;
  tipo: CampanhaTipo;
  status?: CampanhaStatus;
  data_inicio?: string;
  data_fim?: string;
  notas?: string;
};

/**
 * @description Build POST campanha body with expert_id bound from the route only (no picker).
 * Defaults status to aberta when omitted. tipo must be one of CAMPANHA_TIPOS.
 */
export function buildCreateCampanhaBody(
  routeExpertId: string,
  fields: CreateCampanhaFields,
): CreateCampanhaBody {
  const body: CreateCampanhaBody = {
    expert_id: routeExpertId,
    nome: fields.nome,
    tipo: fields.tipo,
    status: fields.status ?? "aberta",
  };
  if (fields.data_inicio) {
    body.data_inicio = fields.data_inicio;
  }
  if (fields.data_fim) {
    body.data_fim = fields.data_fim;
  }
  if (fields.notas) {
    body.notas = fields.notas;
  }
  return body;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * @description Throw if response is not ok; used by all domain fetch wrappers.
 */
async function assertOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status}`);
  }
}

/**
 * @description JSON POST/PATCH/PUT init with credentials via authFetch.
 */
function jsonInit(
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ── Experts ────────────────────────────────────────────────────────────────

/**
 * @description GET /api/empresa/experts — list with abertas/atrasadas counts.
 */
export async function fetchExperts(): Promise<ExpertListRow[]> {
  const res = await authFetch(EXPERTS_API_PATH, { method: "GET" });
  await assertOk(res, "fetchExperts");
  const data = (await res.json()) as { experts: ExpertListRow[] };
  return data.experts;
}

/**
 * @description GET /api/empresa/experts/:id.
 */
export async function fetchExpert(id: string): Promise<ExpertRow> {
  const res = await authFetch(`${EXPERTS_API_PATH}/${id}`, { method: "GET" });
  await assertOk(res, "fetchExpert");
  return (await res.json()) as ExpertRow;
}

/**
 * @description POST /api/empresa/experts.
 */
export async function createExpert(body: CreateExpertBody): Promise<ExpertRow> {
  const res = await authFetch(EXPERTS_API_PATH, jsonInit("POST", body));
  await assertOk(res, "createExpert");
  return (await res.json()) as ExpertRow;
}

/**
 * @description PATCH /api/empresa/experts/:id.
 */
export async function patchExpert(
  id: string,
  body: PatchExpertBody,
): Promise<ExpertRow> {
  const res = await authFetch(
    `${EXPERTS_API_PATH}/${id}`,
    jsonInit("PATCH", body),
  );
  await assertOk(res, "patchExpert");
  return (await res.json()) as ExpertRow;
}

/**
 * @description DELETE /api/empresa/experts/:id — 204 on success.
 */
export async function deleteExpert(id: string): Promise<void> {
  const res = await authFetch(`${EXPERTS_API_PATH}/${id}`, {
    method: "DELETE",
  });
  await assertOk(res, "deleteExpert");
}

// ── Campanhas ──────────────────────────────────────────────────────────────

/**
 * @description GET /api/empresa/experts/:expertId/campanhas.
 */
export async function fetchCampanhasByExpert(
  expertId: string,
): Promise<CampanhaRow[]> {
  const res = await authFetch(expertCampanhasApiPath(expertId), {
    method: "GET",
  });
  await assertOk(res, "fetchCampanhasByExpert");
  const data = (await res.json()) as { campanhas: CampanhaRow[] };
  return data.campanhas;
}

/**
 * @description GET /api/empresa/campanhas/:id.
 */
export async function fetchCampanha(id: string): Promise<CampanhaRow> {
  const res = await authFetch(`${CAMPANHAS_API_PATH}/${id}`, {
    method: "GET",
  });
  await assertOk(res, "fetchCampanha");
  return (await res.json()) as CampanhaRow;
}

/**
 * @description POST /api/empresa/campanhas.
 */
export async function createCampanha(
  body: CreateCampanhaBody,
): Promise<CampanhaRow> {
  const res = await authFetch(CAMPANHAS_API_PATH, jsonInit("POST", body));
  await assertOk(res, "createCampanha");
  return (await res.json()) as CampanhaRow;
}

/**
 * @description PATCH /api/empresa/campanhas/:id.
 */
export async function patchCampanha(
  id: string,
  body: PatchCampanhaBody,
): Promise<CampanhaRow> {
  const res = await authFetch(
    `${CAMPANHAS_API_PATH}/${id}`,
    jsonInit("PATCH", body),
  );
  await assertOk(res, "patchCampanha");
  return (await res.json()) as CampanhaRow;
}

/**
 * @description DELETE /api/empresa/campanhas/:id — 204 on success.
 */
export async function deleteCampanha(id: string): Promise<void> {
  const res = await authFetch(`${CAMPANHAS_API_PATH}/${id}`, {
    method: "DELETE",
  });
  await assertOk(res, "deleteCampanha");
}

// ── Tarefas ────────────────────────────────────────────────────────────────

/**
 * @description GET /api/empresa/campanhas/:campanhaId/tarefas.
 */
export async function fetchTarefasByCampanha(
  campanhaId: string,
): Promise<TarefaRow[]> {
  const res = await authFetch(campanhaTarefasApiPath(campanhaId), {
    method: "GET",
  });
  await assertOk(res, "fetchTarefasByCampanha");
  const data = (await res.json()) as { tarefas: TarefaRow[] };
  return data.tarefas;
}

/**
 * @description GET /api/empresa/tarefas/:id.
 */
export async function fetchTarefa(id: string): Promise<TarefaRow> {
  const res = await authFetch(`${TAREFAS_API_PATH}/${id}`, { method: "GET" });
  await assertOk(res, "fetchTarefa");
  return (await res.json()) as TarefaRow;
}

/**
 * @description POST /api/empresa/tarefas.
 */
export async function createTarefa(body: CreateTarefaBody): Promise<TarefaRow> {
  const res = await authFetch(TAREFAS_API_PATH, jsonInit("POST", body));
  await assertOk(res, "createTarefa");
  return (await res.json()) as TarefaRow;
}

/**
 * @description PATCH /api/empresa/tarefas/:id.
 */
export async function patchTarefa(
  id: string,
  body: PatchTarefaBody,
): Promise<TarefaRow> {
  const res = await authFetch(
    `${TAREFAS_API_PATH}/${id}`,
    jsonInit("PATCH", body),
  );
  await assertOk(res, "patchTarefa");
  return (await res.json()) as TarefaRow;
}

/**
 * @description DELETE /api/empresa/tarefas/:id — 204 on success.
 */
export async function deleteTarefa(id: string): Promise<void> {
  const res = await authFetch(`${TAREFAS_API_PATH}/${id}`, {
    method: "DELETE",
  });
  await assertOk(res, "deleteTarefa");
}

// ── Membros ────────────────────────────────────────────────────────────────

/**
 * @description GET /api/empresa/membros.
 */
export async function fetchMembros(): Promise<MembroListRow[]> {
  const res = await authFetch(MEMBROS_API_PATH, { method: "GET" });
  await assertOk(res, "fetchMembros");
  const data = (await res.json()) as { membros: MembroListRow[] };
  return data.membros;
}

/**
 * @description POST /api/empresa/membros (admin).
 */
export async function createMembro(body: CreateMembroBody): Promise<{
  user: { id: string; name: string; email: string };
  papel: string;
  created: boolean;
}> {
  const res = await authFetch(MEMBROS_API_PATH, jsonInit("POST", body));
  await assertOk(res, "createMembro");
  return (await res.json()) as {
    user: { id: string; name: string; email: string };
    papel: string;
    created: boolean;
  };
}

// ── LLM settings ───────────────────────────────────────────────────────────

/**
 * @description GET /api/empresa/llm-settings — Metadata DTO only (admin).
 */
export async function fetchLlmSettings(): Promise<LlmSettingsMetadata> {
  const res = await authFetch(LLM_SETTINGS_API_PATH, { method: "GET" });
  await assertOk(res, "fetchLlmSettings");
  return (await res.json()) as LlmSettingsMetadata;
}

/**
 * @description PUT /api/empresa/llm-settings — encrypts key server-side; returns Metadata only.
 */
export async function putLlmSettings(
  body: PutLlmSettingsBody,
): Promise<LlmSettingsMetadata> {
  const res = await authFetch(LLM_SETTINGS_API_PATH, jsonInit("PUT", body));
  await assertOk(res, "putLlmSettings");
  return (await res.json()) as LlmSettingsMetadata;
}

/**
 * @description POST /api/empresa/llm-settings/validate — probe provider; returns Metadata only.
 */
export async function validateLlmSettings(): Promise<LlmSettingsMetadata> {
  const res = await authFetch(LLM_VALIDATE_API_PATH, { method: "POST" });
  await assertOk(res, "validateLlmSettings");
  return (await res.json()) as LlmSettingsMetadata;
}

/**
 * @description GET /api/empresa/llm-settings/health — any active member.
 */
export async function fetchLlmHealth(): Promise<LlmHealthResponse> {
  const res = await authFetch(LLM_HEALTH_API_PATH, { method: "GET" });
  await assertOk(res, "fetchLlmHealth");
  return (await res.json()) as LlmHealthResponse;
}

// ── Telegram bindings (admin) ────────────────────────────────────────────────

/** @description Status DTO from GET telegram-bindings — booleans + timestamps only, never chat/thread ids or raw codes. */
export type TelegramBindingsStatus = {
  empresa: { linked: boolean; linked_at?: string };
  experts: Array<{
    expert_id: string;
    nome: string;
    linked: boolean;
    linked_at?: string;
  }>;
};

/** @description Mint response from POST empresa-command / expert-command. */
export type TelegramMintResponse = {
  command: string;
  expires_at: string;
};

/**
 * @description GET /api/empresa/telegram-bindings — status for active empresa (via session cookie).
 */
export async function fetchBindings(): Promise<TelegramBindingsStatus> {
  const res = await authFetch(TELEGRAM_BINDINGS_API_PATH, { method: "GET" });
  await assertOk(res, "fetchBindings");
  return (await res.json()) as TelegramBindingsStatus;
}

/**
 * @description POST /api/empresa/telegram-bindings/empresa-command — mint empresa bind code.
 */
export async function mintEmpresaCommand(): Promise<TelegramMintResponse> {
  const res = await authFetch(
    TELEGRAM_EMPRESA_COMMAND_API_PATH,
    { method: "POST" },
  );
  await assertOk(res, "mintEmpresaCommand");
  return (await res.json()) as TelegramMintResponse;
}

/**
 * @description POST /api/empresa/telegram-bindings/expert-command — mint expert bind code for live same-tenant expert.
 */
export async function mintExpertCommand(
  expert_id: string,
): Promise<TelegramMintResponse> {
  const res = await authFetch(
    TELEGRAM_EXPERT_COMMAND_API_PATH,
    jsonInit("POST", { expert_id }),
  );
  await assertOk(res, "mintExpertCommand");
  return (await res.json()) as TelegramMintResponse;
}
