/** @description Bot turn orchestrator: surface→actor→dm-pin→llm→session→signal→agent gates.
 *  Dispatches a `{ kind: 'signal', type: 'telegram.message', body, attributes }` message to
 *  runAgentTurn instead of writing a D1 turn-context row — the closed attribute set carries no
 *  key material; the agent re-resolves+decrypts the LLM key itself inside the Durable Object.
 *  DM pin bootstrap/list/revalidate per LD-18. pending_boundary injects dmBoundaryLine once, then
 *  is cleared by the Worker before dispatch. Fail-closed pt-br. */
import { resolveTelegramTopicContext } from './resolve-telegram-topic-context.ts'
import { resolveTelegramActor } from './telegram-actor-gate.ts'
import { loadEmpresaLlmForBot } from './empresa-llm-gate.ts'
import { buildSessionId } from './build-session-id.ts'
import {
  getDmActiveEmpresa,
  upsertDmActiveEmpresa,
  clearDmActiveEmpresa,
  setDmPendingBoundary,
} from './telegram-dm-active-empresa.ts'
import type { DbLike } from '../types.ts'

/** Wire shape of the slice of a Telegram update this orchestrator reads. Every field is optional:
 *  it is untrusted webhook input and each accessor already guards. */
type TelegramEntity = { type?: string; offset?: number; length?: number }
export type TelegramUpdate = {
  message?: {
    text?: string
    entities?: TelegramEntity[]
    chat?: { id?: string | number; type?: string }
    from?: { id?: string | number }
    message_thread_id?: string | number
  }
}

/** An empresa as offered to the DM pin selector. */
type SelectableEmpresa = { id: string; nome: string }

/** @description Detect if update is a topic @mention of the bot (case-insensitive via entities). */
function isTopicMention(update: TelegramUpdate | null | undefined, botUsername: string | null | undefined): boolean {
  const msg = update?.message
  if (!msg || !msg.entities || !Array.isArray(msg.entities)) return false
  const text = msg.text || ''
  const botLower = String(botUsername || '').toLowerCase()
  for (const ent of msg.entities) {
    if (ent.type === 'mention') {
      // Coerce rather than reject: the untyped version accepted numeric strings, and narrowing the
      // accepted input set would silently stop detecting a legitimate mention.
      const offset = Number(ent.offset)
      const length = Number(ent.length)
      if (!Number.isFinite(offset) || !Number.isFinite(length)) continue
      const mention = text.slice(offset, offset + length)
      if (mention.toLowerCase() === `@${botLower}`) return true
    }
  }
  return false
}

/** @description Detect DM surface (private chat). */
function isDmSurface(update: TelegramUpdate | null | undefined): boolean {
  const chat = update?.message?.chat
  return Boolean(chat && chat.type === 'private')
}

/** @description Extract telegram user id as string. */
function getTelegramUserId(update: TelegramUpdate | null | undefined): string {
  return String(update?.message?.from?.id ?? '')
}

/** @description Extract message text. */
function getMessageText(update: TelegramUpdate | null | undefined): string {
  return String(update?.message?.text ?? '')
}

/** @description Get chat/thread ids as strings. */
function getTopicIds(update: TelegramUpdate | null | undefined): { chatId: string; threadId: string } {
  const msg = update?.message ?? {}
  return {
    chatId: String(msg.chat?.id ?? ''),
    threadId: String(msg.message_thread_id ?? ''),
  }
}

/**
 * @description Build the dispatched signal's `attributes` string-to-string map. The closed
 * attribute set is the CLOSED contract — every key/value here is emitted VERBATIM into the
 * model's context by the runtime (renderSignalMessage), so never include key material. A
 * null/undefined/empty-string candidate value is OMITTED (never coerced to the string `'null'`).
 */
function buildSignalAttributes(candidate: Record<string, string | null | undefined>): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const [key, value] of Object.entries(candidate)) {
    if (value === null || value === undefined || value === '') continue
    attributes[key] = value
  }
  return attributes
}

/** Wire shape of the signal message dispatched to runAgentTurn in place of the deleted D1
 *  turn-context row. */
type DispatchedSignal = {
  kind: 'signal'
  type: 'telegram.message'
  body: string
  attributes: Record<string, string>
}

/**
 * @description Extract reply text from whatever the injected runAgentTurn resolves — a bare
 * string (legacy callers/tests) or the `{ text | reply }` object the in-process Flue port
 * (run-agent-turn.ts) and the frozen webhook-level mocks both produce.
 */
