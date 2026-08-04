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
] as const;

/**
 * @description True when path is a shell-auth-protected route (not platform).
 */
export function isShellAuthPath(path: string): boolean {
  return (SHELL_AUTH_PATHS as readonly string[]).includes(path);
}

/**
 * @description Under RequireAuth: multi-membership without active → empresa-picker; else shell.
 */
export function resolveShellBranch(me: Me): "empresa-picker" | "shell" {
  return needsEmpresaPick(me) ? "empresa-picker" : "shell";
}
