/** @description Flue gestao-bot: agent definition, secret guard, D1 turn bridge + ALS. */

import { defineAgent, registerProvider, type AgentRouteHandler } from '@flue/runtime'
import { createGestaoBotTools, type GestaoBotToolsClosure } from '../../src/worker/agent/gestao-bot-tools.ts'
import { bindTurnTokenToAgent, consumeAgentBoundTurn } from '../../src/worker/agent/turn-context-store.ts'
import { enableForeignKeysAsync } from '../../src/worker/db.ts'
import { buildAgentIdentityPrompt } from '../../src/worker/agent/run-agent-turn.ts'
const playbook = `**Playbook gestao-bot (pt-br) — respostas no Telegram**

## Formato (obrigatório)
- Respostas curtas, mobile-first, otimizadas para Telegram.
- Use *negrito* (um asterisco) e _itálico_ quando ajudar; evite markdown de título (#) e HTML.
- Emojis com sentido (não enfeite à toa):
  - 📋 lista de tarefas · 📝 a fazer · 🔄 fazendo · ✅ feito
  - ➕ criou · ✏️ atualizou · 🗑 excluiu · 👥 membros · 🏢 empresa · ⚠️ erro/aviso · 📭 vazio
- Listas: uma linha por item, com bullet • ou emoji de status — sem "1. **Título:** … **Status:** …".
- Se a tool devolver \`telegram_preview\`, use esse texto (pode enxugar, não reformatar do zero).
- Máx. ~15 itens visíveis; se houver mais, diga quantos ficaram de fora.
- Sem jargão técnico, sem ids UUID na resposta (a menos que o usuário peça).
- Sem despedida longa; 1 linha de oferta de ajuda no máximo.

## Regras de domínio
- Use tools para estado (listar/criar/atualizar/excluir tarefas, listar membros, etc.).
- Recuse criar campanha — oriente pela web.
- Em DM: definir_empresa_ativa termina o turn na hora (tool terminal).
- Nunca invente tenant/expert ids nem dados de outra empresa.
- Se houver DM boundary line, avise que resultados anteriores podem ser de outra empresa.`

const SECRET_HEADER = 'x-gestao-agent-internal-secret'
const TURN_TOKEN_HEADER = 'x-gestao-turn-token'

const turnCache = new Map<string, { ctx: any; expiresAtMs: number }>()

function asDbLike(d1: any) {
  if (d1 && typeof d1.prepare === 'function' && d1.prepare('').get?.length !== undefined) return d1 // already DbLike
  return {
    prepare(sql: string) {
      const stmt = d1.prepare(sql)
      return {
        bind(...p: unknown[]) { return stmt.bind(...p) },
        async get(...p: unknown[]) { const b = p.length ? stmt.bind(...p) : stmt; return b.first ? b.first() : b.get?.(...p) },
        async run(...p: unknown[]) { const b = p.length ? stmt.bind(...p) : stmt; const r = await (b.run ? b.run() : Promise.resolve(b)); return r },
        async all(...p: unknown[]) { const b = p.length ? stmt.bind(...p) : stmt; if (b.all) { const r = await b.all(); return r.results ?? r }; return [] },
      }
    },
  }
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  try {
    const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)))
    const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)))
    return crypto.subtle.timingSafeEqual(ha, hb)
  } catch {
    const { timingSafeEqual, createHash } = await import('node:crypto')
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
  }
}

/**
 * @description Timing-safe secret guard. Returns 403 Response on missing/wrong/empty-env; null on pass.
 */
export function createAgentSecretGuard(env: Record<string, unknown>) {
  const secret = (env?.GESTAO_AGENT_INTERNAL_SECRET as string | undefined)?.trim() ?? ''
  if (!secret) {
    return async (_req: Request) => new Response('{"error":"forbidden"}', { status: 403 })
  }
  return async (request: Request): Promise<Response | null> => {
    const header = request.headers.get(SECRET_HEADER)
    if (!header) {
      return new Response('{"error":"forbidden"}', { status: 403 })
    }
    if (!(await safeEqual(secret, header))) {
      return new Response('{"error":"forbidden"}', { status: 403 })
    }
    return null
  }
}

/**
 * @description Check if tool result signals terminal stop (definir_empresa_ativa etc.).
 */
export function isTerminalToolResult(result: unknown): boolean {
  return result != null && typeof result === 'object' && (result as any).terminal === true
}

class TerminalToolStopError extends Error {
  constructor(message: string) { super(message); this.name = 'TerminalToolStopError' }
}

function withTerminalStop(tools: any[]) {
  return tools.map((t) => ({
    ...t,
    run: async (args: any) => {
      const r = await t.run(args)
      if (isTerminalToolResult(r)) {
        throw new TerminalToolStopError(
          String((r as any).message ?? 'turno encerrado'),
        )
      }
      return r
    },
  }))
}

function modelForProvider(p: string): string {
  if (p === 'anthropic') return 'anthropic/claude-sonnet-4-6'
  return 'openai/gpt-4o-mini'
}

