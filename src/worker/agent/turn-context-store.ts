/** @description D1-backed one-shot turn context bridge for Flue gestao-bot agent. Stores encrypted LLM key + turn fields; single-use consume via turn_token. */

import { encryptLlmApiKey, decryptLlmApiKey } from '../services/llm-key-crypto.ts'
import type { DbLike } from '../types.ts'

export interface InsertTurnContextInput {
  empresaId: string
  expertId: string | null
  actorUserId: string
  surface: 'topic' | 'dm'
  provider: string
  apiKey: string
  message: string
  encryptionSecret: string
  dmBoundaryLine?: string | null
  botToken?: string // IGNORE — column removed by security; do not store
}

export interface TurnContextRow {
  ok: true
  empresa_id: string
  expert_id: string | null
  actor_user_id: string
  surface: 'topic' | 'dm'
  provider: string
  apiKey: string
  message: string
  dm_boundary_line?: string | null
}

export interface ConsumeFail {
  ok: false
  reason: 'not_found' | 'expired' | string
}

/**
 * @description Insert a turn context row, encrypt apiKey, return opaque turn_token. TTL 120s.
 * botToken param ignored (no column).
 */
export async function insertTurnContext(
  db: DbLike,
  input: InsertTurnContextInput,
): Promise<{ turn_token: string }> {
  const { ciphertextHex, ivHex } = await encryptLlmApiKey(input.encryptionSecret, input.apiKey)
  const turnToken = crypto.randomUUID()
  const expiresAt = "datetime('now', '+120 seconds')"

  const sql = `INSERT INTO telegram_agent_turn_context (
    turn_token, empresa_id, expert_id, actor_user_id, surface,
    provider, api_key_ciphertext, api_key_iv, dm_boundary_line, message, expires_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${expiresAt}, datetime('now'))`

  const params = [
    turnToken,
    input.empresaId,
    input.expertId,
    input.actorUserId,
    input.surface,
    input.provider,
    ciphertextHex,
    ivHex,
    input.dmBoundaryLine ?? null,
    input.message,
  ]

  await Promise.resolve(db.prepare(sql).run(...params))
  return { turn_token: turnToken }
}

/**
 * @description Consume (single-use DELETE RETURNING) a turn context by token.
 * Returns decrypted apiKey or fail reason. Rejects expired/missing/replay.
 */
export async function consumeTurnContext(
  db: DbLike,
  turnToken: string,
  encryptionSecret: string,
): Promise<TurnContextRow | ConsumeFail> {
  // Single-use: always DELETE on read, then check expiry on returned row
  const sql = `DELETE FROM telegram_agent_turn_context WHERE turn_token = ? RETURNING *`
  const row = await Promise.resolve(db.prepare(sql).get(turnToken)) as any
  if (!row) {
    return { ok: false, reason: 'not_found' }
  }
  const expCheck = await Promise.resolve(
    db.prepare(`SELECT datetime(?) <= datetime('now') AS expired`).get(row.expires_at)
  ) as any
  if (expCheck?.expired) {
    return { ok: false, reason: 'expired' }
  }
  try {
    const apiKey = await decryptLlmApiKey(
      encryptionSecret,
      row.api_key_ciphertext,
      row.api_key_iv,
    )
    return {
      ok: true,
      empresa_id: row.empresa_id,
      expert_id: row.expert_id,
      actor_user_id: row.actor_user_id,
      surface: row.surface,
      provider: row.provider,
      apiKey,
      message: row.message,
      dm_boundary_line: row.dm_boundary_line ?? undefined,
    }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** Rename one-shot token to agent-bound key so DO defineAgent can load after Worker route admission. */
export async function bindTurnTokenToAgent(db: DbLike, turnToken: string, agentId: string): Promise<boolean> {
  const sql = `UPDATE telegram_agent_turn_context
    SET turn_token = 'agent:' || ?
    WHERE turn_token = ? AND expires_at > datetime('now')`
  const res = await Promise.resolve(db.prepare(sql).run(agentId, turnToken)) as any
  return (res?.changes ?? res?.meta?.changes ?? 0) === 1
}

export async function consumeAgentBoundTurn(db: DbLike, agentId: string, encryptionSecret: string) {
  return consumeTurnContext(db, `agent:${agentId}`, encryptionSecret)
}
