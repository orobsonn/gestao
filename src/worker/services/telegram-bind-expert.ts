/** @description Atomic claim + map for /vincular_expert (kind=expert) in group/supergroup topic. Single-txn, require message_thread_id + matching empresa_telegram_chats, live expert, thread collision reject, same-expert new-thread update, redelivery success. */

import { ensureBatchDb } from './create-empresa.ts'
import type { DbLike } from '../types.ts'

const CLAIM_EXPERT_SQL = `UPDATE telegram_bind_codes
   SET used_at = datetime('now')
   WHERE code_hash = ?
     AND kind = 'expert'
     AND used_at IS NULL
     AND expires_at > datetime('now')`

const EXPIRED_EXPERT_SQL = `SELECT 1 AS ok FROM telegram_bind_codes
   WHERE code_hash = ?
     AND kind = 'expert'
     AND used_at IS NULL
     AND expires_at <= datetime('now')`

const CODE_EXPERT_SQL = `SELECT empresa_id, expert_id FROM telegram_bind_codes WHERE code_hash = ? AND kind = 'expert'`

const EXPERT_LIVE_SQL = `SELECT 1 FROM experts WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`

const EMPRESA_CHAT_SQL = `SELECT 1 FROM empresa_telegram_chats WHERE empresa_id = ? AND chat_id = ?`

const THREAD_OWNER_SQL = `SELECT expert_id FROM expert_telegram_topics WHERE chat_id = ? AND message_thread_id = ?`

const EXPERT_TOPIC_SQL = `SELECT chat_id, message_thread_id FROM expert_telegram_topics WHERE expert_id = ?`

const INSERT_TOPIC_SQL = `INSERT INTO expert_telegram_topics (expert_id, empresa_id, chat_id, message_thread_id, linked_at)
   VALUES (?, ?, ?, ?, datetime('now'))`

const UPDATE_TOPIC_SQL = `UPDATE expert_telegram_topics
   SET empresa_id = ?, chat_id = ?, message_thread_id = ?, linked_at = datetime('now')
   WHERE expert_id = ?`

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

export type ExpertBindOutcome =
  | 'success'
  | 'invalid'
  | 'expired'
  | 'thread_taken'
  | 'wrong_chat'
  | 'deleted'

/**
 * @description Single-txn claim+map for expert topic. Rejects without consuming code on map conflicts.
 * Hermetic node:sqlite → BEGIN IMMEDIATE; D1 → batch (simplified post-claim checks).
 */
export async function claimCodeAndBindExpert(
  db: DbLike,
  codeHash: string,
  chatId: string | number,
  threadId: string | number,
): Promise<ExpertBindOutcome> {
  const chatStr = String(chatId)
  const threadStr = String(threadId)
  const batchDb = ensureBatchDb(
    db as Parameters<typeof ensureBatchDb>[0],
  )

  if (typeof (db as { batch?: unknown }).batch === 'function') {
    return claimViaBatch(batchDb, codeHash, chatStr, threadStr)
  }
  return claimViaImmediateTxn(batchDb, codeHash, chatStr, threadStr)
}

async function claimViaBatch(
  batchDb: ReturnType<typeof ensureBatchDb>,
  codeHash: string,
  chatStr: string,
  threadStr: string,
): Promise<ExpertBindOutcome> {
  const codeRow = await Promise.resolve(
    batchDb.prepare(CODE_EXPERT_SQL).get(codeHash),
  )
  const empresaId =
    codeRow && typeof codeRow.empresa_id === 'string' ? codeRow.empresa_id : null
  const expertId =
    codeRow && typeof codeRow.expert_id === 'string' ? codeRow.expert_id : null
  if (!codeRow || !empresaId || !expertId) return 'invalid'
  if (codeRow.used_at) {
    const existingTopic = await Promise.resolve(
      batchDb.prepare(EXPERT_TOPIC_SQL).get(expertId),
    )
    if (existingTopic && typeof existingTopic.chat_id === 'string' && typeof existingTopic.message_thread_id === 'string' && existingTopic.chat_id === chatStr && existingTopic.message_thread_id === threadStr) {
      return 'success' // redelivery
    }
    return 'invalid'
  }
  const expiredRow = await Promise.resolve(
    batchDb.prepare(EXPIRED_EXPERT_SQL).get(codeHash),
  )
  if (expiredRow) return 'expired'

  const liveExpert = await Promise.resolve(
    batchDb.prepare(EXPERT_LIVE_SQL).get(expertId, empresaId),
  )
  if (!liveExpert) return 'deleted'

  const hasEmpresaChat = await Promise.resolve(
    batchDb.prepare(EMPRESA_CHAT_SQL).get(empresaId, chatStr),
  )
  if (!hasEmpresaChat) return 'wrong_chat'

  const existingThread = await Promise.resolve(
    batchDb.prepare(THREAD_OWNER_SQL).get(chatStr, threadStr),
  )
  if (existingThread && typeof existingThread.expert_id === 'string' && existingThread.expert_id !== expertId) {
    return 'thread_taken'
  }

  const existingTopic = await Promise.resolve(
    batchDb.prepare(EXPERT_TOPIC_SQL).get(expertId),
  )
  if (existingTopic && typeof existingTopic.chat_id === 'string' && typeof existingTopic.message_thread_id === 'string') {
    if (existingTopic.chat_id === chatStr && existingTopic.message_thread_id === threadStr) {
      return 'success' // redelivery
    }
    // same expert, new free thread → update
  }

  let results: unknown[]
  try {
    results = (await Promise.resolve(
      batchDb.batch([
        batchDb.prepare(CLAIM_EXPERT_SQL).bind(codeHash),
      ]),
    )) as unknown[]
  } catch (err) {
    if (isUniqueConstraintError(err)) return 'invalid'
    throw err
  }
  if (runChanges(results[0]) !== 1) {
    const existing = await Promise.resolve(
      batchDb.prepare(EXPERT_TOPIC_SQL).get(expertId),
    )
    if (existing && typeof existing.chat_id === 'string' && typeof existing.message_thread_id === 'string' && existing.chat_id === chatStr && existing.message_thread_id === threadStr) {
      return 'success'
    }
    return 'invalid'
  }

  try {
    if (existingTopic) {
      await Promise.resolve(
        batchDb.prepare(UPDATE_TOPIC_SQL).run(empresaId, chatStr, threadStr, expertId),
      )
    } else {
      await Promise.resolve(
        batchDb.prepare(INSERT_TOPIC_SQL).run(expertId, empresaId, chatStr, threadStr),
      )
    }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // unclaim
      await Promise.resolve(batchDb.prepare(`UPDATE telegram_bind_codes SET used_at = NULL WHERE code_hash = ?`).run(codeHash))
      return 'thread_taken'
    }
    throw err
  }
  return 'success'
}

