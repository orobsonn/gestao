/** @description Cloudflare Worker entry — FK pragma, bootstrap SA, auth/platform routes, ASSETS. */

import { Hono } from 'hono'
import { ensureBootstrapSuperAdmin } from './auth/bootstrap.ts'
import { enableForeignKeysAsync } from './db.ts'
import { createAuthApp } from './routes/auth.ts'
import { createPlatformApp } from './routes/platform.ts'
import type { BatchDbLike, BatchStatement } from './services/create-empresa.ts'
import type { DbLike, StatementLike } from './types.ts'

/**
 * @description Worker bindings: D1, static assets, optional super-admin bootstrap secrets.
 */
export type WorkerEnv = {
  DB: D1Database
  ASSETS: Fetcher
  SUPER_ADMIN_EMAIL?: string
  SUPER_ADMIN_PASSWORD?: string
}

/**
 * @description D1 adapter: DbLike (get/run) + bind/batch for atomic multi-statement writes.
 */
function d1AsDbLike(d1: D1Database): DbLike & BatchDbLike {
  return {
    prepare(sql: string): StatementLike & {
      bind(...params: unknown[]): BatchStatement
    } {
      return {
        run(...params: unknown[]) {
          const stmt = d1.prepare(sql)
          if (params.length === 0) return stmt.run()
          return stmt.bind(...params).run()
        },
        async get(...params: unknown[]) {
          const stmt = d1.prepare(sql)
          const row =
            params.length === 0
              ? await stmt.first()
              : await stmt.bind(...params).first()
          // D1 first() yields null; DbLike uses undefined for missing rows.
          return row ?? undefined
        },
        bind(...params: unknown[]) {
          const bound = d1.prepare(sql).bind(...params)
          return bound as unknown as BatchStatement
        },
      }
    },
    batch(statements: BatchStatement[]) {
      return d1.batch(statements as unknown as D1PreparedStatement[])
    },
  }
}

const app = new Hono<{ Bindings: WorkerEnv }>()

/**
 * @description API only: enable FKs + bootstrap SA. ASSETS skip D1 entirely.
 * Bootstrap fail-closed → 503 JSON (no secrets in body).
 */
app.use('/api/*', async (c, next) => {
  await enableForeignKeysAsync(c.env.DB)
  const db = d1AsDbLike(c.env.DB)
  const bootstrap = await ensureBootstrapSuperAdmin(db, {
    email: c.env.SUPER_ADMIN_EMAIL,
    password: c.env.SUPER_ADMIN_PASSWORD,
  })
  if (!bootstrap.ok) {
    return c.json({ error: 'Service unavailable' }, 503)
  }
  await next()
})

/**
 * @description Dispatch /api/auth/* to createAuthApp closed over this request's DB.
 */
app.all('/api/auth/*', (c) => {
  const db = d1AsDbLike(c.env.DB)
  return createAuthApp(db).fetch(c.req.raw)
})

/**
 * @description Dispatch /api/platform/* to createPlatformApp closed over this request's DB.
 */
app.all('/api/platform/*', (c) => {
  const db = d1AsDbLike(c.env.DB)
  return createPlatformApp(db).fetch(c.req.raw)
})

/**
 * @description Non-API: serve SPA/static assets (run_worker_first + not_found SPA).
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
