/** @description Route guard — redirects unauthenticated users to /login. */

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/providers/auth-provider";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * @description Renders children only when me is present; loading skeleton while session loads.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="flex w-full max-w-sm flex-col gap-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>
    );
  }

  if (!me) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
