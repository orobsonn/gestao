/** @description Guard: only users.role === super_admin (never client role / membership papel). */

import type { MiddlewareHandler } from 'hono'
import type { SessionVariables } from './require-session.ts'

/**
 * @description Middleware after requireSession — 403 unless session user.role is super_admin.
 * Source of truth is the users row loaded by requireSession; membership papel alone never grants access.
 */
export function requireSuperAdmin(): MiddlewareHandler<{
  Variables: SessionVariables
}> {
  return async (c, next) => {
    const user = c.get('user')
    if (!user || user.role !== 'super_admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }
    await next()
  }
}
