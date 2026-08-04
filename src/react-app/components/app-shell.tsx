/** @description App shell layout — SidebarProvider, AppSidebar, hierarchical breadcrumb + ModeToggle, main. */

import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  resolveDomainBreadcrumbSegments,
  type DomainBreadcrumbSegment,
} from "@/lib/domain-routes";
import {
  BreadcrumbProvider,
  useBreadcrumbContext,
} from "@/providers/breadcrumb-provider";

const PATH_TITLES: Record<string, string> = {
  "/": "Home",
  "/experts": "Experts",
  "/meu-trabalho": "Meu trabalho",
  "/admin": "Admin",
};

/**
 * @description True when pathname is a domain route that uses hierarchical breadcrumb segments.
 */
function isDomainBreadcrumbPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/experts") return true;
  if (/^\/experts\/[^/]+$/.test(p)) return true;
  if (/^\/experts\/[^/]+\/campanhas\/[^/]+$/.test(p)) return true;
  if (/^\/tarefas\/[^/]+$/.test(p)) return true;
  return false;
}

/**
 * @description Resolve breadcrumb trail: domain hierarchy or static PATH_TITLES (never sole Gestão on nested domain).
 */
function resolveShellBreadcrumbSegments(
  pathname: string,
  names: { expert?: string; campanha?: string; tarefa?: string },
): DomainBreadcrumbSegment[] {
  if (isDomainBreadcrumbPath(pathname)) {
    return resolveDomainBreadcrumbSegments({ pathname, names });
  }
  return [{ label: PATH_TITLES[pathname] ?? "Gestão" }];
}

/**
 * @description Header breadcrumb trail driven by pathname + page-provided domain names.
 */
function AppShellBreadcrumb() {
  const { pathname } = useLocation();
  const { names } = useBreadcrumbContext();
  const segments = resolveShellBreadcrumbSegments(pathname, names);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          return (
            <Fragment key={`${seg.label}-${i}`}>
              {i > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem>
                {isLast || !seg.href ? (
                  <BreadcrumbPage>{seg.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={seg.href}>{seg.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * @description Shell chrome around domain pages (Outlet content as children).
 * BreadcrumbProvider wraps header + children so pages can set display names.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <BreadcrumbProvider>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <AppShellBreadcrumb />
            <div className="ml-auto">
              <ModeToggle />
            </div>
          </header>
          <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 md:p-6">
            {children}
          </main>
        </BreadcrumbProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}
