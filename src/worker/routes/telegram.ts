/** @description Telegram webhook routes — atomic one-time code claim + user↔telegram link (hermetic via createTelegramApp). */

import { Hono } from 'hono'
import { ensureBatchDb } from '../services/create-empresa.ts'
import type { DbLike } from '../types.ts'
import {
  claimCodeAndBindEmpresa,
  type EmpresaBindOutcome,
} from '../services/telegram-bind-empresa.ts'
import {
  claimCodeAndBindExpert,
  type ExpertBindOutcome,
} from '../services/telegram-bind-expert.ts'

const WEBHOOK_PATH = '/api/telegram/webhook'
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token'
const CODE_HEX_RE = /^[0-9a-f]{64}$/
/** @description /start or /start@botname with optional payload. */
const START_CMD_RE = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/
/** @description /vincular_empresa <code> (optional @bot suffix). */
const VINCULAR_EMPRESA_CMD_RE =
  /^\/vincular_empresa(?:@[A-Za-z0-9_]+)?\s+([0-9a-f]{64})$/
/** @description /vincular_expert <code> (optional @bot suffix). */
const VINCULAR_EXPERT_CMD_RE =
  /^\/vincular_expert(?:@[A-Za-z0-9_]+)?\s+([0-9a-f]{64})$/
/** @description Bot API sendMessage timeout (ms) — webhook still returns 200 on failure. */
const SEND_MESSAGE_TIMEOUT_MS = 8000

const COPY_SUCCESS = 'Conta vinculada com sucesso. Pode voltar ao Gestão.'
const COPY_INVALID =
  'Código inválido ou já usado. Gere um novo link em Minha conta.'
const COPY_EXPIRED = 'Código expirado. Gere um novo link em Minha conta.'
const COPY_COLLISION = 'Este Telegram já está vinculado a outra conta.'

/** @description Empresa group bind success copy. */
const COPY_EMPRESA_SUCCESS = 'Grupo vinculado com sucesso.'
/** @description Empresa invalid/used copy. */
const COPY_EMPRESA_INVALID =
  'Código inválido ou já usado. Gere um novo comando em Admin → Telegram.'
/** @description Empresa expired copy. */
const COPY_EMPRESA_EXPIRED =
  'Código expirado. Gere um novo comando em Admin → Telegram.'
/** @description Not group/supergroup reject. */
const COPY_EMPRESA_NOT_GROUP =
  'Este comando só funciona em um grupo ou supergrupo.'
/** @description Chat taken by other empresa. */
const COPY_EMPRESA_CHAT_TAKEN =
  'Este grupo já está vinculado a outra empresa.'
/** @description Empresa already linked to different chat. */
const COPY_EMPRESA_ALREADY_LINKED =
  'Esta empresa já está vinculada a outro grupo.'

/** @description Expert topic bind success copy. */
const COPY_EXPERT_SUCCESS = 'Tópico vinculado com sucesso.'
/** @description Expert invalid/used copy. */
const COPY_EXPERT_INVALID =
  'Código inválido ou já usado. Gere um novo comando em Admin → Telegram.'
/** @description Expert expired copy. */
const COPY_EXPERT_EXPIRED =
  'Código expirado. Gere um novo comando em Admin → Telegram.'
/** @description Not group/supergroup reject for expert. */
const COPY_EXPERT_NOT_GROUP =
  'Este comando só funciona em um grupo ou supergrupo.'
/** @description Missing message_thread_id reject. */
const COPY_EXPERT_MISSING_THREAD =
  'Este comando só funciona dentro de um tópico do grupo.'
/** @description Wrong chat (no matching empresa_telegram_chats). */
const COPY_EXPERT_WRONG_CHAT =
  'Vincule o grupo da empresa antes, ou use o grupo correto.'
/** @description Thread taken by other expert. */
const COPY_EXPERT_THREAD_TAKEN =
  'Este tópico já está vinculado a outro expert.'
/** @description Soft-deleted expert reject. */
const COPY_EXPERT_DELETED =
  'Expert não encontrado ou removido. Gere um novo comando em Admin → Telegram.'

/** @description Optional deps for createTelegramApp — single global bot secrets + injectable fetch. */
export type TelegramAppDeps = {
  botToken?: string
  webhookSecret?: string
  fetchImpl?: typeof fetch
}

