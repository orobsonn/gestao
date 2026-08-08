/** @description Webhook dedup via telegram_webhook_updates (INSERT OR IGNORE on update_id). */

import type { DbLike } from '../types.ts'

const INSERT_DEDUP_SQL = `INSERT OR IGNORE INTO telegram_webhook_updates (update_id) VALUES (?)`

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
 * @description Claim update_id for processing. Returns { claimed: true } only for first processor.
 * Uses INSERT OR IGNORE; changes===1 means this call won the race.
 */
export async function claimTelegramUpdateId(
  db: DbLike,
  updateId: string,
): Promise<{ claimed: boolean }> {
  const result = await Promise.resolve(
    db.prepare(INSERT_DEDUP_SQL).run(updateId),
  )
  const changes = runChanges(result)
  return { claimed: changes === 1 }
}
