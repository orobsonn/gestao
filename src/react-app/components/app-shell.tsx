/** @description App shell layout — SidebarProvider, AppSidebar, header breadcrumb + ModeToggle, main. */

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const PATH_TITLES: Record<string, string> = {
  "/": "Home",
  "/experts": "Experts",
  "/meu-trabalho": "Meu trabalho",
  "/admin": "Admin",
};

/**
 * @description Shell chrome around domain pages (Outlet content as children).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const title = PATH_TITLES[pathname] ?? "Gestão";

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto">
            <ModeToggle />
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