/**
 * @description Run tool calls in order until a terminal result or no more calls.
 */
export async function runAgentToolCallsUntilStop({
  tools,
  calls,
}: {
  tools: Array<{ name: string; run: (args: { input: any }) => Promise<any> }>
  calls: Array<{ name: string; input?: any; arguments?: any }>
}): Promise<void> {
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) continue
    const input = (call as any).input ?? (call as any).arguments ?? {}
    const result = await tool.run({ input })
    if (isTerminalToolResult(result)) {
      break
    }
  }
}

/** @description Agent workspace root — Flue paths call cwd.endsWith; must be a real string. */
const AGENT_CWD = '/session'

/**
 * @description Minimal SessionEnv for Workers (no real FS). cwd/resolvePath required by Flue path helpers.
 * Application tools must NOT go in sandbox.tools (that channel skips valibot→parameters); they go on defineAgent.tools.
 */
const minimalSessionEnv = {
  cwd: AGENT_CWD,
  exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
  readFile: async () => {
    throw new Error('disabled')
  },
  readFileBuffer: async () => {
    throw new Error('disabled')
  },
  writeFile: async () => {},
  stat: async () => ({
    type: 'file' as const,
    size: 0,
    isFile: true,
    isDirectory: false,
  }),
  readdir: async () => [],
  exists: async () => false,
  mkdir: async () => {},
  rm: async () => {},
  resolvePath: (p: string) => p,
}

/** @description Sandbox factory — session FS only; no bash/write/edit workspace tools. */
const emptySandbox = {
  createSessionEnv: async () => minimalSessionEnv,
  tools: () => [],
}

/** @description Exported for tests (sandbox.tools factory returns []). */
export const gestaoBotAgent = { sandbox: emptySandbox }

function baseAgentConfig(model: string) {
  return {
    model,
    cwd: AGENT_CWD,
    instructions: playbook,
    tools: [] as ReturnType<typeof createGestaoBotTools>,
    sandbox: emptySandbox,
  }
}

/** @description Default defineAgent — plain config, id NOT spread, tools array not factory. */
export default defineAgent(async ({ id, env }) => {
  const db = asDbLike((env as any).DB)
  const secret = (env as any).LLM_KEY_ENCRYPTION_SECRET as string | undefined
  if (!secret) {
    return baseAgentConfig(modelForProvider('openai'))
  }
  // Flue may initialize defineAgent twice in one submission (Worker route + DO).
  // Turn row is single-use: first init consumes; second must reuse DO-local cache
  // or we register no API key → "No API key for provider: openai".
  const cacheKey = id
  let ctx: any = null
  const consumed = await consumeAgentBoundTurn(db, id, secret)
  if (consumed.ok) {
    turnCache.set(cacheKey, { ctx: consumed, expiresAtMs: Date.now() + 120_000 })
    ctx = consumed
  } else {
    const hit = turnCache.get(cacheKey)
    if (hit && hit.expiresAtMs > Date.now()) {
      ctx = hit.ctx
    } else {
      turnCache.delete(cacheKey)
      return baseAgentConfig(modelForProvider('openai'))
    }
  }
  await enableForeignKeysAsync(db)
  if (ctx.provider && ctx.apiKey) registerProvider(ctx.provider, { apiKey: ctx.apiKey })
  const token = String((env as any).TELEGRAM_BOT_TOKEN ?? '').trim()
  const closure: GestaoBotToolsClosure = {
    empresa_id: ctx.empresa_id,
    expert_id: ctx.expert_id,
    actor_user_id: ctx.actor_user_id,
    surface: ctx.surface,
    db,
    sendNotify: async (telegramUserId: string, text: string) => {
      if (!token) throw new Error('bot token missing')
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramUserId, text }),
      })
      if (!res.ok) throw new Error('notify failed')
    },
  }
  const tools = withTerminalStop(createGestaoBotTools(closure))
  const identity = buildAgentIdentityPrompt({
    empresaId: ctx.empresa_id,
    expertId: ctx.expert_id,
    userId: ctx.actor_user_id,
    surface: ctx.surface,
  })
  const boundary = ctx.dm_boundary_line ? `\n${ctx.dm_boundary_line}` : ''
  const instructions = playbook + '\n' + identity + boundary
  return {
    model: modelForProvider(ctx.provider),
    cwd: AGENT_CWD,
    instructions,
    tools,
    sandbox: emptySandbox,
  }
})

/**
 * @description Hono middleware route (c, next) per Flue contract. Binds token to agentId after secret guard.
 */
export const route: AgentRouteHandler = async (c, next) => {
  const denied = await createAgentSecretGuard(c.env as any)(c.req.raw)
  if (denied) return denied
  const token = c.req.header(TURN_TOKEN_HEADER)
  const agentId = c.req.param('id')
  if (!token || !agentId) {
    return c.body('{"error":"forbidden"}', 403)
  }
  const db = asDbLike(c.env.DB)
  const ok = await bindTurnTokenToAgent(db, token, agentId)
  if (!ok) return c.body('{"error":"forbidden"}', 403)
  await next()
}
