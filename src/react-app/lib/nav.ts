/** @description Pure sidebar nav builder from active empresa papel (never users.role). */

/** @description Icon key resolved by the shell (keeps this module React-free). */
export type NavIconKey = "home" | "experts" | "meu-trabalho" | "admin";

/** @description One sidebar navigation entry. */
export type NavItem = { path: string; label: string; icon: NavIconKey };

/**
 * @description Ordered sidebar items: Home, Experts, Meu trabalho; Admin only when activePapel is admin.
 */
export function buildSidebarNavItems(args: {
  activePapel: string | null;
}): NavItem[] {
  const items: NavItem[] = [
    { path: "/", label: "Home", icon: "home" },
    { path: "/experts", label: "Experts", icon: "experts" },
    { path: "/meu-trabalho", label: "Meu trabalho", icon: "meu-trabalho" },
  ];
  if (args.activePapel === "admin") {
    items.push({ path: "/admin", label: "Admin", icon: "admin" });
  }
  return items;
}
