/** @description Empresa LLM settings routes — encrypted key metadata, validate probe, health. */

import type { Hono } from 'hono'
import { z } from 'zod'
import type { ActiveEmpresaVariables } from '../middleware/require-active-empresa.ts'
import { requireActiveEmpresa } from '../middleware/require-active-empresa.ts'
import { requireEmpresaAdmin } from '../middleware/require-empresa-admin.ts'
import { requireSession } from '../middleware/require-session.ts'
import {
  decryptLlmApiKey,
  encryptLlmApiKey,
} from '../services/llm-key-crypto.ts'
import {
  getLlmModelCatalog,
  isCuratedLlmModel,
  type LlmProvider,
} from '../services/llm-model-catalog.ts'
import { normalizeStoredModelId } from '../services/llm-turn-model.ts'
import type { DbLike } from '../types.ts'

const PROBE_TIMEOUT_MS = 8000
const MAX_PUT_PAYLOAD_BYTES = 16 * 1024
const MAX_MODEL_ID_LENGTH = 200
/**
 * SQLite's bare TRIM() strips ASCII space only, while `String.prototype.trim()` strips the whole
 * whitespace set. The CAS compares a JS-trimmed value against the column, so the two must agree or
 * a row holding e.g. a trailing newline could never be saved again.
 */
const SQL_TRIM_CHARS =
  "' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || " +
  "char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || " +
  "char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || " +
  "char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)"
const OPENAI_PROBE_URL = 'https://api.openai.com/v1/models'
const ANTHROPIC_PROBE_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'

/** @description Injectable probe used by POST validate (hermetic tests inject; prod uses default). */
export type LlmProbe = (args: {
  provider: 'openai' | 'anthropic'
  apiKey: string
}) => Promise<
  | { ok: true }
  | { ok: false; kind: 'auth_rejected' | 'incomplete'; message?: string }
>

/** @description Optional deps closed over by LLM settings routes. */
export type LlmSettingsDeps = {
  llmKeyEncryptionSecret?: string
  llmProbe?: LlmProbe
}

/** @description Metadata DTO only — never includes key/ciphertext/iv. */
export type LlmSettingsMetadata = {
  provider: 'openai' | 'anthropic' | null
  model_id: string | null
  /** The empresa's stored choice when it is no longer curated; null otherwise. */
  retired_model_id: string | null
  models: readonly string[]
  has_key: boolean
  status: 'none' | 'unvalidated' | 'valid' | 'invalid'
  validated_at: string | null
  last_error: string | null
}

/** @description Health payload for any active member. */
export type LlmHealthResponse =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'llm_not_configured'
        | 'llm_key_missing'
        | 'llm_key_unvalidated'
        | 'llm_key_invalid'
    }

/** @description DB row shape for empresa_llm_settings (nullable key material). */
type LlmSettingsRow = {
  empresa_id: string
  provider: string | null
  api_key_ciphertext: string | null
  api_key_iv: string | null
  model_id: string | null
  status: string
  validated_at: string | null
  last_error: string | null
}

const putBodySchema = z.union([
  // `null` clears the model back to the per-provider default. The empty string is deliberately
  // NOT accepted: it would persist a value the gate cannot resolve and kill the empresa's turns.
  z
    .object({
      model_id: z.union([z.string().min(1).max(MAX_MODEL_ID_LENGTH), z.null()]),
    })
    .strict(),
  z
    .object({
      provider: z.enum(['openai', 'anthropic']),
      api_key: z.string().min(1).max(8192),
    })
    .strict(),
])

/**
 * @description True when encryption secret is present and non-whitespace.
 */
function hasUsableSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.trim().length > 0
}

/**
 * @description has_key = ciphertext non-null non-empty.
 */
function rowHasKey(row: LlmSettingsRow): boolean {
  return (
    typeof row.api_key_ciphertext === 'string' &&
    row.api_key_ciphertext.length > 0
  )
}

