/** @description Platform HTTP routes — super_admin create empresa (hermetic via createPlatformApp). */

import { Hono } from 'hono'
import { z } from 'zod'
import {
  requireSession,
  type SessionVariables,
} from '../middleware/require-session.ts'
import { requireSuperAdmin } from '../middleware/require-super-admin.ts'
import {
  createEmpresaAsSuperAdmin,
  DuplicateEmailError,
  ensureBatchDb,
} from '../services/create-empresa.ts'
import type { DbLike } from '../types.ts'

const createEmpresaBodySchema = z.object({
  nome: z.string().min(1).max(200),
  admin: z.object({
    name: z.string().min(1).max(200),
    email: z.email(),
    password: z.string().min(8).max(1024),
  }),
})

/**
 * @description Build a Hono app with POST /api/platform/empresas (super_admin only).
 * Closes over `db` for hermetic tests (node:sqlite) and worker mounting.
 */
export function createPlatformApp(
  db: DbLike,
): Hono<{ Variables: SessionVariables }> {
  const app = new Hono<{ Variables: SessionVariables }>()
  const batchDb = ensureBatchDb(db)

  app.post(
    '/api/platform/empresas',
    requireSession(db),
    requireSuperAdmin(),
    async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const parsed = createEmpresaBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      try {
        const result = await createEmpresaAsSuperAdmin(batchDb, parsed.data)
        return c.json(
          {
            empresa: result.empresa,
            admin: result.admin,
          },
          201,
        )
      } catch (err) {
        if (err instanceof DuplicateEmailError) {
          return c.json({ error: 'Email already registered' }, 409)
        }
        throw err
      }
    },
  )

  return app
}
