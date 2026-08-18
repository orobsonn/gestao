/** @description Atomic claim + map for /vincular_empresa (kind=empresa) in group/supergroup. Single-txn, reject-without-claim on map conflicts, same-chat-only updates. */

import { ensureBatchDb } from './create-empresa.ts'
import type { DbLike } from '../types.ts'

const CLAIM_EMPRESA_SQL = `UPDATE telegram_bind_codes
   SET used_at = datetime('now')
   WHERE code_hash = ?
     AND kind = 'empresa'
     AND used_at IS NULL
     AND expires_at > datetime('now')`

const EXPIRED_EMPRESA_SQL = `SELECT 1 AS ok FROM telegram_bind_codes
   WHERE code_hash = ?
     AND kind = 'empresa'
     AND used_at IS NULL
     AND expires_at <= datetime('now')`

const CODE_EMPRESA_SQL = `SELECT empresa_id, used_at, expires_at FROM telegram_bind_codes WHERE code_hash = ? AND kind = 'empresa'`

const CHAT_OWNER_SQL = `SELECT empresa_id FROM empresa_telegram_chats WHERE chat_id = ?`

const EMPRESA_CHAT_SQL = `SELECT chat_id FROM empresa_telegram_chats WHERE empresa_id = ?`

const INSERT_MAP_SQL = `INSERT INTO empresa_telegram_chats (empresa_id, chat_id, linked_at)
   VALUES (?, ?, datetime('now'))`

/** @description Rows affected by stmt.run() — node:sqlite `{changes}` or D1 `{meta.changes}`. */
function runChanges(result: unknown): number | null {
  if (result == null || typeof result !== 'object') {
    return null
  }
  if (
    'changes' in result &&
    typeof (result as { changes: unknown }).changes === 'number'
  ) {
    return (result as { changes: number }).changes
  }
  if ('meta' in result) {
    const meta = (result as { meta: unknown }).meta
    if (
      meta != null &&
      typeof meta === 'object' &&
      'changes' in meta &&
      typeof (meta as { changes: unknown }).changes === 'number'
    ) {
      return (meta as { changes: number }).changes
    }
  }
  return null
}

/** @description Detect SQLite/D1 unique-constraint failures. */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

export type EmpresaBindOutcome = 'success' | 'invalid' | 'expired' | 'chat_taken' | 'already_linked'

/**
 * @description Single-txn claim+map for empresa. Rejects without consuming code on map conflicts.
 * Hermetic node:sqlite → BEGIN IMMEDIATE; D1 → batch.
 */
export async function claimCodeAndBindEmpresa(
  db: DbLike,
  codeHash: string,
  chatId: string | number,
): Promise<EmpresaBindOutcome> {
  const chatStr = String(chatId)
  const batchDb = ensureBatchDb(
    db as Parameters<typeof ensureBatchDb>[0],
  )

  if (typeof (db as { batch?: unknown }).batch === 'function') {
    return claimViaBatch(batchDb, codeHash, chatStr)
  }
  return claimViaImmediateTxn(batchDb, codeHash, chatStr)
}

