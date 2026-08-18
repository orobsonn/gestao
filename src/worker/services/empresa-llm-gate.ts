/** @description Empresa LLM health-and-decrypt gate for bot turns. ok only on has_key && status==='valid'; decrypt only then. */
import type { DbLike } from '../types.ts'
import { decryptLlmApiKey } from './llm-key-crypto.ts'
import { isCuratedLlmModel, type LlmProvider } from './llm-model-catalog.ts'
import { normalizeStoredModelId, resolveEmpresaLlmTurnModel } from './llm-turn-model.ts'

type LoadEmpresaLlmResult =
  | {
      ok: true
      provider: 'openai' | 'anthropic'
      apiKey: string
      model: string
    }
  | {
      ok: false
      reason:
        | 'llm_not_configured'
        | 'llm_key_missing'
        | 'llm_key_unvalidated'
        | 'llm_key_invalid'
    }

type LlmSettingsRow = {
  empresa_id: string
  provider: string | null
  model_id: string | null
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
        `SELECT empresa_id, provider, model_id, api_key_ciphertext, api_key_iv, status
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
    model_id: normalizeStoredModelId(row.model_id),
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
  const curatedModelId =
    row.model_id && isCuratedLlmModel(row.provider as LlmProvider, row.model_id)
      ? row.model_id
      : null
  if (row.model_id && !curatedModelId) {
    // Every sibling degrade on this path logs; without this one the operator sees the dashboard
    // say "provider default" with no way to correlate why the bot changed model.
    console.warn(
      JSON.stringify({
        op: 'loadEmpresaLlmForBot',
        level: 'warn',
        empresaId,
        provider: row.provider,
        reason: 'stored_model_left_catalog',
      }),
    )
  }
  try {
    const apiKey = await decryptLlmApiKey(
      encryptionSecret,
      row.api_key_ciphertext,
      row.api_key_iv,
    )
    return {
      ok: true,
      provider: row.provider,
      apiKey,
      // A model that left the catalog between deploys would still be a well-FORMED id, so the
      // format guard passes it through and the runtime resolves it to zero metadata — every turn
      // fails silently. Degrade to the locked default instead, which is pinned to be resolvable.
      model: resolveEmpresaLlmTurnModel(row.provider, curatedModelId),
    }
  } catch {
    return { ok: false, reason: 'llm_key_invalid' }
  }
}
