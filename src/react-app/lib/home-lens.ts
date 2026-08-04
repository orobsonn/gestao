/** @description Pure home lens → KPI/list/chart visibility matrix (admin toggle + membro). */

/** @description Admin lens ids for the Home toggle-group. */
export type HomeLensId = "tudo" | "so_meu" | "so_empresa";

/** @description Membership papel that drives Home visibility. */
export type HomePapel = "admin" | "membro";

/** @description One KPI card binding: pt-br label → payload field key. */
export type HomeKpiBinding = {
  label: string;
  field: string;
};

/** @description Resolved UI visibility for the Home dashboard. */
export type HomeLensResult = {
  showToggle: boolean;
  showMeuTrabalho: boolean;
  showEmpresaAbertas: boolean;
  showCharts: boolean;
  showAtrasadasPorExpert: boolean;
  kpis: HomeKpiBinding[];
  /** Effective lens after role forcing (membro always personal). */
  lens: HomeLensId;
};

/** @description Stable admin lens ids in toggle order. */
export const HOME_LENS_IDS = ["tudo", "so_meu", "so_empresa"] as const satisfies readonly HomeLensId[];

/** @description Default admin lens when none selected. */
export const DEFAULT_ADMIN_LENS: HomeLensId = "tudo";

/** @description pt-br labels for the admin lens toggle. */
export const HOME_LENS_LABELS: Record<HomeLensId, string> = {
  tudo: "Tudo",
  so_meu: "Só meu",
  so_empresa: "Só empresa",
};

const KPIS_TUDO: HomeKpiBinding[] = [
  { label: "Atrasadas", field: "atrasadas_empresa" },
  { label: "Hoje", field: "vencem_hoje_empresa" },
  { label: "Minhas", field: "minhas_abertas" },
  { label: "Feitas 7d", field: "feitas_7d_empresa" },
];

const KPIS_SO_MEU: HomeKpiBinding[] = [
  { label: "Atrasadas", field: "minhas_atrasadas" },
  { label: "Hoje", field: "minhas_vencem_hoje" },
  { label: "Minhas", field: "minhas_abertas" },
  { label: "Feitas 7d", field: "minhas_feitas_7d" },
];

const KPIS_SO_EMPRESA: HomeKpiBinding[] = [
  { label: "Atrasadas", field: "atrasadas_empresa" },
  { label: "Hoje", field: "vencem_hoje_empresa" },
  { label: "Abertas", field: "abertas_empresa" },
  { label: "Feitas 7d", field: "feitas_7d_empresa" },
];

/**
 * @description Normalize optional lens to a known admin id (default tudo).
 */
function normalizeLens(lens: string | undefined): HomeLensId {
  if (lens === "so_meu" || lens === "so_empresa" || lens === "tudo") {
    return lens;
  }
  return DEFAULT_ADMIN_LENS;
}

/**
 * @description Map papel + admin lens to exclusive Home UI visibility (KPIs, lists, charts).
 * Membro ignores lens and is forced to personal-only (no toggle, no empresa list, no expert chart).
 */
export function resolveHomeLens(args: {
  papel: string;
  lens?: string;
}): HomeLensResult {
  if (args.papel === "membro") {
    return {
      showToggle: false,
      showMeuTrabalho: true,
      showEmpresaAbertas: false,
      // Personal urgencia/status only — never expert breakdown.
      showCharts: true,
      showAtrasadasPorExpert: false,
      kpis: KPIS_SO_MEU,
      lens: "so_meu",
    };
  }

  const lens = normalizeLens(args.lens);

  if (lens === "so_meu") {
    return {
      showToggle: true,
      showMeuTrabalho: true,
      showEmpresaAbertas: false,
      showCharts: false,
      showAtrasadasPorExpert: false,
      kpis: KPIS_SO_MEU,
      lens,
    };
  }

  if (lens === "so_empresa") {
    return {
      showToggle: true,
      showMeuTrabalho: false,
      showEmpresaAbertas: true,
      showCharts: true,
      showAtrasadasPorExpert: true,
      kpis: KPIS_SO_EMPRESA,
      lens,
    };
  }

  // tudo (default admin)
  return {
    showToggle: true,
    showMeuTrabalho: true,
    showEmpresaAbertas: true,
    showCharts: true,
    showAtrasadasPorExpert: true,
    kpis: KPIS_TUDO,
    lens: "tudo",
  };
}
