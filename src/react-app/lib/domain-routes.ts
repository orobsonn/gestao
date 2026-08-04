/** @description Domain path builders, breadcrumb helpers, and campanha-task UI contracts. */

import type { TarefaStatus } from "../../shared/domain/enums.ts";

/** @description SPA path prefix for the experts list and nested expert routes. */
export const EXPERTS_PATH_PREFIX = "/experts";

/** @description SPA path prefix for tarefa detail routes. */
export const TAREFAS_PATH_PREFIX = "/tarefas";

/** @description Root breadcrumb label for the experts domain. */
export const BREADCRUMB_ROOT_LABEL = "Experts";

/**
 * @description Filter control ids on CampanhaTarefasPage — exactly status + dono (no campanha).
 * Locked tests import this from domain-api; re-export there when scope allows.
 */
export const CAMPANHA_TASK_FILTER_CONTROL_IDS = ["status", "dono"] as const;

/** @description Optional display names for breadcrumb segments. */
export type DomainBreadcrumbNames = {
  expert?: string;
  campanha?: string;
  tarefa?: string;
};

/** @description One breadcrumb trail segment (label + optional link href). */
export type DomainBreadcrumbSegment = {
  label: string;
  href?: string;
};

/** @description Dialog fields for creating a tarefa (campanha_id comes from the route). */
export type CreateTarefaFields = {
  titulo: string;
  status?: TarefaStatus;
  dono_id?: string | null;
  prazo?: string | null;
  notas?: string | null;
};

/** @description POST tarefa body shape from buildCreateTarefaBody (mirrors domain-api CreateTarefaBody). */
export type BuiltCreateTarefaBody = {
  campanha_id: string;
  titulo: string;
  notas?: string;
  status?: TarefaStatus;
  prazo?: string;
  dono_id?: string;
};

/**
 * @description Build POST tarefa body with campanha_id bound from the route.
 * Defaults status to a_fazer when omitted. Empty optional fields are omitted.
 * Locked tests import this from domain-api; re-export there when scope allows.
 */
export function buildCreateTarefaBody(
  campanhaId: string,
  fields: CreateTarefaFields,
): BuiltCreateTarefaBody {
  const body: BuiltCreateTarefaBody = {
    campanha_id: campanhaId,
    titulo: fields.titulo,
    status: fields.status ?? "a_fazer",
  };
  if (fields.dono_id) {
    body.dono_id = fields.dono_id;
  }
  if (fields.prazo) {
    body.prazo = fields.prazo;
  }
  if (fields.notas) {
    body.notas = fields.notas;
  }
  return body;
}

/**
 * @description Build SPA path for an expert detail/campanhas list: /experts/:expertId.
 */
export function buildExpertPath(expertId: string): string {
  return `${EXPERTS_PATH_PREFIX}/${expertId}`;
}

/**
 * @description Build SPA path for a campanha under an expert: /experts/:expertId/campanhas/:campanhaId.
 */
export function buildCampanhaPath(expertId: string, campanhaId: string): string {
  return `${EXPERTS_PATH_PREFIX}/${expertId}/campanhas/${campanhaId}`;
}

/**
 * @description Build SPA path for a tarefa detail: /tarefas/:tarefaId.
 */
export function buildTarefaPath(tarefaId: string): string {
  return `${TAREFAS_PATH_PREFIX}/${tarefaId}`;
}

/**
 * @description Back path from tarefa detail to its campaign list (after GET campanha).
 */
export function buildTarefaBackPath(campanha: {
  id: string;
  expert_id: string;
}): string {
  return buildCampanhaPath(campanha.expert_id, campanha.id);
}

/** @description Result of nested campanha route expert_id integrity check. */
export type CampanhaRouteIntegrityResult =
  | { action: "ok" }
  | { action: "redirect"; to: string };

/**
 * @description Canonical-redirect when route expertId mismatches campanha.expert_id (LD-15).
 * Match → { action: 'ok' }; mismatch → redirect to /experts/{campanha.expert_id}/campanhas/{id}.
 */
export function resolveCampanhaRouteIntegrity(
  routeExpertId: string,
  campanha: { id: string; expert_id: string },
): CampanhaRouteIntegrityResult {
  if (campanha.expert_id !== routeExpertId) {
    return {
      action: "redirect",
      to: buildCampanhaPath(campanha.expert_id, campanha.id),
    };
  }
  return { action: "ok" };
}

/**
 * @description Resolve hierarchical breadcrumb segments for domain pathnames.
 * Nested expert/campanha paths never collapse to a single "Gestão" title.
 */
export function resolveDomainBreadcrumbSegments(input: {
  pathname: string;
  names?: DomainBreadcrumbNames;
}): DomainBreadcrumbSegment[] {
  const pathname = input.pathname.replace(/\/+$/, "") || "/";
  const names = input.names ?? {};

  if (pathname === EXPERTS_PATH_PREFIX) {
    return [{ label: BREADCRUMB_ROOT_LABEL }];
  }

  const expertCampanha = pathname.match(
    /^\/experts\/([^/]+)\/campanhas\/([^/]+)$/,
  );
  if (expertCampanha) {
    const expertId = expertCampanha[1];
    const campanhaId = expertCampanha[2];
    return [
      { label: BREADCRUMB_ROOT_LABEL, href: EXPERTS_PATH_PREFIX },
      {
        label: names.expert ?? expertId,
        href: buildExpertPath(expertId),
      },
      {
        label: names.campanha ?? campanhaId,
      },
    ];
  }

  const expertOnly = pathname.match(/^\/experts\/([^/]+)$/);
  if (expertOnly) {
    const expertId = expertOnly[1];
    return [
      { label: BREADCRUMB_ROOT_LABEL, href: EXPERTS_PATH_PREFIX },
      { label: names.expert ?? expertId },
    ];
  }

  const tarefaOnly = pathname.match(/^\/tarefas\/([^/]+)$/);
  if (tarefaOnly) {
    const tarefaId = tarefaOnly[1];
    return [
      {
        label: names.tarefa ?? "Tarefa",
      },
    ];
  }

  return [{ label: BREADCRUMB_ROOT_LABEL, href: EXPERTS_PATH_PREFIX }];
}