async function claimViaImmediateTxn(
  batchDb: ReturnType<typeof ensureBatchDb>,
  codeHash: string,
  chatStr: string,
  threadStr: string,
): Promise<ExpertBindOutcome> {
  await Promise.resolve(batchDb.prepare('BEGIN IMMEDIATE').run())
  try {
    const claimResult = await Promise.resolve(
      batchDb.prepare(CLAIM_EXPERT_SQL).run(codeHash),
    )

    if (runChanges(claimResult) !== 1) {
      const expiredRow = await Promise.resolve(
        batchDb.prepare(EXPIRED_EXPERT_SQL).get?.(codeHash),
      )
      if (!expiredRow) {
        const codeRow = await Promise.resolve(
          batchDb.prepare(CODE_EXPERT_SQL).get?.(codeHash),
        )
        const empresaId =
          codeRow && typeof codeRow.empresa_id === 'string' ? codeRow.empresa_id : null
        const expertId =
          codeRow && typeof codeRow.expert_id === 'string' ? codeRow.expert_id : null
        if (empresaId && expertId) {
          const hasChat = await Promise.resolve(
            batchDb.prepare(EMPRESA_CHAT_SQL).get?.(empresaId, chatStr),
          )
          if (hasChat) {
            const existingTopic = await Promise.resolve(
              batchDb.prepare(EXPERT_TOPIC_SQL).get?.(expertId),
            )
            if (existingTopic && typeof existingTopic.chat_id === 'string' && typeof existingTopic.message_thread_id === 'string' && existingTopic.chat_id === chatStr && existingTopic.message_thread_id === threadStr) {
              await Promise.resolve(batchDb.prepare('ROLLBACK').run())
              return 'success'
            }
          }
        }
      }
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return expiredRow ? 'expired' : 'invalid'
    }

    const codeRow = await Promise.resolve(
      batchDb.prepare(CODE_EXPERT_SQL).get?.(codeHash),
    )
    const empresaId =
      codeRow && typeof codeRow.empresa_id === 'string' ? codeRow.empresa_id : null
    const expertId =
      codeRow && typeof codeRow.expert_id === 'string' ? codeRow.expert_id : null
    if (!empresaId || !expertId) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'invalid'
    }

    const liveExpert = await Promise.resolve(
      batchDb.prepare(EXPERT_LIVE_SQL).get?.(expertId, empresaId),
    )
    if (!liveExpert) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'deleted'
    }

    const hasEmpresaChat = await Promise.resolve(
      batchDb.prepare(EMPRESA_CHAT_SQL).get?.(empresaId, chatStr),
    )
    if (!hasEmpresaChat) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'wrong_chat'
    }

    const existingThread = await Promise.resolve(
      batchDb.prepare(THREAD_OWNER_SQL).get?.(chatStr, threadStr),
    )
    if (existingThread && typeof existingThread.expert_id === 'string' && existingThread.expert_id !== expertId) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'thread_taken'
    }

    const existingTopic = await Promise.resolve(
      batchDb.prepare(EXPERT_TOPIC_SQL).get?.(expertId),
    )
    if (existingTopic && typeof existingTopic.chat_id === 'string' && typeof existingTopic.message_thread_id === 'string') {
      if (existingTopic.chat_id === chatStr && existingTopic.message_thread_id === threadStr) {
        await Promise.resolve(batchDb.prepare('COMMIT').run())
        return 'success'
      }
    }

    try {
      if (existingTopic) {
        await Promise.resolve(
          batchDb.prepare(UPDATE_TOPIC_SQL).run(empresaId, chatStr, threadStr, expertId),
        )
      } else {
        await Promise.resolve(
          batchDb.prepare(INSERT_TOPIC_SQL).run(expertId, empresaId, chatStr, threadStr),
        )
      }
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        await Promise.resolve(batchDb.prepare('ROLLBACK').run())
        return 'thread_taken'
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
