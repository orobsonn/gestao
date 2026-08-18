/**
 * @description Timing-safe internal-secret guard for the gestao-bot agent mount.
 *
 * In Flue 2.x `createAgentRouter` serves POST /:id, GET|HEAD /:id (the FULL
 * conversation history — a tenant-data read), POST /:id/abort and
 * GET /:id/attachments/:attachmentId per conversation, and a mounted agent has
 * NO built-in auth. The beta's per-agent `export const route` convention that
 * invoked this guard is deleted, so it is re-homed here as ordinary Hono
 * middleware. Node-importable: no `cloudflare:` import.
 *
 * Two properties are load-bearing and preserved exactly from the beta guard:
 *  - the secret comparison is TIMING-SAFE;
 *  - an empty/unset `GESTAO_AGENT_INTERNAL_SECRET` fails CLOSED (always 403).
 */
import type { MiddlewareHandler } from 'hono'

const SECRET_HEADER = 'x-gestao-agent-internal-secret'

/**
 * @description Timing-safe string equality. Uses Web Crypto where available
 * (Cloudflare Workers exposes `crypto.subtle.timingSafeEqual`), falling back to
 * Node's `timingSafeEqual` over equal-length SHA-256 digests so the comparison
 * never short-circuits on length mismatch.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
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

/** @description 403 denial response — sanitized body, no tenant/agent payload. */
function forbidden(): Response {
  return new Response('{"error":"forbidden"}', { status: 403 })
}

/**
 * @description Build a Hono middleware that enforces the internal secret for a
 * FIXED env. Empty/whitespace env secret fails closed (always 403, never calls
 * `next`). A correct header passes through; missing/wrong header is 403.
 *
 * Factored for unit tests and composition assertions that construct the guard
 * from a concrete env object. The live mount uses {@link agentSecretGuard},
 * which reads the per-request env.
 * @param {Record<string, unknown>} env
 * @returns {MiddlewareHandler}
 */
export function createAgentSecretGuard(env: Record<string, unknown>): MiddlewareHandler {
  const secret = String(env?.GESTAO_AGENT_INTERNAL_SECRET ?? '').trim()
  if (!secret) {
    return async () => forbidden()
  }
  return async (c, next) => {
    const header = c.req.header(SECRET_HEADER)
    if (!header) return forbidden()
    if (!(await safeEqual(secret, header))) return forbidden()
    await next()
  }
}

/**
 * @description Hono middleware for the gestao-bot agent mount. Reads
 * `GESTAO_AGENT_INTERNAL_SECRET` from the per-request env (`c.env`) and fails
 * closed on an empty/unset secret. Registered BEFORE
 * `app.route('/agents/gestao-bot', createAgentRouter(GestaoBot))` so it covers
 * every route the router serves.
 */
export const agentSecretGuard: MiddlewareHandler = async (c, next) => {
  const env = (c.env ?? {}) as Record<string, unknown>
  return createAgentSecretGuard(env)(c, next)
}