/** @description Worker DB helpers — enable SQLite foreign keys on every connection. */

import type { DbLike } from './types.ts'

/**
 * @description Enable FK enforcement on a connection (required; migrations do not set it).
 * Call immediately after open for node:sqlite or D1.
 */
export function enableForeignKeys(db: DbLike): void {
  db.prepare('PRAGMA foreign_keys = ON').run()
}

/**
 * @description Async variant for D1-style prepare().run() that returns a Promise.
 * Prefer when the binding's statement.run is async.
 */
export async function enableForeignKeysAsync(
  db: {
    prepare: (sql: string) => { run: (...params: unknown[]) => unknown }
  },
): Promise<void> {
  await db.prepare('PRAGMA foreign_keys = ON').run()
}
