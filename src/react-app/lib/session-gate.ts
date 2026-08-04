/** @description Pure session-gate helpers for shell auth redirects and admin access. */

/** @description One empresa membership on the me payload. */
export type MeMembership = {
  empresa_id: string;
  nome: string;
  papel: string;
};

/** @description Authenticated user session shape from GET /api/auth/me. */
export type Me = {
  id: string;
  email: string;
  name: string;
  role: string;
  active_empresa_id: string | null;
  memberships: MeMembership[];
};

/**
 * @description True when there is no authenticated me session.
 */
export function needsLogin(me: Me | null): boolean {
  return me === null;
}

/**
 * @description True when user has multiple memberships and no active empresa selected.
 */
export function needsEmpresaPick(me: Me): boolean {
  return me.memberships.length > 1 && me.active_empresa_id === null;
}

/**
 * @description True when user has exactly one membership and no active empresa (auto-heal candidate).
 */
export function needsSingleMembershipHeal(me: Me): boolean {
  return me.memberships.length === 1 && me.active_empresa_id === null;
}

/**
 * @description True only when active empresa papel is admin (ignores users.role).
 */
export function canAccessAdmin(activePapel: string | null): boolean {
  return activePapel === "admin";
}

/**
 * @description True when path is the platform route (exempt from shell auth redirect).
 */
export function isPlatformRouteExempt(path: string): boolean {
  return path === "/platform";
}

/**
 * @description Shell redirect target, or null when no redirect is needed.
 */
export function shellRedirectPath(args: {
  authed: boolean;
  path: string;
}): string | null {
  if (!args.authed) {
    if (isPlatformRouteExempt(args.path)) {
      return null;
    }
    return "/login";
  }
  if (args.path === "/login") {
    return "/";
  }
  return null;
}
