/** @description Atomic create empresa + admin user + membership via a single db.batch. */

import { hashPassword } from '../auth/password.ts'

/**
 * @description Bound statement handle accepted by batch (D1 bind result or sqlite emulation).
 */
export type BatchStatement = {
  run: (...params: unknown[]) => unknown | Promise<unknown>
  sql?: string
  params?: unknown[]
}

/**
 * @description Prepared statement that can bind params for batch or run inline.
 */
export type BatchStatementFactory = {
  run(...params: unknown[]): unknown | Promise<unknown>
  // `get` is REQUIRED here even though it is optional on the raw db this wraps: both branches of
  // ensureBatchDb always define it (delegating to `stmt.get?.()`), so the wrapper's contract is
  // stronger than its input's. Marking it optional made every `prepare(...).get(...)` call site
  // read as possibly-undefined and cost 19 type errors for a case that cannot occur.
  get(
    ...params: unknown[]
  ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  bind(...params: unknown[]): BatchStatement
}

/**
 * @description DB surface required by createEmpresaAsSuperAdmin (prepare + batch).
 */
export type BatchDbLike = {
  prepare(sql: string): BatchStatementFactory
  batch(statements: BatchStatement[]): Promise<unknown[]> | unknown[]
}

/** @description Input for super-admin empresa provisioning. */
export type CreateEmpresaInput = {
  nome: string
  admin: {
    name: string
    email: string
    password: string
  }
}

/** @description Success payload (no password fields). */
export type CreateEmpresaResult = {
  empresa: { id: string; nome: string }
  admin: { id: string; email: string; name: string }
}

/**
 * @description Error thrown when admin email already exists (UNIQUE) — batch rolled back.
 */
export class DuplicateEmailError extends Error {
  /** @description Discriminator for route mapping to 409. */
  readonly code = 'duplicate_email' as const

  constructor(message = 'Email already registered') {
    super(message)
    this.name = 'DuplicateEmailError'
  }
}

/**
 * @description Detect SQLite/D1 unique-constraint failures (email or otherwise).
 */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

/**
 * @description Create empresa + admin user (role=user) + membership (papel=admin) in one batch.
 * Admin role and membership papel are hardcoded — never taken from client input.
 * @throws {DuplicateEmailError} when users.email UNIQUE fails (no orphan empresa).
 */
export async function createEmpresaAsSuperAdmin(
  db: BatchDbLike,
  input: CreateEmpresaInput,
): Promise<CreateEmpresaResult> {
  const empresaId = crypto.randomUUID()
  const adminId = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const { nome } = input
  const adminName = input.admin.name
  const adminEmail = input.admin.email
  const { hash, salt } = await hashPassword(input.admin.password)

  // Hardcoded privilege boundaries — never trust client for role/papel.
  const adminUserRole = 'user'
  const adminMembershipPapel = 'admin'

  const statements: BatchStatement[] = [
    db
      .prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`)
      .bind(empresaId, nome),
    db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, role)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(adminId, adminEmail, adminName, hash, salt, adminUserRole),
    db
      .prepare(
        `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(memberId, empresaId, adminId, adminMembershipPapel),
  ]

  try {
    await Promise.resolve(db.batch(statements))
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DuplicateEmailError()
    }
    throw err
  }

  return {
    empresa: { id: empresaId, nome },
    admin: { id: adminId, email: adminEmail, name: adminName },
  }
}

/**
 * @description Wrap a prepare-only DB with bind + batch (BEGIN IMMEDIATE transaction emulation).
 * Used by hermetic tests (node:sqlite) and any adapter lacking native batch.
 */
export function ensureBatchDb(db: {
  prepare: (sql: string) => {
    run(...params: unknown[]): unknown | Promise<unknown>
    get?(
      ...params: unknown[]
    ):
      | Record<string, unknown>
      | undefined
      | Promise<Record<string, unknown> | undefined>
    bind?(...params: unknown[]): BatchStatement
  }
  batch?: (statements: BatchStatement[]) => Promise<unknown[]> | unknown[]
}): BatchDbLike {
  if (typeof db.batch === 'function') {
    const batchFn = db.batch.bind(db)
    return {
      prepare(sql: string): BatchStatementFactory {
        const stmt = db.prepare(sql)
        return {
          run(...params: unknown[]) {
            return stmt.run(...params)
          },
          get(...params: unknown[]) {
            return stmt.get?.(...params)
          },
          bind(...params: unknown[]) {
            if (typeof stmt.bind === 'function') {
              return stmt.bind(...params)
            }
            return {
              sql,
              params,
              run: () => stmt.run(...params),
            }
          },
        }
      },
      batch(statements: BatchStatement[]) {
        return batchFn(statements)
      },
    }
  }

  return {
    prepare(sql: string): BatchStatementFactory {
      const stmt = db.prepare(sql)
      return {
        run(...params: unknown[]) {
          return stmt.run(...params)
        },
        get(...params: unknown[]) {
          return stmt.get?.(...params)
        },
        bind(...params: unknown[]) {
          return {
            sql,
            params,
            run: () => stmt.run(...params),
          }
        },
      }
    },
    async batch(statements: BatchStatement[]) {
      await Promise.resolve(db.prepare('BEGIN IMMEDIATE').run())
      try {
        const results: unknown[] = []
        for (const s of statements) {
          if (s && typeof s.run === 'function') {
            results.push(await Promise.resolve(s.run()))
          } else if (
            s &&
            typeof s === 'object' &&
            'sql' in s &&
            Array.isArray((s as { params?: unknown[] }).params)
          ) {
            const item = s as { sql: string; params: unknown[] }
            results.push(
              await Promise.resolve(db.prepare(item.sql).run(...item.params)),
            )
          } else {
            throw new Error('unsupported batch statement shape')
          }
        }
        await Promise.resolve(db.prepare('COMMIT').run())
        return results
      } catch (err) {
        try {
          await Promise.resolve(db.prepare('ROLLBACK').run())
        } catch {
          /* ignore rollback errors */
        }
        throw err
      }
    },
  }
}
