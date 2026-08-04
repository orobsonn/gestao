/** @description Shared Worker DB and domain types for auth and data access. */

import type { MembershipPapel, UserRole } from '../shared/domain/enums.ts'

/** @description Minimal prepared-statement surface shared by node:sqlite and D1 adapters. */
export interface StatementLike {
  run(...params: unknown[]): unknown | Promise<unknown>
  get(
    ...params: unknown[]
  ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  all?(
    ...params: unknown[]
  ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>
}

/** @description Minimal DB surface: prepare SQL, bind via statement args (node:sqlite-compatible). */
export interface DbLike {
  prepare(sql: string): StatementLike
}

/** @description User row shape used by auth (no password fields in API responses). */
export interface AuthUser {
  id: string
  email: string
  name: string
  role: UserRole
}

/** @description Password hash result: PBKDF2-SHA-256 hex digest + hex salt. */
export interface PasswordHashResult {
  hash: string
  salt: string
}

export type { MembershipPapel, UserRole }
