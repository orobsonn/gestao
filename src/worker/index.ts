/** @description Cloudflare Worker entry — FK pragma, bootstrap SA, auth/platform/empresa routes, ASSETS. */

import { Hono } from 'hono'
import { ensureBootstrapSuperAdmin } from './auth/bootstrap.ts'
import { enableForeignKeysAsync } from './db.ts'
import { createAuthApp } from './routes/auth.ts'
import { createEmpresaApp } from './routes/empresa.ts'
import { createPlatformApp } from './routes/platform.ts'
import { createTelegramApp } from './routes/telegram.ts'
import { runAgentTurn } from './agent/run-agent-turn.ts'
import type { BatchDbLike, BatchStatement } from './services/create-empresa.ts'
import type { DbLike, StatementLike } from './types.ts'
import { flue } from '@flue/runtime/routing'

/**
 * @description Worker bindings: D1, static assets, optional super-admin bootstrap secrets,
 * optional LLM key encryption secret, optional single-app Telegram bot secrets
 * (never wrangler vars — runtime secret / .dev.vars).
 */
export type WorkerEnv = {
  DB: D1Database
  ASSETS: Fetcher
  SUPER_ADMIN_EMAIL?: string
  SUPER_ADMIN_PASSWORD?: string
  LLM_KEY_ENCRYPTION_SECRET?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_BOT_USERNAME?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  GESTAO_AGENT_INTERNAL_SECRET?: string
}

/**
 * @description D1 adapter: DbLike (get/run/all) + bind/batch for atomic multi-statement writes.
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
        async all(...params: unknown[]) {
          const stmt = d1.prepare(sql)
          const result =
            params.length === 0
              ? await stmt.all()
              : await stmt.bind(...params).all()
          return (result?.results ?? []) as Record<string, unknown>[]
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
 * @description Dispatch /api/auth/* to createAuthApp closed over this request's DB + bot username.
 */
app.all('/api/auth/*', (c) => {
  const db = d1AsDbLike(c.env.DB)
  return createAuthApp(db, {
    botUsername: c.env.TELEGRAM_BOT_USERNAME,
  }).fetch(c.req.raw)
})

/**
 * @description Dispatch /api/platform/* to createPlatformApp closed over this request's DB.
 */
app.all('/api/platform/*', (c) => {
  const db = d1AsDbLike(c.env.DB)
  return createPlatformApp(db).fetch(c.req.raw)
})

/**
 * @description Dispatch /api/empresa/* to createEmpresaApp closed over this request's DB + LLM deps.
 * Default probe is used in prod (no llmProbe inject); secret from WorkerEnv only.
 */
app.all('/api/empresa/*', (c) => {
  const db = d1AsDbLike(c.env.DB)
  return createEmpresaApp(db, {
    llmKeyEncryptionSecret: c.env.LLM_KEY_ENCRYPTION_SECRET,
  }).fetch(c.req.raw)
})

/**
 * @description Dispatch /api/telegram/* via createTelegramApp — webhook secret + bot token + fetch.
 * Mounted before ASSETS; single global bot secrets from WorkerEnv only.
 */
app.all('/api/telegram/*', (c) => {
  const db = d1AsDbLike(c.env.DB)
  const waitUntil = c.executionCtx?.waitUntil?.bind(c.executionCtx)
  return createTelegramApp(db, {
    botUsername: c.env.TELEGRAM_BOT_USERNAME,
    llmKeyEncryptionSecret: c.env.LLM_KEY_ENCRYPTION_SECRET,
    waitUntil,
    agentInternalSecret: c.env.GESTAO_AGENT_INTERNAL_SECRET,
    runAgentTurn: (args) =>
      runAgentTurn({
        sessionId: args.sessionId,
        message: args.message,
        turnToken: args.turnToken,
        agentInternalSecret: c.env.GESTAO_AGENT_INTERNAL_SECRET ?? '',
        app: {
          // Hono fetch wants a Request; runAgentTurn passes (url, init) — must not drop init.
          fetch: (input, init) => {
            const req =
              input instanceof Request
                ? input
                : new Request(String(input), init)
            return app.fetch(req, c.env, c.executionCtx)
          },
        },
      }),
    botToken: c.env.TELEGRAM_BOT_TOKEN,
    webhookSecret: c.env.TELEGRAM_WEBHOOK_SECRET,
    fetchImpl: fetch,
  }).fetch(c.req.raw)
})

/**
 * @description Mount Flue agent routes (gestao-bot) BEFORE ASSETS catch-all so agent HTTP is not swallowed by SPA.
 */
app.route('/', flue())

/**
 * @description Non-API: serve SPA/static assets (run_worker_first + not_found SPA).
 */
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
