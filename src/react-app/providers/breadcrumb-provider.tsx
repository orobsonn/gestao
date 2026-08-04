/** @description Page-provided domain breadcrumb display names with clear-on-unmount lifecycle. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DomainBreadcrumbNames } from "@/lib/domain-routes";

/** @description Breadcrumb context value — names plus setters for domain pages. */
export type BreadcrumbContextValue = {
  names: DomainBreadcrumbNames;
  setBreadcrumbNames: (names: DomainBreadcrumbNames) => void;
  clearBreadcrumbNames: () => void;
};

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

/**
 * @description Holds expert/campanha/tarefa display names for the shell breadcrumb trail.
 * Must wrap AppShell children so domain pages can set names after load.
 */
export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [names, setNames] = useState<DomainBreadcrumbNames>({});

  const setBreadcrumbNames = useCallback((next: DomainBreadcrumbNames) => {
    setNames(next);
  }, []);

  const clearBreadcrumbNames = useCallback(() => {
    setNames({});
  }, []);

  const value = useMemo(
    () => ({ names, setBreadcrumbNames, clearBreadcrumbNames }),
    [names, setBreadcrumbNames, clearBreadcrumbNames],
  );

  return (
    <BreadcrumbContext.Provider value={value}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

/**
 * @description Read/write breadcrumb names from any descendant of BreadcrumbProvider.
 */
export function useBreadcrumbContext(): BreadcrumbContextValue {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) {
    throw new Error(
      "useBreadcrumbContext must be used within BreadcrumbProvider",
    );
  }
  return ctx;
}

/**
 * @description Pages set domain breadcrumb display names on mount; clears on unmount
 * so previous expert/campanha labels never stick on /experts or sibling routes.
 */
export function useDomainBreadcrumbNames(names: DomainBreadcrumbNames): void {
  const { setBreadcrumbNames, clearBreadcrumbNames } = useBreadcrumbContext();

  useEffect(() => {
    setBreadcrumbNames(names);
    return () => {
      clearBreadcrumbNames();
    };
  }, [
    names.expert,
    names.campanha,
    names.tarefa,
    setBreadcrumbNames,
    clearBreadcrumbNames,
  ]);
}
