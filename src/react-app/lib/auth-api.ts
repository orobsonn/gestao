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
export const AUTH_TELEGRAM_LINK_PATH = "/api/auth/telegram-link";

/** @description Response from POST /api/auth/telegram-link (mint deep-link). */
export type TelegramLinkMintResponse = {
  deep_link: string;
  expires_at: string;
};

/**
 * @description Normalize raw /me JSON into Me — telegram.linked defaults to false if missing.
 */
function parseMe(raw: unknown): Me {
  const body = (raw ?? {}) as Partial<Me> & {
    telegram?: { linked?: boolean } | null;
  };
  return {
    id: String(body.id ?? ""),
    email: String(body.email ?? ""),
    name: String(body.name ?? ""),
    role: String(body.role ?? ""),
    active_empresa_id:
      body.active_empresa_id === undefined || body.active_empresa_id === null
        ? null
        : String(body.active_empresa_id),
    memberships: Array.isArray(body.memberships) ? body.memberships : [],
    telegram: {
      linked: body.telegram?.linked === true,
    },
  };
}

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
 * Parses telegram.linked (defaults to false when missing).
 */
export async function getMe(): Promise<Me | null> {
  const res = await authFetch(AUTH_ME_PATH, { method: "GET" });
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`getMe failed: ${res.status}`);
  }
  return parseMe(await res.json());
}

/**
 * @description POST /api/auth/telegram-link — mints a one-time deep_link (credentials include).
 */
export async function mintTelegramLink(): Promise<TelegramLinkMintResponse> {
  const res = await authFetch(AUTH_TELEGRAM_LINK_PATH, { method: "POST" });
  if (!res.ok) {
    throw new Error(`mintTelegramLink failed: ${res.status}`);
  }
  const body = (await res.json()) as Partial<TelegramLinkMintResponse>;
  if (typeof body.deep_link !== "string" || typeof body.expires_at !== "string") {
    throw new Error("mintTelegramLink: invalid response shape");
  }
  return { deep_link: body.deep_link, expires_at: body.expires_at };
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
