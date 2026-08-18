/** @description Shared Worker DB and domain types for auth and data access. */

import type { MembershipPapel, UserRole } from '../shared/domain/enums.ts'

/** @description Minimal prepared-statement surface shared by node:sqlite and D1 adapters. */
export interface StatementLike {
  run(...params: unknown[]): unknown | Promise<unknown>
  get(
    ...params: unknown[]
  ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  // Required, not optional: the folder law already states the D1 adapter MUST implement `all()`
  // for multi-row reads. Modelling it as optional forced every multi-row call site to either
  // read as possibly-undefined or use `?.`, and `?.` would turn "adapter lacks all()" into a
  // silent empty result — indistinguishable from "no rows".
  all(
    ...params: unknown[]
  ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>
}

/**
 * @description Narrowest read surface: prepare + single-row get. Deliberately smaller than
 * `DbLike` so helpers that only read one row accept BOTH the plain db and the batch wrapper —
 * demanding the full `DbLike` for a single `.get()` is what made `BatchDbLike` stop fitting.
 */
export interface RowReaderDb {
  prepare(sql: string): {
    get(
      ...params: unknown[]
    ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  }
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
