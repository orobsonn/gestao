/** @description Guard: membership papel must be admin on the active empresa. */

import type { MiddlewareHandler } from 'hono'
import type { ActiveEmpresaVariables } from './require-active-empresa.ts'

/**
 * @description Middleware after requireActiveEmpresa — 403 unless membershipPapel === 'admin'.
 * Membership papel never elevates platform role.
 */
export function requireEmpresaAdmin(): MiddlewareHandler<{
  Variables: ActiveEmpresaVariables
}> {
  return async (c, next) => {
    const papel = c.get('membershipPapel')
    if (papel !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }
    await next()
  }
}
