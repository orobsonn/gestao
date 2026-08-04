/** @description Session-state AuthProvider — me/login/logout/setActiveEmpresa; never renders picker. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  getMe,
  login as apiLogin,
  logout as apiLogout,
  setActiveEmpresa as apiSetActiveEmpresa,
} from "@/lib/auth-api";
import {
  needsSingleMembershipHeal,
  type Me,
} from "@/lib/session-gate";

/** @description Auth context value exposed to the shell. */
export type AuthContextValue = {
  me: Me | null;
  loading: boolean;
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: true } | { ok: false; status: number }>;
  logout: () => Promise<void>;
  setActiveEmpresa: (
    empresaId: string,
  ) => Promise<{ ok: true } | { ok: false; status: number }>;
  refreshMe: () => Promise<Me | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * @description Auto-heal single membership: POST sole empresa then refresh me.
 */
async function healSingleMembershipIfNeeded(me: Me): Promise<Me> {
  if (!needsSingleMembershipHeal(me)) {
    return me;
  }
  const soleId = me.memberships[0]?.empresa_id;
  if (!soleId) {
    return me;
  }
  const result = await apiSetActiveEmpresa(soleId);
  if (!result.ok) {
    return me;
  }
  try {
    const refreshed = await getMe();
    return refreshed ?? me;
  } catch {
    return me;
  }
}

/**
 * @description Provides session state only — children always rendered (router stays mounted).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const setActiveEmpresaGenRef = useRef(0);

  const refreshMe = useCallback(async (): Promise<Me | null> => {
    try {
      const next = await getMe();
      if (next && needsSingleMembershipHeal(next)) {
        const healed = await healSingleMembershipIfNeeded(next);
        setMe(healed);
        return healed;
      }
      setMe(next);
      return next;
    } catch {
      // keep prior me on 5xx / network — do not wipe session
      return me;
    }
  }, [me]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await getMe();
        if (cancelled) return;
        if (next && needsSingleMembershipHeal(next)) {
          const healed = await healSingleMembershipIfNeeded(next);
          if (!cancelled) setMe(healed);
        } else if (!cancelled) {
          setMe(next);
        }
      } catch {
        // keep prior me (null on cold mount) — do not wipe on 5xx
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (
      email: string,
      password: string,
    ): Promise<{ ok: true } | { ok: false; status: number }> => {
      const result = await apiLogin(email, password);
      if (!result.ok) {
        return result;
      }
      // after_login_get_me — never treat login JSON as full me
      let next: Me | null;
      try {
        next = await getMe();
      } catch {
        // orphan cookie: login set session but me failed — clear cookie
        try {
          await apiLogout();
        } catch {
          // best-effort cookie clear
        }
        return { ok: false, status: 503 };
      }
      if (!next) {
        try {
          await apiLogout();
        } catch {
          // best-effort cookie clear
        }
        return { ok: false, status: 503 };
      }
      if (needsSingleMembershipHeal(next)) {
        const healed = await healSingleMembershipIfNeeded(next);
        setMe(healed);
      } else {
        setMe(next);
      }
      return { ok: true };
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiLogout();
      setMe(null);
    } catch {
      toast.error("Não foi possível sair. Tente novamente.");
      // do not clear me — server session may still be valid
    }
  }, []);

  const setActiveEmpresa = useCallback(
    async (
      empresaId: string,
    ): Promise<{ ok: true } | { ok: false; status: number }> => {
      const reqId = ++setActiveEmpresaGenRef.current;
      const result = await apiSetActiveEmpresa(empresaId);
      if (!result.ok) {
        if (result.status === 403) {
          toast.error("Sem permissão para esta empresa.");
        }
        // keep prior me on failure
        return result;
      }
      // Server already switched — optimistic update so client never lags
      if (reqId === setActiveEmpresaGenRef.current) {
        setMe((prev) =>
          prev ? { ...prev, active_empresa_id: empresaId } : prev,
        );
      }
      // after_set_active_empresa_get_me — refresh if possible; keep optimistic on 5xx
      try {
        const next = await getMe();
        if (reqId !== setActiveEmpresaGenRef.current) {
          return { ok: true }; // stale response — newer request owns state
        }
        if (next === null) {
          // 401 — do NOT keep optimistic
          setMe(null);
          return { ok: false, status: 401 };
        }
        if (needsSingleMembershipHeal(next)) {
          const healed = await healSingleMembershipIfNeeded(next);
          if (reqId === setActiveEmpresaGenRef.current) {
            setMe(healed);
          }
        } else {
          setMe(next);
        }
        return { ok: true };
      } catch {
        // 5xx / network — keep optimistic if still current
        if (reqId === setActiveEmpresaGenRef.current) {
          toast.message(
            "Sessão atualizada; recarregue se algo parecer desatualizado.",
          );
        }
        return { ok: true };
      }
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      me,
      loading,
      login,
      logout,
      setActiveEmpresa,
      refreshMe,
    }),
    [me, loading, login, logout, setActiveEmpresa, refreshMe],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

/**
 * @description Hook for auth session context; throws outside AuthProvider.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