function extractAgentReplyText(result: unknown): string {
  if (typeof result === 'string') return result || 'ok'
  if (result && typeof result === 'object') {
    const r = result as { text?: unknown; reply?: unknown }
    if (typeof r.text === 'string') return r.text
    if (typeof r.reply === 'string') return r.reply
  }
  return 'ok'
}

/**
 * @description Extract the RESOLVED dedupe key from whatever runAgentTurn resolves — `null`
 * when absent (a bare string result, or an object with no key), never `undefined`.
 */
function extractAgentReplyKey(result: unknown): string | null {
  if (result && typeof result === 'object') {
    const r = result as { key?: unknown; answeredBySubmissionId?: unknown }
    if (typeof r.key === 'string') return r.key
    if (typeof r.answeredBySubmissionId === 'string') return r.answeredBySubmissionId
  }
  return null
}

/** @description Fail-closed pt-br replies. */
const FAIL_UNLINKED =
  'Desculpe, você não está vinculado a esta empresa no Gestão. Use /vincular para conectar sua conta Telegram.'
const FAIL_LLM =
  'Configuração de LLM ausente ou inválida para esta empresa. Verifique as configurações de provedor e chave API.'
const FAIL_N0 =
  'Nenhuma empresa com membership ativa. Solicite acesso ou tente novamente mais tarde.'

/** @description List live empresas for user ordered by nome COLLATE NOCASE, id. */
async function listEmpresasForUserOrdered(db: DbLike, userId: string): Promise<SelectableEmpresa[]> {
    const rawRows = await Promise.resolve(
      db
        .prepare(
          `SELECT e.id, e.nome
           FROM empresas e
           INNER JOIN empresa_membros m ON m.empresa_id = e.id
           WHERE m.user_id = ? AND e.deleted_at IS NULL
           ORDER BY e.nome COLLATE NOCASE, e.id`,
        )
        .all(userId),
    )
  // NOT `Array.isArray(...) ? ... : []`. The caller treats an empty list as "this user belongs to
  // no empresa" and responds by DELETING their active-empresa pin, so a broken adapter must never
  // be able to look like that. Every other multi-row read here throws the same way.
  if (!Array.isArray(rawRows)) {
    throw new Error('db statement all() did not return an array')
  }
  return rawRows.map((r) => ({ id: String(r.id), nome: String(r.nome) }))
}

/** @description Check if text matches selector for bootstrap pin (exact id, unique nome, or 1-based index). Returns empresa or null. */
function matchBootstrapSelector(text: string, empresas: SelectableEmpresa[]): SelectableEmpresa | null {
  const t = text.trim()
  // exact id
  const byId = empresas.find((e: SelectableEmpresa) => e.id === t)
  if (byId) return byId
  // unique nome (case-insensitive exact)
  const byNome = empresas.filter((e: SelectableEmpresa) => e.nome.toLowerCase() === t.toLowerCase())
  if (byNome.length === 1) return byNome[0]
  // 1-based index
  if (/^\d+$/.test(t)) {
    const idx = parseInt(t, 10)
    if (idx >= 1 && idx <= empresas.length) {
      return empresas[idx - 1]
    }
  }
  return null
}