/** @description Outcome of atomic claim + optional link bind. */
type ClaimBindOutcome = 'success' | 'collision' | 'invalid' | 'expired'

/**
 * @description Convert bytes to lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @description SHA-256 hex digest of a UTF-8 string (raw link code).
 */
async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
}

/**
 * @description Constant-time equality for equal-length byte arrays.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

/**
 * @description Timing-safe string equality via UTF-8 bytes (length mismatch → false).
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder()
  return timingSafeEqual(enc.encode(a), enc.encode(b))
}

/**
 * @description Rows affected by stmt.run() — node:sqlite `{changes}` or D1 `{meta.changes}`.
 */
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
 * @description Reply via Bot API sendMessage; no-op when botToken blank/missing.
 * Timeout + swallow errors so webhook can still ack Telegram with HTTP 200.
 * Optional threadId → includes message_thread_id in payload.
 */
async function sendTelegramMessage(
  deps: TelegramAppDeps,
  chatId: number | string,
  text: string,
  threadId?: number | string,
): Promise<void> {
  const token = deps.botToken?.trim()
  if (!token) return

  const fetchImpl = deps.fetchImpl ?? fetch
  const payload: Record<string, unknown> = { chat_id: chatId, text }
  if (threadId != null) {
    payload.message_thread_id = threadId
  }
  try {
    await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS),
    })
  } catch {
    // Bot API down/timeout must not fail the webhook ack.
  }
}

const CLAIM_SQL = `UPDATE telegram_link_codes
   SET used_at = datetime('now')
   WHERE code_hash = ?
     AND used_at IS NULL
     AND expires_at > datetime('now')`

const EXPIRED_SQL = `SELECT 1 AS ok FROM telegram_link_codes
   WHERE code_hash = ?
     AND used_at IS NULL
     AND expires_at <= datetime('now')`

const CODE_USER_SQL = `SELECT user_id FROM telegram_link_codes WHERE code_hash = ?`

const LINK_BY_TG_SQL = `SELECT user_id FROM user_telegram_links WHERE telegram_user_id = ?`

const UPSERT_SQL = `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(user_id) DO UPDATE SET
     telegram_user_id = excluded.telegram_user_id,
     linked_at = excluded.linked_at`

/**
 * @description UPSERT only when this batch's claim UPDATE changed 1 row (same txn).
 * Used on D1 native batch where interactive BEGIN is unavailable.
 */
const UPSERT_IF_CLAIMED_SQL = `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
   SELECT c.user_id, ?, datetime('now')
   FROM telegram_link_codes c
   WHERE c.code_hash = ?
     AND changes() = 1
     AND NOT EXISTS (
       SELECT 1 FROM user_telegram_links l
       WHERE l.telegram_user_id = ? AND l.user_id != c.user_id
     )
   ON CONFLICT(user_id) DO UPDATE SET
     telegram_user_id = excluded.telegram_user_id,
     linked_at = excluded.linked_at`

/**
 * @description Post-claim read: collision (tg on other user) vs success.
 */
async function outcomeAfterClaimed(
  db: DbLike,
  codeHash: string,
  telegramUserId: string,
): Promise<ClaimBindOutcome> {
  const codeRow = await Promise.resolve(
    db.prepare(CODE_USER_SQL).get(codeHash),
  )
  const userId =
    codeRow && typeof codeRow.user_id === 'string' ? codeRow.user_id : null
  if (!userId) return 'invalid'

  const existingByTg = await Promise.resolve(
    db.prepare(LINK_BY_TG_SQL).get(telegramUserId),
  )
  if (
    existingByTg &&
    typeof existingByTg.user_id === 'string' &&
    existingByTg.user_id !== userId
  ) {
    return 'collision'
  }
  return 'success'
}

/**
 * @description Detect SQLite/D1 unique-constraint failures (telegram_user_id race).
 */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

/**
 * @description D1 path: claim + conditional UPSERT in one native batch transaction.
 * UNIQUE on telegram_user_id → collision (claim may already be consumed in the batch).
 */
