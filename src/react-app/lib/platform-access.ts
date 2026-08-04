/** @description Pure gate: whether the platform create-empresa form may render. */

/**
 * @description Returns true only when users.role is super_admin (never membership papel).
 */
export function canShowPlatformCreate(role: string): boolean {
  return role === "super_admin";
}
