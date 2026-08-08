/** @description Empresa LLM health-and-decrypt gate for bot turns. ok only on has_key && status==='valid'; decrypt only then. */
import type { DbLike } from '../types.ts'

type LoadEmpresaLlmResult =
  | { ok: true; provider: 'openai' | 'anthropic'; apiKey: string }
  | {
      ok: false
      reason:
        | 'llm_not_configured'
        | 'llm_key_missing'
        | 'llm_key_unvalidated'
        | 'llm_key_invalid'
    }

import { decryptLlmApiKey } from './llm-key-crypto.ts'

type LlmSettingsRow = {
  empresa_id: string
  provider: string | null
  api_key_ciphertext: string | null
  api_key_iv: string | null
  status: string
}

function rowHasKey(row: LlmSettingsRow): boolean {
  return (
    typeof row.api_key_ciphertext === 'string' &&
    row.api_key_ciphertext.length > 0
  )
}

async function loadSettingsRow(
  db: DbLike,
  empresaId: string,
): Promise<LlmSettingsRow | null> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT empresa_id, provider, api_key_ciphertext, api_key_iv, status
         FROM empresa_llm_settings WHERE empresa_id = ?`,
      )
      .get(empresaId),
  )
  if (!row || typeof row.empresa_id !== 'string') {
    return null
  }
  return {
    empresa_id: row.empresa_id,
    provider: typeof row.provider === 'string' ? row.provider : null,
    api_key_ciphertext:
      typeof row.api_key_ciphertext === 'string'
        ? row.api_key_ciphertext
        : row.api_key_ciphertext == null
          ? null
          : String(row.api_key_ciphertext),
    api_key_iv:
      typeof row.api_key_iv === 'string'
        ? row.api_key_iv
        : row.api_key_iv == null
          ? null
          : String(row.api_key_iv),
    status: typeof row.status === 'string' ? row.status : 'unvalidated',
  }
}

export async function loadEmpresaLlmForBot(
  db: DbLike,
  empresaId: string,
  encryptionSecret: string,
): Promise<LoadEmpresaLlmResult> {
  const row = await loadSettingsRow(db, empresaId)
  if (!row) {
    return { ok: false, reason: 'llm_not_configured' }
  }
  if (!rowHasKey(row)) {
    return { ok: false, reason: 'llm_key_missing' }
  }
  if (row.status !== 'valid') {
    if (row.status === 'unvalidated') {
      return { ok: false, reason: 'llm_key_unvalidated' }
    }
    if (row.status === 'invalid') {
      return { ok: false, reason: 'llm_key_invalid' }
    }
    return { ok: false, reason: 'llm_key_invalid' }
  }
  // has_key && status === 'valid' — now decrypt
  if (
    !row.api_key_ciphertext ||
    !row.api_key_iv ||
    (row.provider !== 'openai' && row.provider !== 'anthropic')
  ) {
    return { ok: false, reason: 'llm_key_invalid' }
  }
  try {
    const apiKey = await decryptLlmApiKey(
      encryptionSecret,
      row.api_key_ciphertext,
      row.api_key_iv,
    )
    return { ok: true, provider: row.provider, apiKey }
  } catch {
    return { ok: false, reason: 'llm_key_invalid' }
  }
}
