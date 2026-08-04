/** @description Tarefas tenant CRUD routes — any member writes, parent campanha scope, soft-delete. */

import type { Hono } from 'hono'
import { z } from 'zod'
import { TAREFA_STATUS } from '../../shared/domain/enums.ts'
import type { ActiveEmpresaVariables } from '../middleware/require-active-empresa.ts'
import { requireActiveEmpresa } from '../middleware/require-active-empresa.ts'
import { requireSession } from '../middleware/require-session.ts'
import type { DbLike } from '../types.ts'

/** @description Optional calendar date YYYY-MM-DD. */
const dateYmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const createTarefaBodySchema = z.object({
  campanha_id: z.string().min(1),
  titulo: z.string().min(1).max(200),
  notas: z.string().max(10000).optional(),
  status: z.enum(TAREFA_STATUS).optional(),
  prazo: dateYmdSchema.optional(),
  dono_id: z.string().min(1).optional(),
})

/** PATCH allowlist — unknown keys rejected via strict. null clears prazo/dono_id. */
const patchTarefaBodySchema = z
  .object({
    titulo: z.string().min(1).max(200).optional(),
    notas: z.string().max(10000).optional(),
    status: z.enum(TAREFA_STATUS).optional(),
    prazo: dateYmdSchema.nullable().optional(),
    dono_id: z.string().min(1).nullable().optional(),
  })
  .strict()

/** @description Live tarefa row returned by list/get/create/patch. */
export type TarefaRow = {
  id: string
  campanha_id: string
  titulo: string
  notas: string
  status: string
  prazo: string | null
  dono_id: string | null
  created_by: string
}

/**
 * @description Map a DB row to TarefaRow, or null if shape is invalid.
 */
function mapTarefaRow(row: Record<string, unknown> | null | undefined): TarefaRow | null {
  if (!row) return null
  if (
    typeof row.id !== 'string' ||
    typeof row.campanha_id !== 'string' ||
    typeof row.titulo !== 'string' ||
    typeof row.notas !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_by !== 'string'
  ) {
    return null
  }
  if (row.prazo != null && typeof row.prazo !== 'string') {
    return null
  }
  if (row.dono_id != null && typeof row.dono_id !== 'string') {
    return null
  }
  return {
    id: row.id,
    campanha_id: row.campanha_id,
    titulo: row.titulo,
    notas: row.notas,
    status: row.status,
    prazo: row.prazo ?? null,
    dono_id: row.dono_id ?? null,
    created_by: row.created_by,
  }
}

const TAREFA_SELECT = `id, campanha_id, titulo, notas, status, prazo, dono_id, created_by`

/**
 * @description Whether a live campanha exists for the active empresa (deleted_at IS NULL).
 */
async function liveCampanhaExists(
  db: DbLike,
  campanhaId: string,
  empresaId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT id FROM campanhas
         WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(campanhaId, empresaId),
  )
  return !!row && typeof row.id === 'string'
}

/**
 * @description Whether userId has membership on empresaId.
 */
