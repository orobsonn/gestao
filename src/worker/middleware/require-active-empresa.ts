/** @description Guard: session must have active_empresa_id with non-deleted membership. */

import type { MiddlewareHandler } from 'hono'
import { clearActiveEmpresaIf, getSessionContext } from '../auth/session.ts'
import type { MembershipPapel } from '../types.ts'
import type { DbLike } from '../types.ts'
import type { SessionVariables } from './require-session.ts'

/** @description Hono variables after requireSession + requireActiveEmpresa. */
export type ActiveEmpresaVariables = SessionVariables & {
  activeEmpresaId: string
  membershipPapel: MembershipPapel
}

/**
 * @description Factory: after requireSession — 403 unless session active_empresa_id
 * has a non-deleted membership for the session user. Sets activeEmpresaId + membershipPapel.
 */
export function requireActiveEmpresa(
  db: DbLike,
): MiddlewareHandler<{ Variables: ActiveEmpresaVariables }> {
  return async (c, next) => {
    const sessionToken = c.get('sessionToken')
    const user = c.get('user')

    const ctx = await getSessionContext(db, sessionToken)
    const activeEmpresaId = ctx?.activeEmpresaId ?? null

    if (!activeEmpresaId) {
      return c.json({ error: 'Empresa ativa required' }, 403)
    }

    const row = await Promise.resolve(
      db
        .prepare(
          `SELECT em.papel AS papel
           FROM empresa_membros em
           INNER JOIN empresas e ON e.id = em.empresa_id
           WHERE em.user_id = ? AND em.empresa_id = ? AND e.deleted_at IS NULL`,
        )
        .get(user.id, activeEmpresaId),
    )

    if (!row || typeof row.papel !== 'string') {
      await clearActiveEmpresaIf(db, sessionToken, activeEmpresaId)
      return c.json({ error: 'Empresa ativa required' }, 403)
    }

    if (row.papel !== 'admin' && row.papel !== 'membro') {
      await clearActiveEmpresaIf(db, sessionToken, activeEmpresaId)
      return c.json({ error: 'Empresa ativa required' }, 403)
    }

    c.set('activeEmpresaId', activeEmpresaId)
    c.set('membershipPapel', row.papel as MembershipPapel)
    await next()
  }
}
