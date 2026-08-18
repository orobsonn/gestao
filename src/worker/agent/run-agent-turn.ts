/**
 * @description In-process Flue 2.x agent-turn client. The beta's wait-for-result query param
 * does not exist in Flue 2.x — `POST /agents/<name>/<id>` returns 202 and the reply is read
 * from the conversation, so this module dispatches via an injected agent-handle PORT
 * (`dispatch({ message }) -> receipt`,
 * `read(receipt, { signal, onEvent }) -> reply`) and resolves `{ text, key }`.
 *
 * The dedupe key is ALWAYS `settledChunk.answeredBySubmissionId ?? receipt.submissionId` —
 * never the raw (possibly absent) field, which against a `TEXT PRIMARY KEY NOT NULL` column
 * would coerce to the literal string 'undefined' and mute every later solo reply.
 *
 * The `submission-settled` listener filters by `chunk.submissionId === receipt.submissionId`
 * because `read()` starts at offset `-1` and replays every settlement in the instance's
 * history; without the filter, a later coalesced settlement could overwrite this turn's key.
 *
 * Three distinct branches: a rejected read (AgentRunError / local timeout) resolves the
 * existing pt-br SAFE_REPLY with a null key so an apology is never suppressed by the send
 * guard; a settled empty or whitespace-only text (e.g. a tool that returned terminate: true,
 * or a model reply of only spaces) resolves a pt-br confirmation — NEVER SAFE_REPLY; otherwise
 * the resolved text and key.
 */

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

/** @description Durable dispatch admission — the shape an agent handle's dispatch() resolves. */
export interface AgentTurnReceipt {
  submissionId: string
  acceptedAt: string
  uid: string
}

/**
 * @description One projected conversation-stream chunk; only `submission-settled` matters here,
 * and only for its `answeredBySubmissionId` — present ONLY when this delivery's submission
 * JOINED another submission's live response.
 */
export interface AgentTurnStreamChunk {
  type: string
  submissionId?: string
  answeredBySubmissionId?: string
  [key: string]: unknown
}

/** @description The settled reply a read() resolves with. */
export interface AgentTurnReply {
  text: string
  submissionId: string
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
  uid?: string
}

export interface AgentTurnReadOptions {
  signal?: AbortSignal
  onEvent?: (chunk: AgentTurnStreamChunk) => void
}

/**
 * @description Injected agent-handle port — the seam that keeps this module node-importable
 * without pulling in a live Flue runtime. The production port is the per-request handle
 * `init(GestaoBot, { id: sessionId })` built by the Worker entry.
 */
export interface AgentTurnPort {
  dispatch(request: { message: string }): Promise<AgentTurnReceipt>
  read(target: AgentTurnReceipt, options?: AgentTurnReadOptions): Promise<AgentTurnReply>
}

export interface RunAgentTurnInput {
  sessionId: string
  message: string
  port: AgentTurnPort
}

export interface RunAgentTurnResult {
  text: string
  key: string | null
}

export const SAFE_REPLY = 'Não consegui processar agora. Tente de novo em instantes.'

/**
 * @description pt-br confirmation for a successfully terminated turn with no assistant text
 * (e.g. a tool returning `terminate: true`, such as a DM company switch). NEVER SAFE_REPLY —
 * an empty successful turn is not a failure.
 */
const EMPTY_TEXT_CONFIRMATION = 'Feito! Ação concluída com sucesso.'

/**
 * @description Local read bound only — the submission keeps running past this; the durable
 * bound is the agent's `durability` static (`timeoutMs: 60000`). Comfortably inside that
 * budget and inside Telegram's webhook patience.
 */
const TURN_READ_TIMEOUT_MS = 50000

/**
 * @description Dispatch one turn to the injected agent-handle port and resolve `{ text, key }`.
 * Never throws: a rejected read resolves `SAFE_REPLY` with a `null` key.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  try {
    const receipt = await input.port.dispatch({ message: input.message })
    // A holder object, not a reassigned `let` — reassignment from inside the `onEvent`
    // closure otherwise confuses control-flow narrowing at the read below.
    const settled: { chunk: AgentTurnStreamChunk | null } = { chunk: null }
    const reply = await input.port.read(receipt, {
      signal: AbortSignal.timeout(TURN_READ_TIMEOUT_MS),
      onEvent: (chunk) => {
        if (
          chunk &&
          chunk.type === 'submission-settled' &&
          chunk.submissionId === receipt.submissionId
        ) {
          settled.chunk = chunk
        }
      },
    })
    const key = settled.chunk?.answeredBySubmissionId ?? receipt.submissionId
    if (!reply.text.trim()) {
      return { text: EMPTY_TEXT_CONFIRMATION, key }
    }
    return { text: reply.text, key }
  } catch (err) {
    console.error(
      JSON.stringify({
        op: 'runAgentTurn',
        level: 'error',
        sessionId: input.sessionId,
        message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      }),
    )
    return { text: SAFE_REPLY, key: null }
  }
}
