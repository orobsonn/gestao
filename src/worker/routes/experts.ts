/** @description Experts tenant CRUD routes — admin writes, member+ reads, soft-delete with children guard. */

import type { Hono } from 'hono'
import { z } from 'zod'
import type { ActiveEmpresaVariables } from '../middleware/require-active-empresa.ts'
import { requireActiveEmpresa } from '../middleware/require-active-empresa.ts'
import { requireEmpresaAdmin } from '../middleware/require-empresa-admin.ts'
import { requireSession } from '../middleware/require-session.ts'
import type { DbLike } from '../types.ts'

const createExpertBodySchema = z.object({
  nome: z.string().min(1).max(200),
})

/** @description PATCH allowlist: nome only — reject unknown keys via strict. */
const patchExpertBodySchema = z
  .object({
    nome: z.string().min(1).max(200).optional(),
  })
  .strict()

/** @description Live expert row returned by list (with open/late task counts). */
export type ExpertListRow = {
  id: string
  nome: string
  abertas: number
  atrasadas: number
}

/** @description Live expert row returned by get/create/patch (id + nome only). */
export type ExpertRow = {
  id: string
  nome: string
}

/**
 * @description Coerce a SQL count cell to a non-negative number.
 */
function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/**
 * @description List live experts of a single empresa with open/late task counts.
 * Counts match home open-task predicates (LD-13): live = t.deleted_at IS NULL only;
 * abertas = status != feito; atrasadas = open set plus prazo IS NOT NULL AND prazo < date('now').
 * Join tarefas→campanhas→experts; do not filter campanhas.status.
 */
async function listExperts(
  db: DbLike,
  empresaId: string,
): Promise<ExpertListRow[]> {
  const stmt = db.prepare(
    `SELECT
       e.id AS id,
       e.nome AS nome,
       COUNT(
         CASE
           WHEN t.id IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.status != 'feito'
           THEN 1
         END
       ) AS abertas,
       COUNT(
         CASE
           WHEN t.id IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.status != 'feito'
            AND t.prazo IS NOT NULL
            AND t.prazo < date('now')
           THEN 1
         END
       ) AS atrasadas
     FROM experts e
     LEFT JOIN campanhas c
       ON c.expert_id = e.id AND c.empresa_id = e.empresa_id
     LEFT JOIN tarefas t
       ON t.campanha_id = c.id AND t.empresa_id = e.empresa_id
     WHERE e.empresa_id = ? AND e.deleted_at IS NULL
     GROUP BY e.id, e.nome
     ORDER BY e.nome ASC`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(empresaId))

  const result: ExpertListRow[] = []
  for (const row of rows) {
    if (typeof row.id === 'string' && typeof row.nome === 'string') {
      result.push({
        id: row.id,
        nome: row.nome,
        abertas: asCount(row.abertas),
        atrasadas: asCount(row.atrasadas),
      })
    }
  }
  return result
}

/**
 * @description Fetch a live expert by id scoped to empresa (deleted_at IS NULL).
 */
async function getLiveExpert(
  db: DbLike,
  id: string,
  empresaId: string,
): Promise<ExpertRow | null> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT id, nome FROM experts
         WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(id, empresaId),
  )

  if (!row || typeof row.id !== 'string' || typeof row.nome !== 'string') {
    return null
  }
  return { id: row.id, nome: row.nome }
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
 * @description Register experts CRUD on the empresa Hono app.
 * Tenant scope from session active_empresa_id only. Admin writes; member+ reads.
 */
export function registerExpertRoutes(
  app: Hono<{ Variables: ActiveEmpresaVariables }>,
  db: DbLike,
): void {
  app.get(
    '/api/empresa/experts',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const experts = await listExperts(db, empresaId)
      return c.json({ experts }, 200)
    },
  )

  app.post(
    '/api/empresa/experts',
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

      const parsed = createExpertBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')
      const id = crypto.randomUUID()
      const { nome } = parsed.data

      await Promise.resolve(
        db
          .prepare(
            `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
          )
          .run(id, empresaId, nome),
      )

      return c.json({ id, nome }, 201)
    },
  )

  app.get(
    '/api/empresa/experts/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')
      const expert = await getLiveExpert(db, id, empresaId)
      if (!expert) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(expert, 200)
    },
  )

  app.patch(
    '/api/empresa/experts/:id',
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

      const parsed = patchExpertBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')

      const existing = await getLiveExpert(db, id, empresaId)
      if (!existing) {
        return c.json({ error: 'Not found' }, 404)
      }

      if (parsed.data.nome !== undefined) {
        await Promise.resolve(
          db
            .prepare(
              `UPDATE experts SET nome = ?
               WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
            )
            .run(parsed.data.nome, id, empresaId),
        )
      }

      // Re-read after write — do not return in-memory nome if UPDATE missed (race/tombstone)
      const updated = await getLiveExpert(db, id, empresaId)
      if (!updated) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(updated, 200)
    },
  )

  app.delete(
    '/api/empresa/experts/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')

      // Atomic soft-delete: only when live and no live campanha children (no check-then-act race)
      const runResult = await Promise.resolve(
        db
          .prepare(
            `UPDATE experts SET deleted_at = datetime('now')
             WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM campanhas c
               WHERE c.expert_id = experts.id
                 AND c.empresa_id = experts.empresa_id
                 AND c.deleted_at IS NULL
             )`,
          )
          .run(id, empresaId),
      )

      const changes = runChanges(runResult)
      if (changes != null && changes > 0) {
        return c.body(null, 204)
      }

      // changes=0 (or unknown): distinguish never-existed / tombstone / has children
      const row = await Promise.resolve(
        db
          .prepare(
            `SELECT id, deleted_at FROM experts
             WHERE id = ? AND empresa_id = ?`,
          )
          .get(id, empresaId),
      )

      if (!row || typeof row.id !== 'string') {
        return c.json({ error: 'Not found' }, 404)
      }
      if (row.deleted_at != null) {
        return c.body(null, 204)
      }
      // Live row but UPDATE did not apply → blocked by live children
      return c.json({ error: 'Has children' }, 409)
    },
  )
}
