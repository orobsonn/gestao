/** @description Durable single-send guard for Telegram agent replies. */

import type { DbLike } from '../types.ts'

const INSERT_GUARD_SQL = `INSERT OR IGNORE INTO telegram_agent_reply_sends (answered_by_submission_id) VALUES (?)`

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

/**
 * @description Claim that this specific answer has been sent.
 * Returns { claimed: true } only for the first processor to successfully insert the ID.
 * @throws If answeredBySubmissionId is null, undefined, or empty string.
 */
export async function claimAgentReplySend(
  db: DbLike,
  answeredBySubmissionId: string,
): Promise<{ claimed: boolean }> {
  if (!answeredBySubmissionId) {
    throw new Error(`claimAgentReplySend requires a non-empty answeredBySubmissionId; received: ${answeredBySubmissionId}`)
  }

  const result = await Promise.resolve(
    db.prepare(INSERT_GUARD_SQL).run(answeredBySubmissionId),
  )
  const changes = runChanges(result)
  return { claimed: changes === 1 }
}
