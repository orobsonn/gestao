/** @description Campanhas tenant CRUD routes — admin writes, parent expert scope, soft-delete with children guard. */

import type { Hono } from 'hono'
import { z } from 'zod'
import {
  CAMPANHA_STATUS,
  CAMPANHA_TIPOS,
} from '../../shared/domain/enums.ts'
import type { ActiveEmpresaVariables } from '../middleware/require-active-empresa.ts'
import { requireActiveEmpresa } from '../middleware/require-active-empresa.ts'
import { requireEmpresaAdmin } from '../middleware/require-empresa-admin.ts'
import { requireSession } from '../middleware/require-session.ts'
import type { DbLike } from '../types.ts'

/** @description Optional calendar date YYYY-MM-DD. */
const dateYmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const createCampanhaBodySchema = z.object({
  expert_id: z.string().min(1),
  nome: z.string().min(1).max(200),
  tipo: z.enum(CAMPANHA_TIPOS),
  status: z.enum(CAMPANHA_STATUS).optional(),
  data_inicio: dateYmdSchema.optional(),
  data_fim: dateYmdSchema.optional(),
  notas: z.string().max(10000).optional(),
})

/** PATCH allowlist — expert_id and unknown keys rejected via strict. null clears dates. */
const patchCampanhaBodySchema = z
  .object({
    nome: z.string().min(1).max(200).optional(),
    tipo: z.enum(CAMPANHA_TIPOS).optional(),
    status: z.enum(CAMPANHA_STATUS).optional(),
    data_inicio: dateYmdSchema.nullable().optional(),
    data_fim: dateYmdSchema.nullable().optional(),
    notas: z.string().max(10000).optional(),
  })
  .strict()

/** @description Live campanha row returned by list/get/create/patch. */
export type CampanhaRow = {
  id: string
  expert_id: string
  nome: string
  tipo: string
  status: string
  data_inicio: string | null
  data_fim: string | null
  notas: string
}

/**
 * @description Map a DB row to CampanhaRow, or null if shape is invalid.
 */
function mapCampanhaRow(row: Record<string, unknown> | null | undefined): CampanhaRow | null {
  if (!row) return null
  if (
    typeof row.id !== 'string' ||
    typeof row.expert_id !== 'string' ||
    typeof row.nome !== 'string' ||
    typeof row.tipo !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.notas !== 'string'
  ) {
    return null
  }
  if (row.data_inicio != null && typeof row.data_inicio !== 'string') {
    return null
  }
  if (row.data_fim != null && typeof row.data_fim !== 'string') {
    return null
  }
  return {
    id: row.id,
    expert_id: row.expert_id,
    nome: row.nome,
    tipo: row.tipo,
    status: row.status,
    data_inicio: row.data_inicio ?? null,
    data_fim: row.data_fim ?? null,
    notas: row.notas,
  }
}

const CAMPANHA_SELECT = `id, expert_id, nome, tipo, status, data_inicio, data_fim, notas`

/**
 * @description Whether a live expert exists for the active empresa (deleted_at IS NULL).
 */
async function liveExpertExists(
  db: DbLike,
  expertId: string,
  empresaId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT id FROM experts
         WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(expertId, empresaId),
  )
  return !!row && typeof row.id === 'string'
}

/**
 * @description List live campanhas under an expert (tenant-scoped, deleted_at IS NULL).
 */
async function listCampanhasByExpert(
  db: DbLike,
  expertId: string,
  empresaId: string,
): Promise<CampanhaRow[]> {
  const stmt = db.prepare(
    `SELECT ${CAMPANHA_SELECT} FROM campanhas
     WHERE expert_id = ? AND empresa_id = ? AND deleted_at IS NULL
     ORDER BY nome ASC`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(expertId, empresaId))

  const result: CampanhaRow[] = []
  for (const row of rows) {
    const mapped = mapCampanhaRow(row)
    if (mapped) result.push(mapped)
  }
  return result
}

/**
 * @description Fetch a live campanha by id scoped to empresa (deleted_at IS NULL).
 */