async function claimCodeAndBindViaBatch(
  db: DbLike,
  codeHash: string,
  telegramUserId: string,
): Promise<ClaimBindOutcome> {
  const batchDb = ensureBatchDb(
    db as Parameters<typeof ensureBatchDb>[0],
  )

  let results: unknown[]
  try {
    results = (await Promise.resolve(
      batchDb.batch([
        batchDb.prepare(CLAIM_SQL).bind(codeHash),
        batchDb
          .prepare(UPSERT_IF_CLAIMED_SQL)
          .bind(telegramUserId, codeHash, telegramUserId),
      ]),
    )) as unknown[]
  } catch (err) {
    if (isUniqueConstraintError(err)) return 'collision'
    throw err
  }

  if (runChanges(results[0]) !== 1) {
    const expiredRow = await Promise.resolve(
      db.prepare(EXPIRED_SQL).get(codeHash),
    )
    return expiredRow ? 'expired' : 'invalid'
  }
  return outcomeAfterClaimed(db, codeHash, telegramUserId)
}

/**
 * @description node:sqlite hermetic path: BEGIN IMMEDIATE, claim, collision check, UPSERT, COMMIT.
 * Collision commits claim without link; UNIQUE race on tg id also keeps claim consumed.
 */
async function claimCodeAndBindViaImmediateTxn(
  db: DbLike,
  codeHash: string,
  telegramUserId: string,
): Promise<ClaimBindOutcome> {
  const batchDb = ensureBatchDb(
    db as Parameters<typeof ensureBatchDb>[0],
  )

  await Promise.resolve(batchDb.prepare('BEGIN IMMEDIATE').run())
  try {
    const claimResult = await Promise.resolve(
      batchDb.prepare(CLAIM_SQL).run(codeHash),
    )

    if (runChanges(claimResult) !== 1) {
      const expiredRow = await Promise.resolve(
        batchDb.prepare(EXPIRED_SQL).get?.(codeHash),
      )
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return expiredRow ? 'expired' : 'invalid'
    }

    const codeRow = await Promise.resolve(
      batchDb.prepare(CODE_USER_SQL).get?.(codeHash),
    )
    const userId =
      codeRow && typeof codeRow.user_id === 'string' ? codeRow.user_id : null
    if (!userId) {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
      return 'invalid'
    }

    const existingByTg = await Promise.resolve(
      batchDb.prepare(LINK_BY_TG_SQL).get?.(telegramUserId),
    )

    if (existingByTg && typeof existingByTg.user_id === 'string') {
      if (existingByTg.user_id !== userId) {
        await Promise.resolve(batchDb.prepare('COMMIT').run())
        return 'collision'
      }
      await Promise.resolve(batchDb.prepare('COMMIT').run())
      return 'success'
    }

    try {
      await Promise.resolve(
        batchDb.prepare(UPSERT_SQL).run(userId, telegramUserId),
      )
    } catch {
      // UNIQUE telegram_user_id race — keep claim consumed (collision path).
      await Promise.resolve(batchDb.prepare('COMMIT').run())
      return 'collision'
    }

    await Promise.resolve(batchDb.prepare('COMMIT').run())
    return 'success'
  } catch (err) {
    try {
      await Promise.resolve(batchDb.prepare('ROLLBACK').run())
    } catch {
      /* ignore rollback errors */
    }
    throw err
  }
}

/**
 * @description Atomic claim (conditional UPDATE changes===1) + bind/relink.
 * Hermetic node:sqlite → BEGIN IMMEDIATE; D1 (db.batch) → single batch txn.
 */
async function claimCodeAndBindTelegram(
  db: DbLike,
  codeHash: string,
  telegramUserId: string,
): Promise<ClaimBindOutcome> {
  if (typeof (db as { batch?: unknown }).batch === 'function') {
    return claimCodeAndBindViaBatch(db, codeHash, telegramUserId)
  }
  return claimCodeAndBindViaImmediateTxn(db, codeHash, telegramUserId)
}

/**
 * @description Build a Hono app with POST /api/telegram/webhook (atomic code claim + link).
 * Closes over `db` for hermetic tests (node:sqlite) and worker mounting.
 * Single global botToken/webhookSecret only — never empresa-scoped.
 */
