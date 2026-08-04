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
 * @returns Raw token string (caller sets cookie; never store raw in DB).
 */
export async function mintSession(db: DbLike, userId: string): Promise<string> {
  const id = crypto.randomUUID()
  const tokenBytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES))
  const rawToken = bytesToHex(tokenBytes)
  const tokenHash = await sha256Hex(rawToken)

  await Promise.resolve(
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, ${SESSION_TTL_SQL})`,
      )
      .run(id, userId, tokenHash),
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
