/** @description DM active empresa pin store (telegram_dm_active_empresa) with pending_boundary flag. */

import type { DbLike } from '../types.ts'

const GET_ACTIVE_SQL = `SELECT empresa_id, pending_boundary FROM telegram_dm_active_empresa WHERE user_id = ?`
const UPSERT_ACTIVE_SQL = `INSERT INTO telegram_dm_active_empresa (user_id, empresa_id, pending_boundary) VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET empresa_id = excluded.empresa_id, pending_boundary = 0`
const CLEAR_ACTIVE_SQL = `DELETE FROM telegram_dm_active_empresa WHERE user_id = ?`
const SET_BOUNDARY_SQL = `UPDATE telegram_dm_active_empresa SET pending_boundary = ? WHERE user_id = ?`

export interface DmActiveEmpresa {
  empresa_id: string
  pending_boundary: number
}

/** @description Get current DM active empresa pin for user (or null if none). */
export async function getDmActiveEmpresa(
  db: DbLike,
  userId: string,
): Promise<DmActiveEmpresa | null> {
  const row = await Promise.resolve(db.prepare(GET_ACTIVE_SQL).get(userId))
  if (
    row &&
    typeof row.empresa_id === 'string' &&
    typeof row.pending_boundary === 'number'
  ) {
    return {
      empresa_id: row.empresa_id,
      pending_boundary: row.pending_boundary,
    }
  }
  return null
}

/** @description Upsert/overwrite the DM active empresa pin (resets pending_boundary to 0). */
export async function upsertDmActiveEmpresa(
  db: DbLike,
  userId: string,
  empresaId: string,
): Promise<void> {
  await Promise.resolve(
    db.prepare(UPSERT_ACTIVE_SQL).run(userId, empresaId),
  )
}

/** @description Clear the DM active empresa pin for user. */
export async function clearDmActiveEmpresa(
  db: DbLike,
  userId: string,
): Promise<void> {
  await Promise.resolve(db.prepare(CLEAR_ACTIVE_SQL).run(userId))
}

/** @description Set pending_boundary flag (0 or 1) on existing pin row. */
export async function setDmPendingBoundary(
  db: DbLike,
  userId: string,
  value: 0 | 1,
): Promise<void> {
  await Promise.resolve(
    db.prepare(SET_BOUNDARY_SQL).run(value, userId),
  )
}
