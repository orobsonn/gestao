/** @description Auth HTTP routes: login, logout, me, active-empresa — hermetic via createAuthApp(db); /me clears stale active via clearActiveEmpresaIf. */

import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { verifyPassword } from '../auth/password.ts'
import {
  buildSessionCookie,
  clearActiveEmpresaIf,
  clearSessionCookie,
  getSessionContext,
  logoutSession,
  mintSession,
  setActiveEmpresa,
} from '../auth/session.ts'
import {
  requireSession,
  type SessionVariables,
} from '../middleware/require-session.ts'
import type { DbLike } from '../types.ts'

const SESSION_COOKIE_NAME = 'gestao_session'

/** @description Generic login failure body — same for wrong password and unknown email. */
const LOGIN_FAILURE_BODY = { error: 'Invalid credentials' } as const

/**
 * @description Dummy hex salt/hash so unknown-email path still runs PBKDF2 (timing parity).
 * Not a real credential; verifyPassword always returns false against these zeros.
 */
const DUMMY_HASH = '00'.repeat(32)
const DUMMY_SALT = '00'.repeat(16)

const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(1024),
})

const activeEmpresaBodySchema = z.object({
  empresa_id: z.string().min(1),
})

/** @description Membership row returned by auth endpoints (non-deleted empresas only). */
export type MembershipRow = {
  empresa_id: string
  nome: string
  papel: string
}

/**
 * @description List non-deleted empresa memberships for a user.
 * Joins empresa_membros + empresas; excludes soft-deleted empresas (deleted_at IS NOT NULL).
 */
async function listMemberships(
  db: DbLike,
  userId: string,
): Promise<MembershipRow[]> {
  const stmt = db.prepare(
    `SELECT em.empresa_id AS empresa_id, e.nome AS nome, em.papel AS papel
     FROM empresa_membros em
     INNER JOIN empresas e ON e.id = em.empresa_id
     WHERE em.user_id = ? AND e.deleted_at IS NULL`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(userId))

  const result: MembershipRow[] = []
  for (const row of rows) {
    if (
      typeof row.empresa_id === 'string' &&
      typeof row.nome === 'string' &&
      typeof row.papel === 'string'
    ) {
      result.push({
        empresa_id: row.empresa_id,
        nome: row.nome,
        papel: row.papel,
      })
    }
  }
  return result
}

/**
 * @description True when user has a non-deleted membership on the given empresa.
 */
async function hasActiveMembership(
  db: DbLike,
  userId: string,
  empresaId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT em.empresa_id AS empresa_id
         FROM empresa_membros em
         INNER JOIN empresas e ON e.id = em.empresa_id
         WHERE em.user_id = ? AND em.empresa_id = ? AND e.deleted_at IS NULL`,
      )
      .get(userId, empresaId),
  )
  return !!row && typeof row.empresa_id === 'string'
}

/**
 * @description Build a Hono app with POST login/logout/active-empresa and GET /me.
 * Closes over `db` for hermetic tests (node:sqlite) and worker mounting.
 */
export function createAuthApp(db: DbLike): Hono<{ Variables: SessionVariables }> {
  const app = new Hono<{ Variables: SessionVariables }>()

  app.post('/api/auth/login', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const parsed = loginBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const { email, password } = parsed.data

    const row = await Promise.resolve(
      db
        .prepare(
          `SELECT id, password_hash, password_salt FROM users WHERE email = ?`,
        )
        .get(email),
    )

    const hash =
      row && typeof row.password_hash === 'string'
        ? row.password_hash
        : DUMMY_HASH
    const salt =
      row && typeof row.password_salt === 'string'
        ? row.password_salt
        : DUMMY_SALT

    const passwordOk = await verifyPassword(password, hash, salt)

    if (!row || typeof row.id !== 'string' || !passwordOk) {
      return c.json(LOGIN_FAILURE_BODY, 401)
    }

    const memberships = await listMemberships(db, row.id)
    const activeEmpresaId =
      memberships.length === 1 ? memberships[0].empresa_id : null

    // Always mint a NEW session (anti-fixation — never reuse client token).
    const rawToken = await mintSession(db, row.id, activeEmpresaId)
    c.header('Set-Cookie', buildSessionCookie(rawToken))
    return c.json(
      {
        ok: true,
        active_empresa_id: activeEmpresaId,
        memberships,
      },
      200,
    )
  })

  app.post('/api/auth/logout', async (c) => {
    const rawToken = getCookie(c, SESSION_COOKIE_NAME) ?? ''
    if (rawToken) {
      await logoutSession(db, rawToken)
    }
    c.header('Set-Cookie', clearSessionCookie())
    return c.body(null, 204)
  })

  app.get('/api/auth/me', requireSession(db), async (c) => {
    const user = c.get('user')
    const sessionToken = c.get('sessionToken')
    const ctx = await getSessionContext(db, sessionToken)
    const memberships = await listMemberships(db, user.id)

    let activeEmpresaId = ctx?.activeEmpresaId ?? null
    if (
      activeEmpresaId !== null &&
      !memberships.some((m) => m.empresa_id === activeEmpresaId)
    ) {
      const staleId = activeEmpresaId
      await clearActiveEmpresaIf(db, sessionToken, staleId)
      activeEmpresaId = null
    }

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active_empresa_id: activeEmpresaId,
      memberships,
    })
  })

  app.post('/api/auth/active-empresa', requireSession(db), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const parsed = activeEmpresaBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const { empresa_id } = parsed.data
    const user = c.get('user')
    const sessionToken = c.get('sessionToken')

    const allowed = await hasActiveMembership(db, user.id, empresa_id)
    if (!allowed) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    await setActiveEmpresa(db, sessionToken, empresa_id)
    const memberships = await listMemberships(db, user.id)

    return c.json(
      {
        active_empresa_id: empresa_id,
        memberships,
      },
      200,
    )
  })

  return app
}
