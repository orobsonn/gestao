/** @description Auth HTTP routes: login, logout, me, active-empresa, telegram-link — hermetic via createAuthApp(db, authDeps?); /me clears stale active via clearActiveEmpresaIf. */

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
import { ensureBatchDb } from '../services/create-empresa.ts'
import type { DbLike } from '../types.ts'

const SESSION_COOKIE_NAME = 'gestao_session'
const TELEGRAM_LINK_CODE_BYTES = 32
const TELEGRAM_LINK_TTL_SQL = "datetime('now', '+15 minutes')"

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

/** @description Optional deps for createAuthApp — bot username for Telegram deep-link mint. */
export type AuthAppDeps = {
  botUsername?: string
}

/** @description Membership row returned by auth endpoints (non-deleted empresas only). */
export type MembershipRow = {
  empresa_id: string
  nome: string
  papel: string
}

/**
 * @description Convert bytes to lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @description SHA-256 hex digest of a UTF-8 string (raw link code or session token).
 */
async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
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
 * @description True when the user has a row in user_telegram_links (never returns telegram_user_id).
 */
async function isTelegramLinked(db: DbLike, userId: string): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT user_id FROM user_telegram_links WHERE user_id = ?`,
      )
      .get(userId),
  )
  return !!row && typeof row.user_id === 'string'
}

/**
 * @description Detect SQLite/D1 unique-constraint failures (concurrent mint race).
 */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

/**
 * @description Build a Hono app with POST login/logout/active-empresa/telegram-link and GET /me.
 * Closes over `db` for hermetic tests (node:sqlite) and worker mounting.
 * Optional `authDeps.botUsername` enables Telegram deep-link mint (503 when unset/blank).
 */
export function createAuthApp(
  db: DbLike,
  authDeps?: AuthAppDeps,
): Hono<{ Variables: SessionVariables }> {
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

    const linked = await isTelegramLinked(db, user.id)

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active_empresa_id: activeEmpresaId,
      memberships,
      telegram: { linked },
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

  /**
   * @description Mint a one-time Telegram deep-link code for the session user.
   * Stores SHA-256(code) only; returns deep_link + expires_at (never raw hash/token).
   */
  app.post('/api/auth/telegram-link', requireSession(db), async (c) => {
    const username = (authDeps?.botUsername ?? '').trim()
    if (!username) {
      return c.json({ error: 'Service unavailable' }, 503)
    }

    const user = c.get('user')
    const batchDb = ensureBatchDb(db)

    // Invalidate prior unused + insert; on UNIQUE (partial one-unused-per-user), retry once.
    let id = ''
    let rawCode = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      id = crypto.randomUUID()
      const codeBytes = crypto.getRandomValues(
        new Uint8Array(TELEGRAM_LINK_CODE_BYTES),
      )
      rawCode = bytesToHex(codeBytes)
      const codeHash = await sha256Hex(rawCode)

      try {
        await Promise.resolve(
          batchDb.batch([
            batchDb
              .prepare(
                `UPDATE telegram_link_codes
                 SET used_at = datetime('now')
                 WHERE user_id = ? AND used_at IS NULL`,
              )
              .bind(user.id),
            batchDb
              .prepare(
                `INSERT INTO telegram_link_codes (id, user_id, code_hash, expires_at, used_at, created_at)
                 VALUES (?, ?, ?, ${TELEGRAM_LINK_TTL_SQL}, NULL, datetime('now'))`,
              )
              .bind(id, user.id, codeHash),
          ]),
        )
        break
      } catch (err) {
        if (attempt === 0 && isUniqueConstraintError(err)) continue
        throw err
      }
    }

    const row = await Promise.resolve(
      db
        .prepare(
          `SELECT expires_at FROM telegram_link_codes WHERE id = ?`,
        )
        .get(id),
    )

    const expiresAt =
      row && typeof row.expires_at === 'string' ? row.expires_at : ''

    return c.json(
      {
        deep_link: `https://t.me/${username}?start=${rawCode}`,
        expires_at: expiresAt,
      },
      200,
    )
  })

  return app
}
