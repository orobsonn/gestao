/** @description Route guard — empresa admin papel only; else Navigate to /. */

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { resolveActivePapel } from "@/lib/active-papel";
import { canAccessAdmin } from "@/lib/session-gate";
import { useAuth } from "@/providers/auth-provider";

/**
 * @description Renders children only when active papel is admin (ignores users.role).
 */
export function RequireEmpresaAdmin({ children }: { children: ReactNode }) {
  const { me } = useAuth();

  if (!me) {
    return <Navigate to="/" replace />;
  }

  const activePapel = resolveActivePapel({
    activeEmpresaId: me.active_empresa_id,
    memberships: me.memberships,
  });

  if (!canAccessAdmin(activePapel)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
