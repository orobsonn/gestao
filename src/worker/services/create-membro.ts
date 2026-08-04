/** @description Create or invite empresa member — new user batch, existing email membership-only. */

import { hashPassword } from '../auth/password.ts'
import type { MembershipPapel } from '../types.ts'
import type { BatchDbLike, BatchStatement } from './create-empresa.ts'

/** @description Input for admin-driven member create/invite. */
export type CreateMembroInput = {
  empresaId: string
  name: string
  email: string
  password: string
  papel: MembershipPapel
}

/** @description Success payload (no password fields). */
export type CreateMembroResult = {
  user: { id: string; email: string; name: string }
  papel: MembershipPapel
  /** true only when a new user row was created; false for invite/membership-only. */
  created: boolean
}

/**
 * @description Error when email is already a member of the target empresa.
 */
export class AlreadyMemberError extends Error {
  /** @description Discriminator for route mapping to 409. */
  readonly code = 'already_member' as const

  constructor(message = 'Email already member') {
    super(message)
    this.name = 'AlreadyMemberError'
  }
}

/**
 * @description Detect SQLite/D1 unique-constraint failures.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

/**
 * @description Create member as empresa admin.
 * - New email: batch INSERT user(role=user) + membership.
 * - Existing email already member of empresaId: AlreadyMemberError.
 * - Existing email not member: INSERT membership only; never touch password_hash/salt.
 * @throws {AlreadyMemberError} when email already has membership on empresaId.
 */
export async function createMembroAsAdmin(
  db: BatchDbLike,
  input: CreateMembroInput,
): Promise<CreateMembroResult> {
  const { empresaId, name, email, password, papel } = input

  if (papel !== 'admin' && papel !== 'membro') {
    throw new Error('invalid papel')
  }

  const userStmt = db.prepare(
    `SELECT id, email, name FROM users WHERE email = ?`,
  )
  if (!userStmt.get) {
    throw new Error('db statement missing get()')
  }
  const existing = await Promise.resolve(userStmt.get(email))

  if (
    existing &&
    typeof existing.id === 'string' &&
    typeof existing.email === 'string' &&
    typeof existing.name === 'string'
  ) {
    const memberStmt = db.prepare(
      `SELECT id FROM empresa_membros
       WHERE empresa_id = ? AND user_id = ?`,
    )
    if (!memberStmt.get) {
      throw new Error('db statement missing get()')
    }
    const memberRow = await Promise.resolve(
      memberStmt.get(empresaId, existing.id),
    )

    if (memberRow) {
      throw new AlreadyMemberError()
    }

    const memberId = crypto.randomUUID()
    try {
      await Promise.resolve(
        db
          .prepare(
            `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
             VALUES (?, ?, ?, ?)`,
          )
          .run(memberId, empresaId, existing.id, papel),
      )
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new AlreadyMemberError()
      }
      throw err
    }

    // Existing user: do not change password_hash/salt or name.
    return {
      user: {
        id: existing.id,
        email: existing.email,
        name: existing.name,
      },
      papel,
      created: false,
    }
  }

  // New user: batch user(role=user) + membership.
  const userId = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const { hash, salt } = await hashPassword(password)
  const userRole = 'user'

  const statements: BatchStatement[] = [
    db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, role)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, email, name, hash, salt, userRole),
    db
      .prepare(
        `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(memberId, empresaId, userId, papel),
  ]

  try {
    await Promise.resolve(db.batch(statements))
  } catch (err) {
    if (!isUniqueConstraintError(err)) {
      throw err
    }

    // Race: concurrent invite of same new email — user may exist without
    // membership on this empresa. Re-SELECT; never map UNIQUE to AlreadyMember
    // without checking membership (false 409).
    const raced = await Promise.resolve(userStmt.get(email))
    if (
      !raced ||
      typeof raced.id !== 'string' ||
      typeof raced.email !== 'string' ||
      typeof raced.name !== 'string'
    ) {
      throw err
    }

    const memberStmt = db.prepare(
      `SELECT id FROM empresa_membros
       WHERE empresa_id = ? AND user_id = ?`,
    )
    if (!memberStmt.get) {
      throw new Error('db statement missing get()')
    }
    const memberRow = await Promise.resolve(
      memberStmt.get(empresaId, raced.id),
    )
    if (memberRow) {
      throw new AlreadyMemberError()
    }

    const raceMemberId = crypto.randomUUID()
    try {
      await Promise.resolve(
        db
          .prepare(
            `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
             VALUES (?, ?, ?, ?)`,
          )
          .run(raceMemberId, empresaId, raced.id, papel),
      )
    } catch (insertErr) {
      if (isUniqueConstraintError(insertErr)) {
        throw new AlreadyMemberError()
      }
      throw insertErr
    }

    // Existing user from race: do not change password_hash/salt or name (LD-8).
    return {
      user: {
        id: raced.id,
        email: raced.email,
        name: raced.name,
      },
      papel,
      created: false,
    }
  }

  return {
    user: { id: userId, email, name },
    papel,
    created: true,
  }
}
