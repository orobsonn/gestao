/** @description Flue gestao-bot: agent definition, secret guard, D1 turn bridge + ALS. */

import { defineAgent, registerProvider, type AgentRouteHandler } from '@flue/runtime'
import { createGestaoBotTools, type GestaoBotToolsClosure } from '../../src/worker/agent/gestao-bot-tools.ts'
import { bindTurnTokenToAgent, consumeAgentBoundTurn, consumeTurnContext } from '../../src/worker/agent/turn-context-store.ts'
import { enableForeignKeysAsync } from '../../src/worker/db.ts'
import { buildAgentIdentityPrompt } from '../../src/worker/agent/run-agent-turn.ts'
const playbook = `**Playbook curto (pt-br) para o agente gestao-bot**

- Use tools para estado (listar/criar/atualizar/excluir tarefas, listar membros, etc.).
- Recuse qualquer pedido de criar campanha — diga que o usuário deve criar via web.
- Em DM: switch de empresa via definir_empresa_ativa termina o turn imediatamente (tool terminal).
- Nunca invente tenant ids, expert ids ou dados de outras empresas.
- DM boundary line (se presente) avisa que resultados anteriores podem ser de outra empresa.`

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

/** @description Empty sandbox per Flue contract — minimal SessionEnv stubs (write/exec throw). */
const emptySandbox = {
  createSessionEnv: async () => ({
    exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    readFile: async () => { throw new Error('disabled') },
    readFileBuffer: async () => { throw new Error('disabled') },
    writeFile: async () => { throw new Error('disabled') },
    stat: async () => { throw new Error('disabled') },
    readdir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
  }),
  tools: () => [],
}

/** @description Exported for tests (sandbox.tools factory returns []). */
export const gestaoBotAgent = { sandbox: emptySandbox }

/** @description Default defineAgent — plain config, id NOT spread, tools array not factory. */
export default defineAgent(async ({ id, env }) => {
  const db = asDbLike((env as any).DB)
  const secret = (env as any).LLM_KEY_ENCRYPTION_SECRET as string | undefined
  if (!secret) {
    return { model: modelForProvider('openai'), instructions: playbook, tools: [], sandbox: emptySandbox }
  }
  const cacheKey = id
  const consumed = await consumeAgentBoundTurn(db, id, secret)
  if (!consumed.ok) {
    turnCache.delete(cacheKey)
    return { model: modelForProvider('openai'), instructions: playbook, tools: [], sandbox: emptySandbox }
  }
  turnCache.set(cacheKey, { ctx: consumed, expiresAtMs: Date.now() + 120_000 })
  const ctx = consumed
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
  return { model: modelForProvider(ctx.provider), instructions, tools, sandbox: emptySandbox }
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
