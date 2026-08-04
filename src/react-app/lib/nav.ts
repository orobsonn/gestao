/** @description Pure sidebar nav builder from active empresa papel (never users.role). */

/** @description One sidebar navigation entry. */
export type NavItem = { path: string; label: string };

/**
 * @description Ordered sidebar items: Home, Experts, Meu trabalho; Admin only when activePapel is admin.
 */
export function buildSidebarNavItems(args: {
  activePapel: string | null;
}): NavItem[] {
  const items: NavItem[] = [
    { path: "/", label: "Home" },
    { path: "/experts", label: "Experts" },
    { path: "/meu-trabalho", label: "Meu trabalho" },
  ];
  if (args.activePapel === "admin") {
    items.push({ path: "/admin", label: "Admin" });
  }
  return items;
}
