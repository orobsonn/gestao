/** @description Pure shell route table — auth paths, platform exemption, picker branch. */

import { needsEmpresaPick, type Me } from "./session-gate.ts";

export const LOGIN_PATH = "/login";
export const PLATFORM_PATH = "/platform";
export const UNKNOWN_PATH_REDIRECT = "/";

/** @description Paths that require auth and live under the shell (not /platform). */
export const SHELL_AUTH_PATHS = [
  "/",
  "/experts",
  "/meu-trabalho",
  "/admin",
  "/minha-conta",
] as const;

/** @description Prefix for tarefa detail routes under the shell (`/tarefas/:id`). */
export const TAREFA_DETAIL_PATH_PREFIX = "/tarefas/";

/**
 * @description Build the shell path for a tarefa detail: `/tarefas/${id}`.
 */
export function buildTarefaDetailPath(id: string): string {
  return `${TAREFA_DETAIL_PATH_PREFIX}${id}`;
}

/**
 * @description True when path is a shell-auth-protected route (not platform).
 * Exact SHELL_AUTH_PATHS plus parameterized `/tarefas/:id`, `/experts/:id`,
 * and `/experts/:id/campanhas/:id` (non-empty segments only).
 */
export function isShellAuthPath(path: string): boolean {
  if ((SHELL_AUTH_PATHS as readonly string[]).includes(path)) {
    return true;
  }
  // `/tarefas/:id` — require a non-empty segment after the prefix
  if (
    path.startsWith(TAREFA_DETAIL_PATH_PREFIX) &&
    path.length > TAREFA_DETAIL_PATH_PREFIX.length
  ) {
    return true;
  }
  // `/experts/:expertId/campanhas/:campanhaId` — both segments non-empty
  if (/^\/experts\/[^/]+\/campanhas\/[^/]+$/.test(path)) {
    return true;
  }
  // `/experts/:expertId` — expert id non-empty (not bare `/experts/`)
  if (/^\/experts\/[^/]+$/.test(path)) {
    return true;
  }
  return false;
}

/**
 * @description Under RequireAuth: multi-membership without active → empresa-picker; else shell.
 */
export function resolveShellBranch(me: Me): "empresa-picker" | "shell" {
  return needsEmpresaPick(me) ? "empresa-picker" : "shell";
}