export function createTelegramApp(
  db: DbLike,
  deps: TelegramAppDeps = {},
): Hono {
  const app = new Hono()

  app.post(WEBHOOK_PATH, async (c) => {
    // Fail-closed webhook secret: blank/missing env or header mismatch → 401, no DB, no fetch.
    const configured = deps.webhookSecret
    if (!configured?.trim()) {
      return c.body(null, 401)
    }
    const header = c.req.header(SECRET_HEADER) ?? ''
    if (!timingSafeEqualString(header, configured)) {
      return c.body(null, 401)
    }

    // After secret OK: always HTTP 200 (business errors go to Bot API copy only).
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.body(null, 200)
    }

    const message =
      body != null &&
      typeof body === 'object' &&
      'message' in body &&
      (body as { message: unknown }).message != null &&
      typeof (body as { message: unknown }).message === 'object'
        ? (body as { message: Record<string, unknown> }).message
        : null

    if (!message) {
      return c.body(null, 200)
    }

    const text = typeof message.text === 'string' ? message.text : null
    if (text == null) {
      return c.body(null, 200)
    }

    const startMatch = text.match(START_CMD_RE)
    if (startMatch) {
      // DM /start path unchanged — delegate to existing claimCodeAndBindTelegram.
      const from =
        message.from != null && typeof message.from === 'object'
          ? (message.from as Record<string, unknown>)
          : null
      const chat =
        message.chat != null && typeof message.chat === 'object'
          ? (message.chat as Record<string, unknown>)
          : null
      const fromId = from != null && typeof from.id === 'number' ? from.id : null
      const chatId =
        chat != null && (typeof chat.id === 'number' || typeof chat.id === 'string')
          ? chat.id
          : fromId

      if (fromId == null || chatId == null) {
        return c.body(null, 200)
      }

      const rawCode = (startMatch[1] ?? '').trim()
      if (!CODE_HEX_RE.test(rawCode)) {
        await sendTelegramMessage(deps, chatId, COPY_INVALID)
        return c.body(null, 200)
      }

      const codeHash = await sha256Hex(rawCode)
      const telegramUserId = String(fromId)

      try {
        const outcome = await claimCodeAndBindTelegram(
          db,
          codeHash,
          telegramUserId,
        )
        const copy =
          outcome === 'success'
            ? COPY_SUCCESS
            : outcome === 'collision'
              ? COPY_COLLISION
              : outcome === 'expired'
                ? COPY_EXPIRED
                : COPY_INVALID
        await sendTelegramMessage(deps, chatId, copy)
      } catch {
        // Swallow — ack Telegram; do not surface internal errors.
      }
      return c.body(null, 200)
    }

    const vincularMatch = text.match(VINCULAR_EMPRESA_CMD_RE)
    if (vincularMatch) {
      const chat =
        message.chat != null && typeof message.chat === 'object'
          ? (message.chat as Record<string, unknown>)
          : null
      const chatType = chat != null && typeof chat.type === 'string' ? chat.type : null
      const chatId =
        chat != null && (typeof chat.id === 'number' || typeof chat.id === 'string')
          ? chat.id
          : null
      const threadId =
        message != null &&
        typeof message === 'object' &&
        'message_thread_id' in message &&
        (typeof (message as Record<string, unknown>).message_thread_id === 'number' ||
          typeof (message as Record<string, unknown>).message_thread_id === 'string')
          ? (message as Record<string, unknown>).message_thread_id as number | string
          : undefined

      if (!chatId) {
        return c.body(null, 200)
      }

      if (chatType !== 'group' && chatType !== 'supergroup') {
        await sendTelegramMessage(deps, chatId, COPY_EMPRESA_NOT_GROUP, threadId)
        return c.body(null, 200)
      }

      const rawCode = vincularMatch[1]!
      const codeHash = await sha256Hex(rawCode)

      try {
        const outcome: EmpresaBindOutcome = await claimCodeAndBindEmpresa(
          db,
          codeHash,
          chatId,
        )
        let copy: string
        if (outcome === 'success') {
          copy = COPY_EMPRESA_SUCCESS
        } else if (outcome === 'expired') {
          copy = COPY_EMPRESA_EXPIRED
        } else if (outcome === 'chat_taken') {
          copy = COPY_EMPRESA_CHAT_TAKEN
        } else if (outcome === 'already_linked') {
          copy = COPY_EMPRESA_ALREADY_LINKED
        } else {
          copy = COPY_EMPRESA_INVALID
        }
        await sendTelegramMessage(deps, chatId, copy, threadId)
      } catch {
        // Swallow — ack Telegram.
      }
      return c.body(null, 200)
    }

    const vincularExpertMatch = text.match(VINCULAR_EXPERT_CMD_RE)
    if (vincularExpertMatch) {
      const chat =
        message.chat != null && typeof message.chat === 'object'
          ? (message.chat as Record<string, unknown>)
          : null
      const chatType = chat != null && typeof chat.type === 'string' ? chat.type : null
      const chatId =
        chat != null && (typeof chat.id === 'number' || typeof chat.id === 'string')
          ? chat.id
          : null
      const threadId =
        message != null &&
        typeof message === 'object' &&
        'message_thread_id' in message &&
        (typeof (message as Record<string, unknown>).message_thread_id === 'number' ||
          typeof (message as Record<string, unknown>).message_thread_id === 'string')
          ? (message as Record<string, unknown>).message_thread_id as number | string
          : undefined

      if (!chatId) {
        return c.body(null, 200)
      }

      if (chatType !== 'group' && chatType !== 'supergroup') {
        await sendTelegramMessage(deps, chatId, COPY_EXPERT_NOT_GROUP, threadId)
        return c.body(null, 200)
      }

      if (threadId == null) {
        await sendTelegramMessage(deps, chatId, COPY_EXPERT_MISSING_THREAD, threadId)
        return c.body(null, 200)
      }

      const rawCode = vincularExpertMatch[1]!
      const codeHash = await sha256Hex(rawCode)

      try {
        const outcome: ExpertBindOutcome = await claimCodeAndBindExpert(
          db,
          codeHash,
          chatId,
          threadId,
        )
        let copy: string
        if (outcome === 'success') {
          copy = COPY_EXPERT_SUCCESS
        } else if (outcome === 'expired') {
          copy = COPY_EXPERT_EXPIRED
        } else if (outcome === 'thread_taken') {
          copy = COPY_EXPERT_THREAD_TAKEN
        } else if (outcome === 'wrong_chat') {
          copy = COPY_EXPERT_WRONG_CHAT
        } else if (outcome === 'deleted') {
          copy = COPY_EXPERT_DELETED
        } else {
          copy = COPY_EXPERT_INVALID
        }
        await sendTelegramMessage(deps, chatId, copy, threadId)
      } catch {
        // Swallow — ack Telegram.
      }
      return c.body(null, 200)
    }

    // Non-/start and non-/vincular_empresa update — ack only.
    return c.body(null, 200)

    const from =
      message.from != null && typeof message.from === 'object'
        ? (message.from as Record<string, unknown>)
        : null
    const chat =
      message.chat != null && typeof message.chat === 'object'
        ? (message.chat as Record<string, unknown>)
        : null
    const fromId = from != null && typeof from.id === 'number' ? from.id : null
    const chatId =
      chat != null && (typeof chat.id === 'number' || typeof chat.id === 'string')
        ? chat.id
        : fromId

    if (fromId == null || chatId == null) {
      return c.body(null, 200)
    }

    const rawCode = (startMatch[1] ?? '').trim()
    if (!CODE_HEX_RE.test(rawCode)) {
      await sendTelegramMessage(deps, chatId, COPY_INVALID)
      return c.body(null, 200)
    }

    const codeHash = await sha256Hex(rawCode)
    const telegramUserId = String(fromId)

    // Post-auth: always 200 even if claim/send throws (Telegram retries on non-2xx).
    try {
      const outcome = await claimCodeAndBindTelegram(
        db,
        codeHash,
        telegramUserId,
      )
      const copy =
        outcome === 'success'
          ? COPY_SUCCESS
          : outcome === 'collision'
            ? COPY_COLLISION
            : outcome === 'expired'
              ? COPY_EXPIRED
              : COPY_INVALID
      await sendTelegramMessage(deps, chatId, copy)
    } catch {
      // Swallow — ack Telegram; do not surface internal errors.
    }
    return c.body(null, 200)
  })

  return app
}
