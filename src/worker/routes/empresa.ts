/** @description Empresa tenant routes — list/create membros scoped to session active empresa. */

import { Hono } from 'hono'
import { z } from 'zod'
import {
  requireActiveEmpresa,
  type ActiveEmpresaVariables,
} from '../middleware/require-active-empresa.ts'
import { requireEmpresaAdmin } from '../middleware/require-empresa-admin.ts'
import { requireSession } from '../middleware/require-session.ts'
import { ensureBatchDb } from '../services/create-empresa.ts'
import {
  AlreadyMemberError,
  createMembroAsAdmin,
} from '../services/create-membro.ts'
import type { DbLike } from '../types.ts'
import { registerCampanhaRoutes } from './campanhas.ts'
import { registerExpertRoutes } from './experts.ts'
import { registerHomeRoutes } from './home.ts'
import { registerTarefaRoutes } from './tarefas.ts'

const createMembroBodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
  password: z.string().min(8).max(1024),
  papel: z.enum(['admin', 'membro']),
})

/** @description Member row returned by GET /api/empresa/membros. */
export type MembroListRow = {
  user_id: string
  name: string
  email: string
  papel: string
}

/**
 * @description List members of a single empresa (tenant-scoped).
 */
async function listMembros(
  db: DbLike,
  empresaId: string,
): Promise<MembroListRow[]> {
  const stmt = db.prepare(
    `SELECT em.user_id AS user_id, u.name AS name, u.email AS email, em.papel AS papel
     FROM empresa_membros em
     INNER JOIN users u ON u.id = em.user_id
     WHERE em.empresa_id = ?`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(empresaId))

  const result: MembroListRow[] = []
  for (const row of rows) {
    if (
      typeof row.user_id === 'string' &&
      typeof row.name === 'string' &&
      typeof row.email === 'string' &&
      typeof row.papel === 'string'
    ) {
      result.push({
        user_id: row.user_id,
        name: row.name,
        email: row.email,
        papel: row.papel,
      })
    }
  }
  return result
}

/**
 * @description Build a Hono app with GET/POST /api/empresa/membros.
 * Tenant scope comes only from session active_empresa_id (never client body).
 * Closes over `db` for hermetic tests (node:sqlite) and worker mounting.
 */
export function createEmpresaApp(
  db: DbLike,
): Hono<{ Variables: ActiveEmpresaVariables }> {
  const app = new Hono<{ Variables: ActiveEmpresaVariables }>()
  const batchDb = ensureBatchDb(db)

  app.get(
    '/api/empresa/membros',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const membros = await listMembros(db, empresaId)
      return c.json({ membros }, 200)
    },
  )

  app.post(
    '/api/empresa/membros',
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

      const parsed = createMembroBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const empresaId = c.get('activeEmpresaId')

      try {
        const result = await createMembroAsAdmin(batchDb, {
          empresaId,
          name: parsed.data.name,
          email: parsed.data.email,
          password: parsed.data.password,
          papel: parsed.data.papel,
        })
        return c.json(
          {
            user: result.user,
            papel: result.papel,
            created: result.created,
          },
          201,
        )
      } catch (err) {
        if (err instanceof AlreadyMemberError) {
          return c.json({ error: 'Email already member' }, 409)
        }
        throw err
      }
    },
  )

  registerExpertRoutes(app, db)
  registerCampanhaRoutes(app, db)
  registerTarefaRoutes(app, db)
  registerHomeRoutes(app, db)

  return app
}