async function isEmpresaMember(
  db: DbLike,
  userId: string,
  empresaId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT user_id FROM empresa_membros
         WHERE user_id = ? AND empresa_id = ?`,
      )
      .get(userId, empresaId),
  )
  return !!row && typeof row.user_id === 'string'
}

/**
 * @description List live tarefas under a campanha (tenant-scoped, deleted_at IS NULL).
 */
async function listTarefasByCampanha(
  db: DbLike,
  campanhaId: string,
  empresaId: string,
): Promise<TarefaRow[]> {
  const stmt = db.prepare(
    `SELECT ${TAREFA_SELECT} FROM tarefas
     WHERE campanha_id = ? AND empresa_id = ? AND deleted_at IS NULL
     ORDER BY titulo ASC`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(campanhaId, empresaId))

  const result: TarefaRow[] = []
  for (const row of rows) {
    const mapped = mapTarefaRow(row)
    if (mapped) result.push(mapped)
  }
  return result
}

/**
 * @description Fetch a live tarefa by id scoped to empresa (deleted_at IS NULL).
 */
async function getLiveTarefa(
  db: DbLike,
  id: string,
  empresaId: string,
): Promise<TarefaRow | null> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT ${TAREFA_SELECT} FROM tarefas
         WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(id, empresaId),
  )
  return mapTarefaRow(row)
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
 * @description Register tarefas CRUD on the empresa Hono app.
 * Tenant scope from session active_empresa_id only. Any member (no admin gate).
 */
export function registerTarefaRoutes(
  app: Hono<{ Variables: ActiveEmpresaVariables }>,
  db: DbLike,
): void {
  app.get(
    '/api/empresa/campanhas/:campanhaId/tarefas',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const campanhaId = c.req.param('campanhaId')

      const parentOk = await liveCampanhaExists(db, campanhaId, empresaId)
      if (!parentOk) {
        return c.json({ error: 'Not found' }, 404)
      }

      const tarefas = await listTarefasByCampanha(db, campanhaId, empresaId)
      return c.json({ tarefas }, 200)
    },
  )

  app.post(
    '/api/empresa/tarefas',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const parsed = createTarefaBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')
      const user = c.get('user')
      const {
        campanha_id: campanhaId,
        titulo,
        notas = '',
        status = 'a_fazer',
        prazo = null,
        dono_id: donoId = null,
      } = parsed.data

      if (donoId != null) {
        const memberOk = await isEmpresaMember(db, donoId, empresaId)
        if (!memberOk) {
          return c.json({ error: 'Invalid request' }, 400)
        }
      }

      const id = crypto.randomUUID()

      // Atomic parent guard: INSERT only if live campanha same-tenant (no check-then-act race)
      // created_by always from session — never client body
      const runResult = await Promise.resolve(
        db
          .prepare(
            `INSERT INTO tarefas
               (id, empresa_id, campanha_id, titulo, notas, status, prazo, dono_id, created_by)
             SELECT ?, empresa_id, id, ?, ?, ?, ?, ?, ?
             FROM campanhas
             WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
          )
          .run(
            id,
            titulo,
            notas,
            status,
            prazo,
            donoId,
            user.id,
            campanhaId,
            empresaId,
          ),
      )

      const changes = runChanges(runResult)
      if (changes == null || changes === 0) {
        return c.json({ error: 'Not found' }, 404)
      }

      const created = await getLiveTarefa(db, id, empresaId)
      if (!created) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(created, 201)
    },
  )

  app.get(
    '/api/empresa/tarefas/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')
      const tarefa = await getLiveTarefa(db, id, empresaId)
      if (!tarefa) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(tarefa, 200)
    },
  )

  app.patch(
    '/api/empresa/tarefas/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const parsed = patchTarefaBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')

      const existing = await getLiveTarefa(db, id, empresaId)
      if (!existing) {
        return c.json({ error: 'Not found' }, 404)
      }

      if (parsed.data.dono_id !== undefined && parsed.data.dono_id !== null) {
        const memberOk = await isEmpresaMember(db, parsed.data.dono_id, empresaId)
        if (!memberOk) {
          return c.json({ error: 'Invalid request' }, 400)
        }
      }

      const sets: string[] = []
      const values: (string | null)[] = []

      if (parsed.data.titulo !== undefined) {
        sets.push('titulo = ?')
        values.push(parsed.data.titulo)
      }
      if (parsed.data.notas !== undefined) {
        sets.push('notas = ?')
        values.push(parsed.data.notas)
      }
      if (parsed.data.status !== undefined) {
        sets.push('status = ?')
        values.push(parsed.data.status)
      }
      if (parsed.data.prazo !== undefined) {
        sets.push('prazo = ?')
        values.push(parsed.data.prazo)
      }
      if (parsed.data.dono_id !== undefined) {
        sets.push('dono_id = ?')
        values.push(parsed.data.dono_id)
      }

      // updated_at only when status actually changes — keeps feitas_7d as completion window, not activity
      if (
        parsed.data.status !== undefined &&
        parsed.data.status !== existing.status
      ) {
        sets.push(`updated_at = datetime('now')`)
      }

      if (sets.length > 0) {
        await Promise.resolve(
          db
            .prepare(
              `UPDATE tarefas SET ${sets.join(', ')}
               WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
            )
            .run(...values, id, empresaId),
        )
      }

      // Re-read after write — do not return in-memory fields if UPDATE missed (race/tombstone)
      const updated = await getLiveTarefa(db, id, empresaId)
      if (!updated) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json(updated, 200)
    },
  )

  app.delete(
    '/api/empresa/tarefas/:id',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const id = c.req.param('id')

      // Soft-delete live row (no children on tarefas)
      const runResult = await Promise.resolve(
        db
          .prepare(
            `UPDATE tarefas SET deleted_at = datetime('now')
             WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
          )
          .run(id, empresaId),
      )

      const changes = runChanges(runResult)
      if (changes != null && changes > 0) {
        return c.body(null, 204)
      }

      // changes=0 (or unknown): distinguish never-existed / other-tenant vs own tombstone
      const row = await Promise.resolve(
        db
          .prepare(
            `SELECT id, deleted_at FROM tarefas
             WHERE id = ? AND empresa_id = ?`,
          )
          .get(id, empresaId),
      )

      if (!row || typeof row.id !== 'string') {
        return c.json({ error: 'Not found' }, 404)
      }
      // Own tombstone → idempotent 204 (LD-16 DELETE/GET split)
      return c.body(null, 204)
    },
  )
}
