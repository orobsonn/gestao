/** @description runAgentTurn client + identity prompt builder for Flue gestao-bot turns. Posts only {message} + turn headers; safe reply on failure. */


export interface BuildIdentityInput {
  empresaId: string
  expertId: string | null
  userId: string
  surface: 'topic' | 'dm'
  activeEmpresaId?: string | null
  db?: unknown
}

/**
 * @description Build minimal identity string for agent prompt. Includes ids/surface; NEVER dumps tarefas or titles even if db passed.
 */
export function buildAgentIdentityPrompt(input: BuildIdentityInput): string {
  const lines = [
    `empresa_id: ${input.empresaId}`,
    `expert_id: ${input.expertId ?? 'null'}`,
    `actor_user_id: ${input.userId}`,
    `surface: ${input.surface}`,
    input.activeEmpresaId ? `active_empresa_id: ${input.activeEmpresaId}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

export interface RunAgentTurnInput {
  sessionId: string
  message: string
  turnToken: string
  agentInternalSecret: string
  app: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }
  // gated fields ignored for body
  empresaId?: string
  expertId?: string | null
  userId?: string
  surface?: string
  provider?: string
  apiKey?: string
  db?: unknown
}

export const SAFE_REPLY = 'Não consegui processar agora. Tente de novo em instantes.'

/**
 * @description POST to Flue agent route with ONLY {message} body + secret + turn-token headers.
 * Returns text response or SAFE_REPLY on any failure. Never throws.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<string> {
  try {
    const url = `http://localhost/agents/gestao-bot/${input.sessionId}?wait=result`
    const res = await input.app.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gestao-agent-internal-secret': input.agentInternalSecret,
        'x-gestao-turn-token': input.turnToken,
      },
      body: JSON.stringify({ message: input.message }),
    })

    const raw = await res.text()
    if (!res.ok) {
      console.error('[runAgentTurn] non-ok', {
        status: res.status,
        sessionId: input.sessionId,
        body: raw.slice(0, 500),
      })
      return SAFE_REPLY
    }
    let text = ''
    try {
      const body = JSON.parse(raw) as { result?: unknown; error?: unknown }
      const r = body?.result
      if (typeof r === 'string') text = r.trim()
      else if (r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string') {
        text = String((r as { text: string }).text).trim()
      }
      if (!text) {
        console.error('[runAgentTurn] empty text', {
          sessionId: input.sessionId,
          keys: body && typeof body === 'object' ? Object.keys(body) : [],
          body: raw.slice(0, 500),
        })
      }
    } catch {
      // non-JSON body: only accept plain non-JSON text if it doesn't look like JSON object
      if (raw && !raw.trimStart().startsWith('{')) text = raw.trim()
      else {
        console.error('[runAgentTurn] non-json body', {
          sessionId: input.sessionId,
          body: raw.slice(0, 500),
        })
      }
    }
    return text || SAFE_REPLY
  } catch (err) {
    console.error('[runAgentTurn] throw', {
      sessionId: input.sessionId,
      err: err instanceof Error ? err.message : String(err),
    })
    return SAFE_REPLY
  }
}
