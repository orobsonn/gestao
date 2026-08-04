/** @description Home dashboard API client and UI constants (path, heading, KPI theme tokens). */

import { authFetch } from "./auth-api.ts";

/** @description GET path for the empresa home dashboard payload. */
export const HOME_API_PATH = "/api/empresa/home";

/** @description Primary page heading — must stay exactly "Home" for e2e /^home$/i. */
export const HOME_PAGE_HEADING = "Home";

/** @description Lead copy under the Home h1. */
export const HOME_PAGE_LEAD = "Visão do dia";

/**
 * @description Theme-token class map for KPI cards/badges — semantic utilities only, no raw hex.
 */
export const HOME_KPI_THEME_CLASSES = {
  card: "bg-card border border-border text-card-foreground shadow",
  label: "text-sm font-medium text-muted-foreground",
  value: "text-2xl font-semibold tabular-nums text-foreground",
  valueDestructive: "text-2xl font-semibold tabular-nums text-destructive",
  badgeAtrasada:
    "border border-border bg-card text-destructive",
  badgeDefault: "border border-border bg-card text-muted-foreground",
  sectionTitle: "text-base font-semibold text-foreground",
  muted: "text-muted-foreground",
} as const;

/** @description Open-task row in home lists. */
export type HomeTarefa = {
  id: string;
  titulo: string;
  status: string;
  prazo: string | null;
  dono_id: string | null;
  dono_nome: string | null;
  campanha_id: string;
  expert_id: string;
  expert_nome: string;
  atrasada: boolean;
};

/** @description Canonical KPI block from GET /api/empresa/home. */
export type HomeKpis = {
  atrasadas_empresa: number;
  vencem_hoje_empresa: number;
  abertas_empresa: number;
  feitas_7d_empresa: number;
  minhas_atrasadas: number;
  minhas_vencem_hoje: number;
  minhas_abertas: number;
  minhas_feitas_7d: number;
};

/** @description Fixed payload shape for GET /api/empresa/home. */
export type HomePayload = {
  papel: "admin" | "membro";
  viewer_user_id: string;
  kpis: HomeKpis;
  charts: {
    urgencia: Array<{
      bucket: "atrasadas" | "hoje" | "semana" | "depois";
      count: number;
    }>;
    status: Array<{
      key: "atrasada" | "a_fazer" | "fazendo" | "feito";
      count: number;
    }>;
    atrasadas_por_expert: Array<{
      expert_id: string;
      expert_nome: string;
      count: number;
    }>;
  };
  meu_trabalho: HomeTarefa[];
  empresa_abertas: HomeTarefa[];
};

/**
 * @description GET /api/empresa/home with credentials include; throws on !ok.
 */
export async function fetchHome(): Promise<HomePayload> {
  const res = await authFetch(HOME_API_PATH, { method: "GET" });
  if (!res.ok) {
    throw new Error(`home failed: ${res.status}`);
  }
  return (await res.json()) as HomePayload;
}
