/** @description App sidebar — nav by active papel, empresa switcher, user footer, platform link. */

import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Building2,
  ChevronsUpDown,
  Home,
  LogOut,
  Settings2,
  Shield,
  UserRound,
  Users,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { resolveActivePapel } from "@/lib/active-papel";
import {
  buildSidebarNavItems,
  type NavIconKey,
} from "@/lib/nav";
import { PLATFORM_PATH } from "@/lib/shell-routes";
import { useAuth } from "@/providers/auth-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
  home: Home,
  experts: Users,
  "meu-trabalho": Briefcase,
  admin: Settings2,
};

/**
 * @description Initials from display name for avatar fallback.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * @description Sidebar with domain nav, empresa selector, user identity, optional platform link.
 */
export function AppSidebar() {
  const { me, setActiveEmpresa, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  if (!me) {
    return null;
  }

  const activePapel = resolveActivePapel({
    activeEmpresaId: me.active_empresa_id,
    memberships: me.memberships,
  });
  const navItems = buildSidebarNavItems({ activePapel });

  const activeEmpresa =
    me.memberships.find((m) => m.empresa_id === me.active_empresa_id) ?? null;

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {me.memberships.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    tooltip={activeEmpresa?.nome ?? "Selecionar empresa"}
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                      <Building2 className="size-4" />
                    </div>
                    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">
                        {activeEmpresa?.nome ?? "Selecionar empresa"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {activePapel ?? "sem papel"}
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 rounded-lg"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                >
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Empresas
                  </DropdownMenuLabel>
                  {me.memberships.map((m) => (
                    <DropdownMenuItem
                      key={m.empresa_id}
                      onClick={() => void setActiveEmpresa(m.empresa_id)}
                    >
                      <Building2 className="mr-2 size-4" />
                      <span className="truncate">{m.nome}</span>
                      {m.empresa_id === me.active_empresa_id ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          ativa
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SidebarMenuButton
                size="lg"
                tooltip="Gestão"
                className="pointer-events-none"
              >
                <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Building2 className="size-4" />
                </div>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Gestão</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Sem empresa
                  </span>
                </div>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navegação</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const Icon = NAV_ICONS[item.icon];
                const isActive =
                  item.path === "/"
                    ? pathname === "/"
                    : pathname === item.path ||
                      pathname.startsWith(`${item.path}/`);
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                    >
                      <Link to={item.path}>
                        <Icon className="size-4 shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {me.role === "super_admin" ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Plataforma">
                <Link to={PLATFORM_PATH}>
                  <Shield className="size-4 shrink-0" />
                  <span>Plataforma</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={me.name}
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarFallback className="text-xs">
                      {initials(me.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{me.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {me.email}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 rounded-lg"
                align="end"
                side="top"
                sideOffset={4}
              >
                <DropdownMenuLabel className="p-0 font-normal">
                  <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                    <Avatar className="h-8 w-8 shrink-0">
                      <AvatarFallback className="text-xs">
                        {initials(me.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{me.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {me.email}
                      </span>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => navigate("/minha-conta")}
                >
                  <UserRound className="mr-2 size-4" />
                  Minha conta
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleLogout()}>
                  <LogOut className="mr-2 size-4" />
                  Sair
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