/** @description Read a request body incrementally without materializing oversized payloads. */
async function readLimitedBody(
  request: Request,
): Promise<string | null> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const declaredLength = Number(contentLength)
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_PUT_PAYLOAD_BYTES) {
      return null
    }
  }

  if (!request.body) {
    return ''
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_PUT_PAYLOAD_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * @description Map DB row (or null) to Metadata DTO. status 'none' means no row.
 */
function toMetadata(row: LlmSettingsRow | null): LlmSettingsMetadata {
  if (!row) {
    return {
      provider: null,
      model_id: null,
      retired_model_id: null,
      models: [],
      has_key: false,
      status: 'none',
      validated_at: null,
      last_error: null,
    }
  }

  const provider =
    row.provider === 'openai' || row.provider === 'anthropic'
      ? row.provider
      : null

  const status =
    row.status === 'unvalidated' ||
    row.status === 'valid' ||
    row.status === 'invalid'
      ? row.status
      : 'unvalidated'

  return {
    provider,
    // Mirror the read-side degrade: naming a model that left the catalog would leave the Select
    // blank with the save button disabled, and the operator stuck with no way to pick again.
    model_id:
      provider && row.model_id && isCuratedLlmModel(provider as LlmProvider, row.model_id)
        ? row.model_id
        : null,
    // Surfacing the discarded choice: reverting it silently leaves the admin looking at
    // "provider default" with no idea their explicit pick was dropped.
    retired_model_id:
      provider && row.model_id && !isCuratedLlmModel(provider as LlmProvider, row.model_id)
        ? row.model_id
        : null,
    models: provider ? [...getLlmModelCatalog(provider as LlmProvider)] : [],
    has_key: rowHasKey(row),
    status,
    validated_at:
      typeof row.validated_at === 'string' && row.validated_at.length > 0
        ? row.validated_at
        : null,
    last_error:
      typeof row.last_error === 'string' && row.last_error.length > 0
        ? row.last_error
        : null,
  }
}

/**
 * @description Health from Metadata: ok only when has_key && status === 'valid'.
 */
function toHealth(meta: LlmSettingsMetadata): LlmHealthResponse {
  if (meta.status === 'none') {
    return { ok: false, reason: 'llm_not_configured' }
  }
  if (!meta.has_key) {
    return { ok: false, reason: 'llm_key_missing' }
  }
  if (meta.status === 'unvalidated') {
    return { ok: false, reason: 'llm_key_unvalidated' }
  }
  if (meta.status === 'invalid') {
    return { ok: false, reason: 'llm_key_invalid' }
  }
  // has_key && status === 'valid'
  return { ok: true }
}

/**
 * @description Load settings row for tenant (session-scoped empresa id only).
 */
async function loadSettingsRow(
  db: DbLike,
  empresaId: string,
): Promise<LlmSettingsRow | null> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT empresa_id, provider, api_key_ciphertext, api_key_iv,
                model_id, status, validated_at, last_error
         FROM empresa_llm_settings WHERE empresa_id = ?`,
      )
      .get(empresaId),
  )
  return normalizeSettingsRow(row)
}

/** @description Coerces one raw settings row into the typed shape; null when the row is absent. */
function normalizeSettingsRow(row: any): LlmSettingsRow | null {
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
    model_id: normalizeStoredModelId(row.model_id),
    status: typeof row.status === 'string' ? row.status : 'unvalidated',
    validated_at:
      typeof row.validated_at === 'string' ? row.validated_at : null,
    last_error: typeof row.last_error === 'string' ? row.last_error : null,
  }
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
 * @description Safe last_error string — never embeds the plaintext api key.
 */
function safeLastError(
  message: string | undefined,
  plaintextKey: string,
): string {
  const fallback = 'Invalid API key'
  if (typeof message !== 'string' || message.trim().length === 0) {
    return fallback
  }
  if (message.includes(plaintextKey)) {
    return fallback
  }
  // Cap length; avoid dumping vendor bodies
  return message.slice(0, 200)
}

/**
 * @description Default production probe: OpenAI/Anthropic models list with 8s abort.
 * Never logs the api key. 401/403 → auth_rejected; timeout/network → incomplete; 2xx → ok.
 */
export async function defaultLlmProbe(args: {
  provider: 'openai' | 'anthropic'
  apiKey: string
}): Promise<
  | { ok: true }
  | { ok: false; kind: 'auth_rejected' | 'incomplete'; message?: string }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res =
      args.provider === 'openai'
        ? await fetch(OPENAI_PROBE_URL, {
            method: 'GET',
            headers: { Authorization: `Bearer ${args.apiKey}` },
            signal: controller.signal,
          })
        : await fetch(ANTHROPIC_PROBE_URL, {
            method: 'GET',
            headers: {
              'x-api-key': args.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            signal: controller.signal,
          })

    if (res.ok) {
      return { ok: true }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        kind: 'auth_rejected',
        message: 'Invalid API key',
      }
    }
    return {
      ok: false,
      kind: 'incomplete',
      message: 'Provider unavailable',
    }
  } catch {
    return {
      ok: false,
      kind: 'incomplete',
      message: 'Validation incomplete',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @description Register GET/PUT llm-settings, POST validate, and GET health on createEmpresaApp.
 * Tenant scope from session only. Admin for settings write/read; health any active member.
 */
export function registerLlmRoutes(
  app: Hono<{ Variables: ActiveEmpresaVariables }>,
  db: DbLike,
  deps: LlmSettingsDeps = {},
): void {
  const probe: LlmProbe = deps.llmProbe ?? defaultLlmProbe
  const secret = deps.llmKeyEncryptionSecret

  app.get(
    '/api/empresa/llm-settings',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const row = await loadSettingsRow(db, empresaId)
      return c.json(toMetadata(row), 200)
    },
  )

  app.put(
    '/api/empresa/llm-settings',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      let body: unknown
      try {
        const rawBody = await readLimitedBody(c.req.raw)
        if (rawBody === null) {
          return c.json({ error: 'Invalid request' }, 400)
        }
        body = JSON.parse(rawBody)
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const parsed = putBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')

      if ('model_id' in parsed.data) {
        const modelId = parsed.data.model_id
        const row = await loadSettingsRow(db, empresaId)
        const casProvider = row?.provider
        const casCiphertext = row?.api_key_ciphertext ?? null
        const casModelId = row?.model_id ?? null
        // Two distinct states, two distinct errors: "no provider saved yet" is not the same as
        // "this model does not match the saved provider", and conflating them tells an API caller
        // the wrong thing. Clearing is always compatible; only a concrete choice is checked.
        if (casProvider !== 'openai' && casProvider !== 'anthropic') {
          return c.json({ error: 'Not configured' }, 400)
        }
        if (modelId !== null && !isCuratedLlmModel(casProvider, modelId)) {
          return c.json({ error: 'Invalid model' }, 400)
        }

        // The predicate carries provider AND key identity. Provider alone is not enough: rotating
        // the key of the SAME provider deliberately resets model_id, and this PUT would otherwise
        // re-attach a model to the fresh credential the admin just reset. `IS` (not `=`) so the
        // not-yet-keyed case matches NULL correctly.
        //
        // ⚠️ WHAT THIS DOES **NOT** GUARANTEE — read before trusting it. Every expected value
        // (casProvider / casCiphertext / casModelId) is read by the SERVER from loadSettingsRow a
        // few lines up, not supplied by the client. So the predicate only guards the window
        // between that SELECT and this UPDATE, within one request. It does NOT prevent a lost
        // update across two sessions: if admin B saves a model and admin A then saves from a stale
        // screen, A's request re-reads B's value, the predicate matches, and A silently overwrites
        // B — both get 200. Real cross-session protection needs the expected value to come from the
        // CLIENT (an `expected_model_id` in the body), which is an API contract change and is
        // deliberately NOT made here. Tracked in #82. RETURNING keeps the read atomic with the write.
        // The stored value is normalized in SQL to match what loadSettingsRow returned — comparing
        // a trimmed value against a raw column would make a padded row permanently unsaveable.
        const updatedRow = (await Promise.resolve(
          db
            .prepare(
              `UPDATE empresa_llm_settings
               SET model_id = ?
               WHERE empresa_id = ? AND provider = ? AND api_key_ciphertext IS ?
                 AND (CASE WHEN TRIM(COALESCE(model_id, ''), ${SQL_TRIM_CHARS}) = ''
                           THEN NULL ELSE TRIM(model_id, ${SQL_TRIM_CHARS}) END) IS ?
               RETURNING empresa_id, provider, api_key_ciphertext, api_key_iv,
                         model_id, status, validated_at, last_error`,
            )
            .get(modelId, empresaId, casProvider, casCiphertext, casModelId),
        )) as Record<string, unknown> | null | undefined
        if (updatedRow) {
          return c.json(toMetadata(normalizeSettingsRow(updatedRow)), 200)
        }

        // A failed CAS means the row moved between this request's SELECT and its UPDATE. Do NOT
        // retry — re-binding would re-attach the model to whatever replaced it. But if the winning
        // row ALREADY holds what this request asked for, there is no conflict to report: the
        // outcome converged.
        const current = await loadSettingsRow(db, empresaId)
        if (
          current &&
          current.provider === casProvider &&
          current.api_key_ciphertext === casCiphertext &&
          (current.model_id ?? null) === modelId
        ) {
          return c.json(toMetadata(current), 200)
        }
        return c.json({ error: 'Settings changed' }, 409)
      }

      if (!hasUsableSecret(secret)) {
        return c.json({ error: 'Service unavailable' }, 503)
      }

      const { provider, api_key } = parsed.data

      let ciphertextHex: string
      let ivHex: string
      try {
        const encrypted = await encryptLlmApiKey(secret, api_key)
        ciphertextHex = encrypted.ciphertextHex
        ivHex = encrypted.ivHex
      } catch {
        // Fail closed — never store plaintext
        return c.json({ error: 'Service unavailable' }, 503)
      }

      await Promise.resolve(
        db
          .prepare(
             `INSERT INTO empresa_llm_settings
               (empresa_id, provider, model_id, api_key_ciphertext, api_key_iv, status, validated_at, last_error)
             VALUES (?, ?, NULL, ?, ?, 'unvalidated', NULL, NULL)
             ON CONFLICT(empresa_id) DO UPDATE SET
               provider = excluded.provider,
               model_id = NULL,
               api_key_ciphertext = excluded.api_key_ciphertext,
               api_key_iv = excluded.api_key_iv,
               status = 'unvalidated',
               validated_at = NULL,
               last_error = NULL`,
          )
          .run(empresaId, provider, ciphertextHex, ivHex),
      )

      const row = await loadSettingsRow(db, empresaId)
      return c.json(toMetadata(row), 200)
    },
  )

  app.post(
    '/api/empresa/llm-settings/validate',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      if (!hasUsableSecret(secret)) {
        return c.json({ error: 'Service unavailable' }, 503)
      }

      const empresaId = c.get('activeEmpresaId')
      const row = await loadSettingsRow(db, empresaId)

      if (
        !row ||
        !rowHasKey(row) ||
        !row.api_key_ciphertext ||
        !row.api_key_iv ||
        (row.provider !== 'openai' && row.provider !== 'anthropic')
      ) {
        // No key material for this tenant — do not leak other tenants
        return c.json({ error: 'Not configured' }, 400)
      }

      // Capture key material before probe so concurrent PUT cannot stamp probe outcome on a replaced key
      const probedCiphertext = row.api_key_ciphertext
      const probedIv = row.api_key_iv
      const probedProvider = row.provider

      let apiKey: string
      try {
        apiKey = await decryptLlmApiKey(
          secret,
          probedCiphertext,
          probedIv,
        )
      } catch {
        // Decrypt failed — CAS so concurrent PUT is not stamped invalid
        const runResult = await Promise.resolve(
          db
            .prepare(
              `UPDATE empresa_llm_settings
               SET status = 'invalid',
                   last_error = 'Key cannot be decrypted',
                   validated_at = NULL
               WHERE empresa_id = ?
                 AND api_key_ciphertext = ?
                 AND api_key_iv = ?`,
            )
            .run(empresaId, probedCiphertext, probedIv),
        )
        // Key replaced during decrypt — return current row, do not claim decrypt failure
        if (runChanges(runResult) === 0) {
          const current = await loadSettingsRow(db, empresaId)
          return c.json(toMetadata(current), 200)
        }
        return c.json({ error: 'Validation failed' }, 502)
      }

      let result: Awaited<ReturnType<LlmProbe>>
      try {
        result = await probe({
          provider: probedProvider,
          apiKey,
        })
      } catch {
        return c.json({ error: 'Validation failed' }, 502)
      }

      if (result.ok) {
        const runResult = await Promise.resolve(
          db
            .prepare(
              `UPDATE empresa_llm_settings
               SET status = 'valid',
                   validated_at = datetime('now'),
                   last_error = NULL
               WHERE empresa_id = ?
                 AND api_key_ciphertext = ?
                 AND api_key_iv = ?`,
            )
            .run(empresaId, probedCiphertext, probedIv),
        )
        // Key replaced during probe — return current row, do not claim probe outcome
        if (runChanges(runResult) === 0) {
          const current = await loadSettingsRow(db, empresaId)
          return c.json(toMetadata(current), 200)
        }
        const updated = await loadSettingsRow(db, empresaId)
        return c.json(toMetadata(updated), 200)
      }

      if (result.kind === 'incomplete') {
        return c.json({ error: 'Validation failed' }, 502)
      }

      // auth_rejected → 200 Metadata invalid
      const lastError = safeLastError(result.message, apiKey)
      const runResult = await Promise.resolve(
        db
          .prepare(
            `UPDATE empresa_llm_settings
             SET status = 'invalid',
                 last_error = ?
             WHERE empresa_id = ?
               AND api_key_ciphertext = ?
               AND api_key_iv = ?`,
          )
          .run(lastError, empresaId, probedCiphertext, probedIv),
      )
      // Key replaced during probe — return current row, do not claim probe outcome
      if (runChanges(runResult) === 0) {
        const current = await loadSettingsRow(db, empresaId)
        return c.json(toMetadata(current), 200)
      }
      const updated = await loadSettingsRow(db, empresaId)
      return c.json(toMetadata(updated), 200)
    },
  )

  app.get(
    '/api/empresa/llm-settings/health',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const row = await loadSettingsRow(db, empresaId)
      const meta = toMetadata(row)
      return c.json(toHealth(meta), 200)
    },
  )
}