/** @description Main orchestrator entry. */
export async function handleBotTurn({
  db,
  update,
  botUsername,
  llmKeyEncryptionSecret,
  runAgentTurn,
}: {
  db: DbLike
  update: any
  botUsername: string
  llmKeyEncryptionSecret: string
  runAgentTurn: (args: any) => Promise<unknown>
}): Promise<{ reply: string; answeredBySubmissionId: string | null }> {
  const telegramUserId = getTelegramUserId(update)
  const messageText = getMessageText(update)

  // surface detection
  const isTopic = isTopicMention(update, botUsername)
  const isDm = isDmSurface(update)

  if (!isTopic && !isDm) {
    return { reply: FAIL_UNLINKED, answeredBySubmissionId: null }
  }

  if (isDm) {
    const userLink = await Promise.resolve(
      db
        .prepare(
          `SELECT user_id FROM user_telegram_links WHERE telegram_user_id = ? LIMIT 1`,
        )
        .get(telegramUserId),
    )
    if (!userLink) {
      return { reply: FAIL_UNLINKED, answeredBySubmissionId: null }
    }
    const userId = String(userLink.user_id)

    // revalidate live memberships
    const empresas = await listEmpresasForUserOrdered(db, userId)
    if (empresas.length === 0) {
      await clearDmActiveEmpresa(db, userId)
      return { reply: FAIL_N0, answeredBySubmissionId: null }
    }

    let pin = await getDmActiveEmpresa(db, userId)
    const priorEmpresaId = pin ? pin.empresa_id : null
    let empresaId
    let expertId = null // DM has no expert
    let pendingBoundary = 0

    if (pin) {
      // check if pin still valid (live membership)
      const pinnedEmpresaId = pin.empresa_id
      const stillLive = empresas.some((e) => e.id === pinnedEmpresaId)
      if (!stillLive) {
        await clearDmActiveEmpresa(db, userId)
        pin = null
      }
    }

    if (!pin) {
      const selectorMatch = matchBootstrapSelector(messageText, empresas)
      if (selectorMatch) {
        await upsertDmActiveEmpresa(db, userId, selectorMatch.id)
        if (selectorMatch.id !== priorEmpresaId) {
          await setDmPendingBoundary(db, userId, 1)
        }
        return {
          reply: `Empresa ${selectorMatch.nome} definida como ativa.`,
          answeredBySubmissionId: null,
        }
      }
      if (empresas.length === 1) {
        // N=1 auto-pin
        await upsertDmActiveEmpresa(db, userId, empresas[0].id)
        empresaId = empresas[0].id
        pendingBoundary = empresas[0].id !== priorEmpresaId ? 1 : 0
      } else {
        // N>1 unpinned, no valid selector → list for bootstrap, no agent
        const listText = empresas
          .map((e, i) => `${i + 1}. ${e.nome} (${e.id})`)
          .join('\n')
        return {
          reply: `Empresas disponíveis:\n${listText}`,
          answeredBySubmissionId: null,
        }
      }
    } else {
      empresaId = pin.empresa_id
      pendingBoundary = pin.pending_boundary || 0
    }

    // now we have empresaId
    const llm = await loadEmpresaLlmForBot(db, empresaId, llmKeyEncryptionSecret)
    if (!llm.ok) {
      return { reply: FAIL_LLM, answeredBySubmissionId: null }
    }

    const sessionId = buildSessionId({ kind: 'dm', empresaId, userId })

    let dmBoundaryLine: string | null = null
    if (pendingBoundary === 1) {
      dmBoundaryLine =
        'Atenção: resultados de ferramentas anteriores podem pertencer a outra empresa/tenant.'
    }

    const attributes = buildSignalAttributes({
      empresaId,
      expertId,
      actorUserId: userId,
      surface: 'dm',
      provider: llm.provider,
      modelId: llm.model,
      dmBoundaryLine,
    })

    // The DM boundary line is cleared exactly once, by the Worker, before dispatch — never
    // inside the agent render, which runs ~2x per submission and must stay side-effect-free.
    if (pendingBoundary === 1) {
      await setDmPendingBoundary(db, userId, 0)
    }

    const signal: DispatchedSignal = {
      kind: 'signal',
      type: 'telegram.message',
      body: messageText,
      attributes,
    }
    const agentResult = await runAgentTurn({
      sessionId,
      message: signal,
    })
    return {
      reply: extractAgentReplyText(agentResult),
      answeredBySubmissionId: extractAgentReplyKey(agentResult),
    }
  } else if (isTopic) {
    const { chatId, threadId } = getTopicIds(update)
    const context = await resolveTelegramTopicContext(db, chatId, threadId)
    if (!context) {
      return { reply: FAIL_UNLINKED, answeredBySubmissionId: null }
    }
    const actor = await resolveTelegramActor(db, telegramUserId, context.empresa_id)
    if (!actor.ok) {
      return { reply: FAIL_UNLINKED, answeredBySubmissionId: null }
    }
    const llm = await loadEmpresaLlmForBot(
      db,
      context.empresa_id,
      llmKeyEncryptionSecret,
    )
    if (!llm.ok) {
      return { reply: FAIL_LLM, answeredBySubmissionId: null }
    }
    const sessionId = buildSessionId({
      kind: 'topic',
      chatId,
      threadId,
    })
    const attributes = buildSignalAttributes({
      empresaId: context.empresa_id,
      expertId: context.expert_id,
      actorUserId: actor.userId,
      surface: 'topic',
      provider: llm.provider,
      modelId: llm.model,
    })
    const signal: DispatchedSignal = {
      kind: 'signal',
      type: 'telegram.message',
      body: messageText,
      attributes,
    }
    const agentResult = await runAgentTurn({
      sessionId,
      message: signal,
    })
    return {
      reply: extractAgentReplyText(agentResult),
      answeredBySubmissionId: extractAgentReplyKey(agentResult),
    }
  }

  return { reply: FAIL_UNLINKED, answeredBySubmissionId: null }
}
