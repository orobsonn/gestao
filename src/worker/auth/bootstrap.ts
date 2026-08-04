/** @description Idempotent platform super-admin bootstrap from SUPER_ADMIN_* secrets. */

import { hashPassword } from './password.ts'
import type { DbLike } from '../types.ts'

const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 1024
const SUPER_ADMIN_NAME = 'Super Admin'

/** @description Result of ensureBootstrapSuperAdmin — never throws on collision. */
export interface BootstrapResult {
  ok: boolean
}

/**
 * @description Ensure a single super_admin exists from email/password secrets.
 * Skips (ok:true) when secrets are missing/empty, password length < 8 or > 1024,
 * or a super_admin already exists (never overwrites password). On email collision
 * with role=user: fail-closed { ok: false } without promote/hash. SA-vs-SA: { ok: true }.
 */
export async function ensureBootstrapSuperAdmin(
  db: DbLike,
  secrets: { email?: string; password?: string },
): Promise<BootstrapResult> {
  const email = typeof secrets.email === 'string' ? secrets.email.trim() : ''
  const password = typeof secrets.password === 'string' ? secrets.password : ''

  if (
    !email ||
    !password ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return { ok: true }
  }

  const existingSa = await Promise.resolve(
    db.prepare(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`).get(),
  )
  if (existingSa) {
    return { ok: true }
  }

  // Pre-insert email collision check — fail closed before expensive hash.
  const existingByEmail = await Promise.resolve(
    db.prepare(`SELECT role FROM users WHERE email = ?`).get(email),
  )
  if (existingByEmail) {
    if (existingByEmail.role === 'super_admin') {
      return { ok: true }
    }
    // role=user (or unknown): fail closed, do not promote or hash.
    return { ok: false }
  }

  const { hash, salt } = await hashPassword(password)
  const id = crypto.randomUUID()

  try {
    await Promise.resolve(
      db
        .prepare(
          `INSERT INTO users (id, email, name, password_hash, password_salt, role)
           VALUES (?, ?, ?, ?, ?, 'super_admin')`,
        )
        .run(id, email, SUPER_ADMIN_NAME, hash, salt),
    )
    return { ok: true }
  } catch {
    // Collision or concurrent insert — never throw; inspect existing row.
    const row = await Promise.resolve(
      db.prepare(`SELECT role FROM users WHERE email = ?`).get(email),
    )
    if (row && row.role === 'super_admin') {
      return { ok: true }
    }
    // role=user (or unknown): fail closed, do not promote or overwrite.
    return { ok: false }
  }
}