async function getLiveCampanha(
  db: DbLike,
  id: string,
  empresaId: string,
): Promise<CampanhaRow | null> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT ${CAMPANHA_SELECT} FROM campanhas
         WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(id, empresaId),
  )
  return mapCampanhaRow(row)
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
 * @description Register campanhas CRUD on the empresa Hono app.
 * Tenant scope from session active_empresa_id only. Admin writes; member+ reads.
 */
export function registerCampanhaRoutes(
  app: Hono<{ Variables: ActiveEmpresaVariables }>,
  db: DbLike,
): void {
  app.get(
    '/api/empresa/experts/:expertId/campanhas',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const expertId = c.req.param('expertId')

      const parentOk = await liveExpertExists(db, expertId, empresaId)
      if (!parentOk) {
        return c.json({ error: 'Not found' }, 404)
      }

      const campanhas = await listCampanhasByExpert(db, expertId, empresaId)
      return c.json({ campanhas }, 200)
    },
  )

  app.post(
    '/api/empresa/campanhas',
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

      const parsed = createCampanhaBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')
      const {
        expert_id: expertId,
        nome,
        tipo,
        status = 'aberta',
        data_inicio: dataInicio = null,
        data_fim: dataFim = null,
        notas = '',
      } = parsed.data

      const id = crypto.randomUUID()

      // Atomic parent guard: INSERT only if live expert same-tenant (no check-then-act race)
      const runResult = await Promise.resolve(
        db
          .prepare(
            `INSERT INTO campanhas
               (id, empresa_id, expert_id, nome, tipo, status, data_inicio, data_fim, notas)
             SELECT ?, empresa_id, id, ?, ?, ?, ?, ?, ?
             FROM experts
             WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
          )
          .run(
            id,
            nome,
            tipo,
            status,
            dataInicio,
            dataFim,
            notas,
            expertId,
            empresaId,
          ),
      )

      const changes = runChanges(runResult)
      if (changes == null || changes === 0) {
        return c.json({ error: 'Not found' }, 404)
      }

      const created = await getLiveCampanha(db, id, empresaId)
      if (!created) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(created, 201)
    },
  )

  app.get(
    '/api/empresa/campanhas/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')
      const campanha = await getLiveCampanha(db, id, empresaId)
      if (!campanha) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(campanha, 200)
    },
  )

  app.patch(
    '/api/empresa/campanhas/:id',
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

      const parsed = patchCampanhaBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')

      const existing = await getLiveCampanha(db, id, empresaId)
      if (!existing) {
        return c.json({ error: 'Not found' }, 404)
      }

      const sets: string[] = []
      const values: (string | null)[] = []

      if (parsed.data.nome !== undefined) {
        sets.push('nome = ?')
        values.push(parsed.data.nome)
      }
      if (parsed.data.tipo !== undefined) {
        sets.push('tipo = ?')
        values.push(parsed.data.tipo)
      }
      if (parsed.data.status !== undefined) {
        sets.push('status = ?')
        values.push(parsed.data.status)
      }
      if (parsed.data.data_inicio !== undefined) {
        sets.push('data_inicio = ?')
        values.push(parsed.data.data_inicio)
      }
      if (parsed.data.data_fim !== undefined) {
        sets.push('data_fim = ?')
        values.push(parsed.data.data_fim)
      }
      if (parsed.data.notas !== undefined) {
        sets.push('notas = ?')
        values.push(parsed.data.notas)
      }

      if (sets.length > 0) {
        await Promise.resolve(
          db
            .prepare(
              `UPDATE campanhas SET ${sets.join(', ')}
               WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
            )
            .run(...values, id, empresaId),
        )
      }

      // Re-read after write — do not return in-memory fields if UPDATE missed (race/tombstone)
      const updated = await getLiveCampanha(db, id, empresaId)
      if (!updated) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(updated, 200)
    },
  )

  app.delete(
    '/api/empresa/campanhas/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    requireEmpresaAdmin(),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')

      // Atomic soft-delete: only when live and no live tarefa children (no check-then-act race)
      const runResult = await Promise.resolve(
        db
          .prepare(
            `UPDATE campanhas SET deleted_at = datetime('now')
             WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM tarefas t
               WHERE t.campanha_id = campanhas.id
                 AND t.empresa_id = campanhas.empresa_id
                 AND t.deleted_at IS NULL
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
            `SELECT id, deleted_at FROM campanhas
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
