/** @description Auth HTTP routes: login, logout, me — hermetic via createAuthApp(db). */

import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { verifyPassword } from '../auth/password.ts'
import {
  buildSessionCookie,
  clearSessionCookie,
  logoutSession,
  mintSession,
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

/**
 * @description Build a Hono app with POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me.
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

    // Always mint a NEW session (anti-fixation — never reuse client token).
    const rawToken = await mintSession(db, row.id)
    c.header('Set-Cookie', buildSessionCookie(rawToken))
    return c.json({ ok: true }, 200)
  })

  app.post('/api/auth/logout', async (c) => {
    const rawToken = getCookie(c, SESSION_COOKIE_NAME) ?? ''
    if (rawToken) {
      await logoutSession(db, rawToken)
    }
    c.header('Set-Cookie', clearSessionCookie())
    return c.body(null, 204)
  })

  app.get('/api/auth/me', requireSession(db), (c) => {
    const user = c.get('user')
    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    })
  })

  return app
}
