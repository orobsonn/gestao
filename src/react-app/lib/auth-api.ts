/** @description Cookie-session auth API client — credentials include, never stores password. */

import type { Me } from "./session-gate.ts";

export type { Me } from "./session-gate.ts";

/** @description Default fetch init for auth endpoints (cookie session). */
export const AUTH_FETCH_DEFAULTS = {
  credentials: "include" as RequestCredentials,
};

export const AUTH_ME_PATH = "/api/auth/me";
export const AUTH_LOGIN_PATH = "/api/auth/login";
export const AUTH_LOGOUT_PATH = "/api/auth/logout";
export const AUTH_ACTIVE_EMPRESA_PATH = "/api/auth/active-empresa";

/**
 * @description Builds POST /api/auth/active-empresa body with exact key empresa_id.
 */
export function buildActiveEmpresaBody(empresaId: string): {
  empresa_id: string;
} {
  return { empresa_id: empresaId };
}

/**
 * @description fetch wrapper that always merges AUTH_FETCH_DEFAULTS (credentials include).
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, {
    ...AUTH_FETCH_DEFAULTS,
    ...init,
    credentials: AUTH_FETCH_DEFAULTS.credentials,
  });
}

/**
 * @description GET /api/auth/me — 401 → null; other !ok → throw (callers keep prior me).
 */
export async function getMe(): Promise<Me | null> {
  const res = await authFetch(AUTH_ME_PATH, { method: "GET" });
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`getMe failed: ${res.status}`);
  }
  return (await res.json()) as Me;
}

/**
 * @description POST /api/auth/login — does not treat response JSON as full me.
 */
export async function login(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const res = await authFetch(AUTH_LOGIN_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

/**
 * @description POST /api/auth/logout — clears server session cookie; throws if !ok.
 */
export async function logout(): Promise<void> {
  const res = await authFetch(AUTH_LOGOUT_PATH, { method: "POST" });
  if (!res.ok) {
    throw new Error(`logout failed: ${res.status}`);
  }
}

/**
 * @description POST /api/auth/active-empresa with body { empresa_id }.
 */
export async function setActiveEmpresa(
  empresaId: string,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const res = await authFetch(AUTH_ACTIVE_EMPRESA_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildActiveEmpresaBody(empresaId)),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  return { ok: true };
}
