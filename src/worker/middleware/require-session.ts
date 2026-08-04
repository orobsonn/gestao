/** @description Require authenticated session from gestao_session cookie; clear cookie when expired. */

import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { clearSessionCookie, resolveSession } from '../auth/session.ts'
import type { AuthUser, DbLike } from '../types.ts'
import type { UserRole } from '../../shared/domain/enums.ts'

const SESSION_COOKIE_NAME = 'gestao_session'

/** @description Hono variables set after a valid session is resolved. */
export type SessionVariables = {
  user: AuthUser
  sessionToken: string
}

/**
 * @description Factory: middleware that resolves gestao_session, loads user, or 401 + clear cookie.
 */
export function requireSession(
  db: DbLike,
): MiddlewareHandler<{ Variables: SessionVariables }> {
  return async (c, next) => {
    const rawToken = getCookie(c, SESSION_COOKIE_NAME) ?? ''
    if (!rawToken) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const userId = await resolveSession(db, rawToken)
    if (!userId) {
      c.header('Set-Cookie', clearSessionCookie())
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const row = await Promise.resolve(
      db
        .prepare(`SELECT id, email, name, role FROM users WHERE id = ?`)
        .get(userId),
    )

    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.email !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.role !== 'string'
    ) {
      c.header('Set-Cookie', clearSessionCookie())
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const user: AuthUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as UserRole,
    }

    c.set('user', user)
    c.set('sessionToken', rawToken)
    await next()
  }
}
