/** @description pt-br display labels for shared domain enums (campanha tipo/status, tarefa status). */

import type {
  CampanhaStatus,
  CampanhaTipo,
  TarefaStatus,
} from "../../shared/domain/enums.ts";
import {
  CAMPANHA_STATUS,
  CAMPANHA_TIPOS,
  TAREFA_STATUS,
} from "../../shared/domain/enums.ts";

const CAMPANHA_TIPO_LABELS: Record<CampanhaTipo, string> = {
  lancamento_pago: "Lançamento pago",
  gratuito: "Gratuito",
  perpetuo: "Perpétuo",
  webinario: "Webinário",
};

const CAMPANHA_STATUS_LABELS: Record<CampanhaStatus, string> = {
  aberta: "Aberta",
  encerrada: "Encerrada",
  arquivada: "Arquivada",
};

const TAREFA_STATUS_LABELS: Record<TarefaStatus, string> = {
  a_fazer: "A fazer",
  fazendo: "Fazendo",
  feito: "Feito",
};

/**
 * @description pt-br label for a campanha tipo enum value.
 */
export function labelCampanhaTipo(tipo: string): string {
  if ((CAMPANHA_TIPOS as readonly string[]).includes(tipo)) {
    return CAMPANHA_TIPO_LABELS[tipo as CampanhaTipo];
  }
  return tipo;
}

/**
 * @description pt-br label for a campanha status enum value.
 */
export function labelCampanhaStatus(status: string): string {
  if ((CAMPANHA_STATUS as readonly string[]).includes(status)) {
    return CAMPANHA_STATUS_LABELS[status as CampanhaStatus];
  }
  return status;
}

/**
 * @description pt-br label for a tarefa status enum value.
 */
export function labelTarefaStatus(status: string): string {
  if ((TAREFA_STATUS as readonly string[]).includes(status)) {
    return TAREFA_STATUS_LABELS[status as TarefaStatus];
  }
  return status;
}