async function claimViaBatch(
  batchDb: ReturnType<typeof ensureBatchDb>,
  codeHash: string,
  chatStr: string,
): Promise<EmpresaBindOutcome> {
  const codeRow = await Promise.resolve(
    batchDb.prepare(CODE_EMPRESA_SQL).get(codeHash),
  )
  const empresaId =
    codeRow && typeof codeRow.empresa_id === 'string' ? codeRow.empresa_id : null
  if (!codeRow || !empresaId) return 'invalid'
  if (codeRow.used_at) {
    const existing = await Promise.resolve(
      batchDb.prepare(EMPRESA_CHAT_SQL).get(empresaId),
    )
    if (existing && typeof existing.chat_id === 'string' && existing.chat_id === chatStr) {
      return 'success' // redelivery
    }
    return 'invalid'
  }
  const expiredRow = await Promise.resolve(
    batchDb.prepare(EXPIRED_EMPRESA_SQL).get(codeHash),
  )
  if (expiredRow) return 'expired'

  const existingChat = await Promise.resolve(
    batchDb.prepare(CHAT_OWNER_SQL).get(chatStr),
  )
  if (existingChat && typeof existingChat.empresa_id === 'string' && existingChat.empresa_id !== empresaId) {
    return 'chat_taken'
  }

  const existingEmpresaChat = await Promise.resolve(
    batchDb.prepare(EMPRESA_CHAT_SQL).get(empresaId),
  )
  if (existingEmpresaChat && typeof existingEmpresaChat.chat_id === 'string' && existingEmpresaChat.chat_id !== chatStr) {
    return 'already_linked'
  }

  let results: unknown[]
  try {
    results = (await Promise.resolve(
      batchDb.batch([
        batchDb.prepare(CLAIM_EMPRESA_SQL).bind(codeHash),
      ]),
    )) as unknown[]
  } catch (err) {
    if (isUniqueConstraintError(err)) return 'invalid'
    throw err
  }
  if (runChanges(results[0]) !== 1) {
    const existing = await Promise.resolve(
      batchDb.prepare(EMPRESA_CHAT_SQL).get(empresaId),
    )
    if (existing && typeof existing.chat_id === 'string' && existing.chat_id === chatStr) {
      return 'success'
    }
    return 'invalid'
  }

  try {
    await Promise.resolve(
      batchDb.prepare(INSERT_MAP_SQL).run(empresaId, chatStr),
    )
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // unclaim
      await Promise.resolve(batchDb.prepare(`UPDATE telegram_bind_codes SET used_at = NULL WHERE code_hash = ?`).run(codeHash))
      return 'chat_taken'
    }
    throw err
  }
  return 'success'
}

async function claimViaImmediateTxn(
  batchDb: ReturnType<typeof ensureBatchDb>,
  codeHash: string,
  chatStr: string,
): Promise<EmpresaBindOutcome> {
  await Promise.resolve(batchDb.prepare('BEGIN IMMEDIATE').run())
  try {
    const claimResult = await Promise.resolve(
      batchDb.prepare(CLAIM_EMPRESA_SQL).run(codeHash),
    )

    if (runChanges(claimResult) !== 1) {
      const expiredRow = await Promise.resolve(
        batchDb.prepare(EXPIRED_EMPRESA_SQL).get?.(codeHash),
      )
      if (!expiredRow) {
        const codeRow = await Promise.resolve(
          batchDb.prepare(CODE_EMPRESA_SQL).get?.(codeHash),
        )
        const empresaId =
          codeRow && typeof codeRow.empresa_id === 'string' ? codeRow.empresa_id : null
        if (empresaId) {
          const existing = await Promise.resolve(
            batchDb.prepare(EMPRESA_CHAT_SQL).get?.(empresaId),
          )
          if (existing && typeof existing.chat_id === 'string' && existing.chat_id === chatStr) {
            await Promise.resolve(batchDb.prepare('ROLLBACK').run())
            return 'success'
          }
        }
      }
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return expiredRow ? 'expired' : 'invalid'
    }

    const codeRow = await Promise.resolve(
      batchDb.prepare(CODE_EMPRESA_SQL).get?.(codeHash),
    )
    const empresaId =
      codeRow && typeof codeRow.empresa_id === 'string' ? codeRow.empresa_id : null
    if (!empresaId) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'invalid'
    }

    const existingChat = await Promise.resolve(
      batchDb.prepare(CHAT_OWNER_SQL).get?.(chatStr),
    )
    if (existingChat && typeof existingChat.empresa_id === 'string' && existingChat.empresa_id !== empresaId) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'chat_taken'
    }

    const existingEmpresaChat = await Promise.resolve(
      batchDb.prepare(EMPRESA_CHAT_SQL).get?.(empresaId),
    )
    if (existingEmpresaChat && typeof existingEmpresaChat.chat_id === 'string') {
      if (existingEmpresaChat.chat_id !== chatStr) {
        await Promise.resolve(batchDb.prepare('ROLLBACK').run())
        return 'already_linked'
      }
      // same chat redelivery — success, keep used_at
      await Promise.resolve(batchDb.prepare('COMMIT').run())
      return 'success'
    }

    try {
      await Promise.resolve(
        batchDb.prepare(INSERT_MAP_SQL).run(empresaId, chatStr),
      )
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        await Promise.resolve(batchDb.prepare('ROLLBACK').run())
        return 'chat_taken'
      }
      throw err
    }

    await Promise.resolve(batchDb.prepare('COMMIT').run())
    return 'success'
  } catch (err) {
    try {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
    } catch {
      /* ignore */
    }
    throw err
  }
}
