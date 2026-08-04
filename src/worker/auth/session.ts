/** @description Opaque session mint/resolve/logout and Set-Cookie builders. */

import type { DbLike } from '../types.ts'

const SESSION_COOKIE_NAME = 'gestao_session'
const SESSION_TOKEN_BYTES = 32
const SESSION_TTL_SQL = "datetime('now', '+14 days')"
const SESSION_VALID_SQL = "expires_at > datetime('now')"

/**
 * @description Convert bytes to lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @description SHA-256 hex digest of a UTF-8 string (raw session token).
 */
async function sha256Hex(rawToken: string): Promise<string> {
  const data = new TextEncoder().encode(rawToken)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
}

/**
 * @description Mint a new session: store SHA-256(token) only; expires via SQLite datetime +14 days.
 * Optional activeEmpresaId is persisted on the row (default null).
 * @returns Raw token string (caller sets cookie; never store raw in DB).
 */
export async function mintSession(
  db: DbLike,
  userId: string,
  activeEmpresaId: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID()
  const tokenBytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES))
  const rawToken = bytesToHex(tokenBytes)
  const tokenHash = await sha256Hex(rawToken)

  await Promise.resolve(
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, active_empresa_id)
         VALUES (?, ?, ?, ${SESSION_TTL_SQL}, ?)`,
      )
      .run(id, userId, tokenHash, activeEmpresaId),
  )

  return rawToken
}

/**
 * @description Resolve raw token to user id if token_hash matches and session is unexpired.
 */
export async function resolveSession(
  db: DbLike,
  rawToken: string,
): Promise<string | null> {
  if (!rawToken) return null

  const tokenHash = await sha256Hex(rawToken)
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT user_id FROM sessions
         WHERE token_hash = ? AND ${SESSION_VALID_SQL}`,
      )
      .get(tokenHash),
  )

  if (!row || typeof row.user_id !== 'string') return null
  return row.user_id
}

/**
 * @description Resolve raw token to session context (userId + activeEmpresaId) if unexpired.
 */
export async function getSessionContext(
  db: DbLike,
  rawToken: string,
): Promise<{ userId: string; activeEmpresaId: string | null } | null> {
  if (!rawToken) return null

  const tokenHash = await sha256Hex(rawToken)
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT user_id, active_empresa_id FROM sessions
         WHERE token_hash = ? AND ${SESSION_VALID_SQL}`,
      )
      .get(tokenHash),
  )

  if (!row || typeof row.user_id !== 'string') return null

  const activeEmpresaId =
    typeof row.active_empresa_id === 'string' ? row.active_empresa_id : null

  return { userId: row.user_id, activeEmpresaId }
}

/**
 * @description Set active_empresa_id on the session identified by raw token (hash only).
 * No-op when session is missing or expired.
 */
export async function setActiveEmpresa(
  db: DbLike,
  rawToken: string,
  empresaId: string | null,
): Promise<void> {
  if (!rawToken) return

  const tokenHash = await sha256Hex(rawToken)
  await Promise.resolve(
    db
      .prepare(
        `UPDATE sessions SET active_empresa_id = ?
         WHERE token_hash = ? AND ${SESSION_VALID_SQL}`,
      )
      .run(empresaId, tokenHash),
  )
}

/** @description Clear active_empresa_id only if it still equals expectedEmpresaId (TOCTOU-safe). */
export async function clearActiveEmpresaIf(
  db: DbLike,
  rawToken: string,
  expectedEmpresaId: string,
): Promise<void> {
  if (!rawToken || !expectedEmpresaId) return
  const tokenHash = await sha256Hex(rawToken)
  await Promise.resolve(
    db.prepare(
      `UPDATE sessions SET active_empresa_id = NULL
       WHERE token_hash = ? AND active_empresa_id = ? AND ${SESSION_VALID_SQL}`,
    ).run(tokenHash, expectedEmpresaId),
  )
}

/**
 * @description Delete the session row for the given raw token (logout).
 */
export async function logoutSession(db: DbLike, rawToken: string): Promise<void> {
  if (!rawToken) return

  const tokenHash = await sha256Hex(rawToken)
  await Promise.resolve(
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash),
  )
}

/**
 * @description Build Set-Cookie for gestao_session: HttpOnly; Secure; SameSite=Lax; Path=/.
 */
export function buildSessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
}

/**
 * @description Build Set-Cookie that clears gestao_session (Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax).
 */
export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ')
}
