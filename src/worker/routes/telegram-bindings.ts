/** @description Empresa Telegram bindings admin routes — status (booleans+timestamps only) + mint empresa/expert commands (32-byte hex, SHA-256 at rest, 15min TTL, invalidate prior unused). Behind requireEmpresaAdmin. */

import type { Hono } from 'hono'
import type { ActiveEmpresaVariables } from '../middleware/require-active-empresa.ts'
import { requireActiveEmpresa } from '../middleware/require-active-empresa.ts'
import { requireEmpresaAdmin } from '../middleware/require-empresa-admin.ts'
import { requireSession } from '../middleware/require-session.ts'
import { ensureBatchDb } from '../services/create-empresa.ts'
import type { BatchDbLike } from '../services/create-empresa.ts'
import type { DbLike } from '../types.ts'

const TELEGRAM_BIND_CODE_BYTES = 32
const TELEGRAM_BIND_TTL_SQL = "datetime('now', '+15 minutes')"

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
}

/**
 * @description Detect SQLite/D1 unique-constraint failures (concurrent mint race).
 */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}

type EmpresaBindStatus = {
  linked: boolean
  linked_at?: string
}

type ExpertBindStatus = {
  expert_id: string
  nome: string
  linked: boolean
  linked_at?: string
}

type BindingsStatusResponse = {
  empresa: EmpresaBindStatus
  experts: ExpertBindStatus[]
}

async function loadEmpresaBindStatus(
  db: DbLike,
  empresaId: string,
): Promise<EmpresaBindStatus> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT linked_at FROM empresa_telegram_chats WHERE empresa_id = ?`,
      )
      .get(empresaId),
  )
  if (row && typeof row.linked_at === 'string') {
    return { linked: true, linked_at: row.linked_at }
  }
  return { linked: false }
}

async function loadExpertsBindStatus(
  db: DbLike,
  empresaId: string,
): Promise<ExpertBindStatus[]> {
  const stmt = db.prepare(
    `SELECT e.id AS expert_id, e.nome AS nome,
            CASE WHEN et.expert_id IS NOT NULL THEN 1 ELSE 0 END AS linked,
            et.linked_at AS linked_at
     FROM experts e
     LEFT JOIN expert_telegram_topics et ON et.expert_id = e.id
     WHERE e.empresa_id = ? AND e.deleted_at IS NULL
     ORDER BY e.nome`,
  )
  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(empresaId))
  const result: ExpertBindStatus[] = []
  for (const row of rows) {
    if (
      typeof row.expert_id === 'string' &&
      typeof row.nome === 'string'
    ) {
      const linked = row.linked === 1 || row.linked === true
      const linked_at =
        typeof row.linked_at === 'string' && row.linked_at.length > 0
          ? row.linked_at
          : undefined
      result.push({
        expert_id: row.expert_id,
        nome: row.nome,
        linked,
        linked_at,
      })
    }
  }
  return result
}

async function mintBindCode(
  // Not DbLike: this function calls `.batch()` and `.prepare().bind()`, neither of which exists on
  // DbLike. The old annotation was simply wrong and every call site had to be force-fed.
  batchDb: BatchDbLike,
  db: DbLike,
  params: {
    empresaId: string
    expertId: string | null
    kind: 'empresa' | 'expert'
  },
): Promise<{ command: string; expires_at: string }> {
  const { empresaId, expertId, kind } = params
  let id = ''
  let rawCode = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    id = crypto.randomUUID()
    const codeBytes = crypto.getRandomValues(
      new Uint8Array(TELEGRAM_BIND_CODE_BYTES),
    )
    rawCode = bytesToHex(codeBytes)
    const codeHash = await sha256Hex(rawCode)

    const invalidateSql =
      kind === 'empresa'
        ? `UPDATE telegram_bind_codes SET used_at = datetime('now') WHERE empresa_id = ? AND kind = 'empresa' AND used_at IS NULL`
        : `UPDATE telegram_bind_codes SET used_at = datetime('now') WHERE expert_id = ? AND kind = 'expert' AND used_at IS NULL`

    const invalidateParam = kind === 'empresa' ? empresaId : expertId

    try {
      await Promise.resolve(
        batchDb.batch([
          batchDb
            .prepare(invalidateSql)
            .bind(invalidateParam),
          batchDb
            .prepare(
              `INSERT INTO telegram_bind_codes (id, empresa_id, kind, expert_id, code_hash, expires_at, used_at, created_at)
               VALUES (?, ?, ?, ?, ?, ${TELEGRAM_BIND_TTL_SQL}, NULL, datetime('now'))`,
            )
            .bind(id, empresaId, kind, expertId, codeHash),
        ]),
      )
      break
      } catch (err) {
      if (attempt === 0 && isUniqueConstraintError(err)) continue
      throw err
    }
  }

  const row = await Promise.resolve(
    db
      .prepare(`SELECT expires_at FROM telegram_bind_codes WHERE id = ?`)
      .get(id),
  )
  const expiresAt =
    row && typeof row.expires_at === 'string' ? row.expires_at : ''

  const prefix = kind === 'empresa' ? '/vincular_empresa' : '/vincular_expert'
  return {
    command: `${prefix} ${rawCode}`,
    expires_at: expiresAt,
  }
}

async function isLiveSameTenantExpert(
  db: DbLike,
  empresaId: string,
  expertId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT id FROM experts WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(expertId, empresaId),
  )
  return !!row && typeof row.id === 'string'
}

/**
 * @description Register GET /api/empresa/telegram-bindings (status) and POST mint commands.
 * All routes require session + active empresa + admin papel.
 * Status DTO exposes only booleans + timestamps (never chat_id/thread/raw codes).
 * Mint invalidates prior unused same-scope code; stores SHA-256 only; 15min TTL.
 */
export function registerTelegramBindingsRoutes(
  app: Hono<{ Variables: ActiveEmpresaVariables }>,
  db: DbLike,
): void {
  const batchDb = ensureBatchDb(db)

  app.get(
    '/api/empresa/telegram-bindings',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const empresa = await loadEmpresaBindStatus(db, empresaId)
      const experts = await loadExpertsBindStatus(db, empresaId)
      const body: BindingsStatusResponse = { empresa, experts }
      return c.json(body, 200)
    },
  )

  app.post(
    '/api/empresa/telegram-bindings/empresa-command',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const result = await mintBindCode(batchDb, db, {
        empresaId,
        expertId: null,
        kind: 'empresa',
      })
      return c.json(result, 200)
    },
  )

  app.post(
    '/api/empresa/telegram-bindings/expert-command',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }
      if (
        !body ||
        typeof body !== 'object' ||
        !('expert_id' in body) ||
        typeof (body as any).expert_id !== 'string'
      ) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      const expertId = (body as { expert_id: string }).expert_id
      const empresaId = c.get('activeEmpresaId')

      const ok = await isLiveSameTenantExpert(db, empresaId, expertId)
      if (!ok) {
        return c.json({ error: 'Not found' }, 404)
      }

      const result = await mintBindCode(batchDb, db, {
        empresaId,
        expertId,
        kind: 'expert',
      })
      return c.json(result, 200)
    },
  )
}
