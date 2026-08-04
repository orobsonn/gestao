/** @description Resolve active membership papel from active empresa id. */

/**
 * @description Returns the papel for the active empresa, or null when active is missing/stale.
 */
export function resolveActivePapel(args: {
  activeEmpresaId: string | null;
  memberships: Array<{ empresa_id: string; nome?: string; papel: string }>;
}): string | null {
  if (args.activeEmpresaId === null) {
    return null;
  }
  const match = args.memberships.find(
    (m) => m.empresa_id === args.activeEmpresaId,
  );
  return match ? match.papel : null;
}
