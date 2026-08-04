/** @description Client-side tarefa list filters — status and donoId only (no campanha dimension). */

/** @description Accepted filter option keys — locked to status + donoId. */
export const FILTER_OPTION_KEYS = ["donoId", "status"] as const;

/** @description Minimal tarefa shape required by filterTarefas. */
export type FilterableTarefa = {
  status: string;
  dono_id: string | null;
};

/** @description Filter options — null means "all" for that dimension. */
export type TarefaFilterOptions = {
  status: string | null;
  donoId: string | null;
};

/**
 * @description Filter tarefas by status and/or donoId. Both null returns a shallow copy.
 * Extra keys on options (e.g. campanhaId) are ignored.
 */
export function filterTarefas<T extends FilterableTarefa>(
  list: readonly T[],
  options: TarefaFilterOptions,
): T[] {
  const { status, donoId } = options;
  return list.filter((row) => {
    if (status != null && row.status !== status) return false;
    if (donoId != null && row.dono_id !== donoId) return false;
    return true;
  });
}
