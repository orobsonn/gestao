/** @description Gestao bot tools factory — tenant-closed Flue tools for topic/DM surfaces. */

import { enableForeignKeysAsync } from '../db.ts'
import { TAREFA_STATUS } from '../../shared/domain/enums.ts'
import type { DbLike } from '../types.ts'
import { defineTool } from '@flue/runtime'
import * as v from 'valibot'

export interface GestaoBotToolsClosure {
  empresa_id: string
  expert_id: string | null
  actor_user_id: string
  surface: 'topic' | 'dm'
  db: DbLike
  sendNotify: (telegramUserId: string, text: string) => Promise<void> | void
}

export type ToolDefinition = ReturnType<typeof defineTool>

function isLiveCampanhaRow(row: unknown): row is { id: string } {
  return (
    row != null &&
    typeof row === 'object' &&
    'id' in row &&
    typeof (row as { id: unknown }).id === 'string'
  )
}

async function countOpenCampanhas(
  db: DbLike,
  empresaId: string,
  expertId: string | null,
): Promise<number> {
  const sql = `SELECT COUNT(*) AS c FROM campanhas
    WHERE empresa_id = ? AND status = 'aberta' AND deleted_at IS NULL
      ${expertId != null ? 'AND expert_id = ?' : ''}`
  const params: unknown[] = expertId != null ? [empresaId, expertId] : [empresaId]
  const row = await Promise.resolve(db.prepare(sql).get(...params))
  return Number((row as { c?: number } | undefined)?.c ?? 0)
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

async function findSingleOpenCampanhaId(
  db: DbLike,
  empresaId: string,
  expertId: string | null,
): Promise<string | null> {
  const sql = `SELECT id FROM campanhas
    WHERE empresa_id = ? AND status = 'aberta' AND deleted_at IS NULL
      ${expertId != null ? 'AND expert_id = ?' : ''}
    LIMIT 2`
  const params: unknown[] = expertId != null ? [empresaId, expertId] : [empresaId]
  const rows = await Promise.resolve(db.prepare(sql).all(...params))
  if (!Array.isArray(rows) || rows.length !== 1) return null
  const first = rows[0]
  return isLiveCampanhaRow(first) ? first.id : null
}

async function verifyLiveCampanhaForEmpresa(
  db: DbLike,
  campanhaId: string,
  empresaId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT 1 FROM campanhas WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
      )
      .get(campanhaId, empresaId),
  )
  return !!row
}

async function verifyLiveCampanhaForTopic(
  db: DbLike,
  campanhaId: string,
  empresaId: string,
  expertId: string | null,
): Promise<boolean> {
  if (!expertId) return false
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT 1 FROM campanhas WHERE id = ? AND empresa_id = ? AND expert_id = ? AND deleted_at IS NULL`,
      )
      .get(campanhaId, empresaId, expertId),
  )
  return !!row
}

async function isSameEmpresaMember(
  db: DbLike,
  empresaId: string,
  userId: string,
): Promise<boolean> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT 1 FROM empresa_membros m JOIN empresas e ON e.id = m.empresa_id
         WHERE m.empresa_id = ? AND m.user_id = ? AND e.deleted_at IS NULL`,
      )
      .get(empresaId, userId),
  )
  return !!row
}

async function getTelegramLink(
  db: DbLike,
  userId: string,
): Promise<string | null> {
  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT telegram_user_id FROM user_telegram_links WHERE user_id = ?`,
      )
      .get(userId),
  )
  if (
    row &&
    typeof row === 'object' &&
    'telegram_user_id' in row &&
    typeof (row as { telegram_user_id: unknown }).telegram_user_id === 'string'
  ) {
    return String((row as { telegram_user_id: string }).telegram_user_id)
  }
  return null
}

/** @internal factory for tenant-closed defineTool set */
export function createGestaoBotTools(
  closure: GestaoBotToolsClosure,
): ToolDefinition[] {
  const {
    empresa_id: closureEmpresaId,
    expert_id: closureExpertId,
    actor_user_id: closureActorId,
    surface,
    db,
    sendNotify,
  } = closure

  const tools: ToolDefinition[] = []

  // In Flue 2.x, `terminate: true` settles the tool batch rather than aborting it.
  // If `definir_empresa_ativa` runs before a sibling mutating tool, that sibling would
  // still execute against the OLD empresa closure and write into the wrong tenant.
  // This per-render latch blocks any further mutating tool in the same batch after a switch.
  let activeEmpresaSwitched = false
  let empresaSwitchInFlight = false

  // Common helpers
  async function ensureFk(): Promise<void> {
    await enableForeignKeysAsync(db)
  }

  // listar_tarefas (both surfaces)
  tools.push(
    defineTool({
      name: 'listar_tarefas',
      description:
        'Lista tarefas da empresa ativa. Preferir o campo telegram_preview na resposta ao usuário (já formatado p/ Telegram).',
      input: v.object({}),
      run: async () => {
        await ensureFk()
        // ignore any model-supplied empresa_id
        const sql = `SELECT id, campanha_id, titulo, status, dono_id, created_by, deleted_at
          FROM tarefas
          WHERE empresa_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 50`
        const rows = (await Promise.resolve(
          db.prepare(sql).all(closureEmpresaId),
        )) as Array<Record<string, unknown>>
        const list = rows ?? []
        const statusMeta: Record<
          string,
          { label: string; emoji: string }
        > = {
          a_fazer: { label: 'A fazer', emoji: '📝' },
          fazendo: { label: 'Fazendo', emoji: '🔄' },
          feito: { label: 'Feito', emoji: '✅' },
        }
        type EnrichedTarefa = Record<string, unknown> & {
          status_label: string
          status_emoji: string
        }
        const enriched: EnrichedTarefa[] = list.map((r) => {
          const st = String(r.status ?? '')
          const meta = statusMeta[st] ?? { label: st || '—', emoji: '•' }
          return {
            ...r,
            status_label: meta.label,
            status_emoji: meta.emoji,
          }
        })
        const byStatus = {
          a_fazer: enriched.filter((t) => t.status === 'a_fazer'),
          fazendo: enriched.filter((t) => t.status === 'fazendo'),
          feito: enriched.filter((t) => t.status === 'feito'),
        }
        const lines: string[] = []
        if (enriched.length === 0) {
          lines.push('📭 Nenhuma tarefa aberta por aqui.')
        } else {
          lines.push(`📋 *Tarefas* (${enriched.length})`)
          lines.push('')
          const sections: Array<[string, typeof enriched]> = [
            ['📝 A fazer', byStatus.a_fazer],
            ['🔄 Fazendo', byStatus.fazendo],
            ['✅ Feito', byStatus.feito],
          ]
          for (const [title, items] of sections) {
            if (items.length === 0) continue
            lines.push(`${title} · ${items.length}`)
            for (const t of items.slice(0, 15)) {
              const titulo = String(t.titulo ?? 'Sem título').trim() || 'Sem título'
              lines.push(`• ${titulo}`)
            }
            if (items.length > 15) {
              lines.push(`_…e mais ${items.length - 15}_`)
            }
            lines.push('')
          }
        }
        const telegram_preview = lines.join('\n').trim()
        return {
          output: { tarefas: enriched, telegram_preview, total: enriched.length },
          ...(activeEmpresaSwitched ? { terminate: true } : {}),
        }
      },
    }),
  )

  // criar_tarefa
  tools.push(
    defineTool({
      name: 'criar_tarefa',
      description: 'Cria tarefa em campanha da empresa.',
      input: v.object({
        titulo: v.optional(v.string()),
        campanha_id: v.optional(v.string()),
        campanhaId: v.optional(v.string()),
      }),
      run: async ({ data }) => {
      if (empresaSwitchInFlight || activeEmpresaSwitched) {
        return { output: { ok: false, error: 'A empresa ativa mudou neste turno. Refaça o pedido.' }, terminate: true }
      }
      await ensureFk()
      const titulo = String(data.titulo ?? '').trim()
      if (!titulo) return { output: { ok: false, error: 'titulo obrigatório' } }

      const explicitCampanhaId =
        typeof data.campanha_id === 'string'
          ? data.campanha_id
          : typeof data.campanhaId === 'string'
            ? data.campanhaId
            : null

      let targetCampanhaId: string | null = explicitCampanhaId

      if (surface === 'topic') {
        if (!targetCampanhaId) {
          const openCount = await countOpenCampanhas(
            db,
            closureEmpresaId,
            closureExpertId,
          )
          if (openCount === 1) {
            targetCampanhaId = await findSingleOpenCampanhaId(
              db,
              closureEmpresaId,
              closureExpertId,
            )
          } else if (openCount === 0) {
            return {
              output: {
                status: 'no_open_campaign',
                message:
                  'Nenhuma campanha aberta. Crie uma campanha ou informe a campanha_id.',
              },
            }
          } else {
            return {
              output: {
                status: 'ask_campaign',
                message: 'Qual campanha? Há mais de uma aberta.',
              },
            }
          }
        }
        if (targetCampanhaId) {
          const ok = await verifyLiveCampanhaForTopic(
            db,
            targetCampanhaId,
            closureEmpresaId,
            closureExpertId,
          )
          if (!ok) {
            return {
              output: {
                ok: false,
                error: 'Campanha não encontrada ou não pertence a este expert.',
              },
            }
          }
        }
      } else {
        // DM: requires explicit campanha_id, no LD-6
        if (!targetCampanhaId) {
          return {
            output: {
              ok: false,
              error:
                'campanha_id é obrigatório para criar tarefa no DM. Informe a campanha_id explicitamente.',
            },
          }
        }
        const ok = await verifyLiveCampanhaForEmpresa(
          db,
          targetCampanhaId,
          closureEmpresaId,
        )
        if (!ok) {
          return { output: { ok: false, error: 'Campanha não encontrada.' } }
        }
      }

      if (!targetCampanhaId) {
        return { output: { ok: false, error: 'campanha_id inválido' } }
      }

      const id = crypto.randomUUID()
      const isTopic = surface === 'topic'
      if (isTopic && !closureExpertId) {
        return { output: { ok: false, error: 'Campanha não encontrada' } }
      }
      const whereClause = isTopic
        ? 'id = ? AND empresa_id = ? AND expert_id = ? AND deleted_at IS NULL'
        : 'id = ? AND empresa_id = ? AND deleted_at IS NULL'
      const runResult = await Promise.resolve(
        db
          .prepare(
            `INSERT INTO tarefas
               (id, empresa_id, campanha_id, titulo, notas, status, created_by, dono_id)
             SELECT ?, empresa_id, id, ?, '', 'a_fazer', ?, ?
             FROM campanhas
             WHERE ${whereClause}`,
          )
          .run(
            id,
            titulo,
            closureActorId,
            closureActorId,
            targetCampanhaId,
            closureEmpresaId,
            ...(isTopic ? [closureExpertId] : []),
          ),
      )
      const changes = runChanges(runResult) ?? 0
      if (changes === 0) {
        return { output: { ok: false, error: 'Campanha não encontrada' } }
      }
      return { output: { ok: true, id, campanha_id: targetCampanhaId } }
    },
    }),
  )

  // atualizar_tarefa
  tools.push(
    defineTool({
      name: 'atualizar_tarefa',
      description: 'Atualiza status ou título de tarefa.',
      input: v.object({
        id: v.optional(v.string()),
        tarefa_id: v.optional(v.string()),
        status: v.optional(v.string()),
        titulo: v.optional(v.string()),
      }),
      run: async ({ data }) => {
      if (empresaSwitchInFlight || activeEmpresaSwitched) {
        return { output: { ok: false, error: 'A empresa ativa mudou neste turno. Refaça o pedido.' }, terminate: true }
      }
      await ensureFk()
      const id = String(data.id ?? data.tarefa_id ?? '')
      if (!id) return { output: { ok: false, error: 'id obrigatório' } }
      const live = await Promise.resolve(
        db
          .prepare(
            `SELECT id FROM tarefas WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
          )
          .get(id, closureEmpresaId),
      )
      if (!live) return { output: { ok: false, error: 'Tarefa não encontrada' } }
      const status =
        typeof data.status === 'string' ? data.status : undefined
      const titulo =
        typeof data.titulo === 'string' ? data.titulo : undefined
      if (!status && !titulo) return { output: { ok: false, error: 'status ou titulo obrigatório' } }
      // TAREFA_STATUS is a readonly tuple of the union; `status` is an arbitrary model-supplied
      // string at this point, which is exactly what this guard exists to reject.
      if (status && !(TAREFA_STATUS as readonly string[]).includes(status)) {
        return { output: { ok: false, error: 'status inválido' } }
      }
      if (status) {
        const liveStatusRow = await Promise.resolve(
          db
            .prepare(
              `SELECT status FROM tarefas WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
            )
            .get(id, closureEmpresaId),
        )
        const liveStatus = (liveStatusRow as { status?: string } | undefined)?.status
        if (status !== liveStatus) {
          const r = await Promise.resolve(
            db
              .prepare(
                `UPDATE tarefas SET status = ?, updated_at = datetime('now')
                 WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
              )
              .run(status, id, closureEmpresaId),
          )
          const ch = runChanges(r) ?? 0
          if (ch === 0) return { output: { ok: false, error: 'Tarefa não encontrada' } }
        }
      }
      if (titulo) {
        const r = await Promise.resolve(
          db
            .prepare(
              `UPDATE tarefas SET titulo = ?
               WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
            )
            .run(titulo, id, closureEmpresaId),
        )
        const ch = runChanges(r) ?? 0
        if (ch === 0) return { output: { ok: false, error: 'Tarefa não encontrada' } }
      }
      return { output: { ok: true } }
    },
    }),
  )

  // excluir_tarefa — soft delete
  tools.push(
    defineTool({
      name: 'excluir_tarefa',
      description: 'Exclui (soft-delete) uma tarefa.',
      input: v.object({
        id: v.optional(v.string()),
        tarefa_id: v.optional(v.string()),
      }),
      run: async ({ data }) => {
      if (empresaSwitchInFlight || activeEmpresaSwitched) {
        return { output: { ok: false, error: 'A empresa ativa mudou neste turno. Refaça o pedido.' }, terminate: true }
      }
      await ensureFk()
      const id = String(data.id ?? data.tarefa_id ?? '')
      if (!id) return { output: { ok: false, error: 'id obrigatório' } }
      const runResult = await Promise.resolve(
        db
          .prepare(
            `UPDATE tarefas SET deleted_at = datetime('now')
             WHERE id = ? AND empresa_id = ? AND deleted_at IS NULL`,
          )
          .run(id, closureEmpresaId),
      )
      const changes = runChanges(runResult) ?? 0
      if (changes === 0) {
        const exists = await Promise.resolve(
          db.prepare(`SELECT id FROM tarefas WHERE id = ? AND empresa_id = ?`).get(id, closureEmpresaId),
        )
        if (exists) return { output: { ok: true } }
        return { output: { ok: false, error: 'Tarefa não encontrada' } }
      }
      return { output: { ok: true } }
    },
    }),
  )

  // notificar_usuario
  tools.push(
    defineTool({
      name: 'notificar_usuario',
      description: 'Notifica usuário via Telegram.',
      input: v.object({
        user_id: v.optional(v.string()),
        userId: v.optional(v.string()),
        mensagem: v.optional(v.string()),
        message: v.optional(v.string()),
      }),
      run: async ({ data }) => {
      if (empresaSwitchInFlight || activeEmpresaSwitched) {
        return { output: { ok: false, error: 'A empresa ativa mudou neste turno. Refaça o pedido.' }, terminate: true }
      }
      await ensureFk()
      const userId = String(data.user_id ?? data.userId ?? '')
      const mensagem = String(data.mensagem ?? data.message ?? '')
      if (!userId) return { output: { ok: false, error: 'user_id obrigatório' } }
      const sameEmpresa = await isSameEmpresaMember(
        db,
        closureEmpresaId,
        userId,
      )
      if (!sameEmpresa) return { output: { ok: false, error: 'Usuário não encontrado' } }
      const tgId = await getTelegramLink(db, userId)
      if (!tgId) {
        return {
          output: {
            ok: false,
            message: 'Usuário não possui link com Telegram',
          },
        }
      }
      await Promise.resolve(sendNotify(tgId, mensagem))
      return { output: { ok: true } }
    },
    }),
  )

  // listar_membros
  tools.push(
    defineTool({
      name: 'listar_membros',
      description: 'Lista membros da empresa.',
      input: v.object({}),
      run: async () => {
      await ensureFk()
      const sql = `SELECT m.user_id, u.name, m.papel
        FROM empresa_membros m
        JOIN users u ON u.id = m.user_id
        WHERE m.empresa_id = ?
        ORDER BY u.name COLLATE NOCASE, m.user_id LIMIT 50`
      const rows = await Promise.resolve(db.prepare(sql).all(closureEmpresaId))
      return { output: { membros: rows ?? [] }, ...(activeEmpresaSwitched ? { terminate: true } : {}) }
    },
    }),
  )

  if (surface === 'topic') {
    tools.push(
      defineTool({
        name: 'listar_campanhas',
        description: 'Lista campanhas do expert no tópico.',
        input: v.object({}),
        run: async () => {
        await ensureFk()
        if (!closureExpertId) return { output: { campanhas: [] } }
        const sql = `SELECT id, nome, status, expert_id FROM campanhas
          WHERE empresa_id = ? AND expert_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 50`
        const rows = await Promise.resolve(
          db.prepare(sql).all(closureEmpresaId, closureExpertId),
        )
        return { output: { campanhas: rows ?? [] } }
      },
      }),
    )
  }

  if (surface === 'dm') {
    tools.push(
      defineTool({
        name: 'listar_minhas_empresas',
        description: 'Lista empresas do usuário.',
        input: v.object({}),
        run: async () => {
        await ensureFk()
        const sql = `SELECT e.id, e.nome
          FROM empresa_membros m
          JOIN empresas e ON e.id = m.empresa_id
          WHERE m.user_id = ? AND e.deleted_at IS NULL
          ORDER BY e.nome COLLATE NOCASE, e.id
          LIMIT 50`
        const rows = await Promise.resolve(
          db.prepare(sql).all(closureActorId),
        )
        return { output: { empresas: rows ?? [] }, ...(activeEmpresaSwitched ? { terminate: true } : {}) }
      },
      }),
    )

    tools.push(
      defineTool({
        name: 'definir_empresa_ativa',
        description: 'Define empresa ativa para DM e encerra turno.',
        input: v.object({
          empresa_id: v.optional(v.string()),
          empresaId: v.optional(v.string()),
        }),
        run: async ({ data }) => {
        const targetEmpresaId = String(data.empresa_id ?? data.empresaId ?? '')
        if (targetEmpresaId && targetEmpresaId === closureEmpresaId) {
          await ensureFk()
          return { output: { empresa_id: targetEmpresaId }, terminate: true }
        }
        if (empresaSwitchInFlight || activeEmpresaSwitched) {
          return { output: { ok: false, error: 'Já houve uma troca de empresa neste turno. Refaça o pedido.' }, terminate: true }
        }
        empresaSwitchInFlight = true
        let switchCommitted = false
        try {
          await ensureFk()
          if (!targetEmpresaId) {
            empresaSwitchInFlight = false
            return { output: { ok: false, error: 'empresa_id obrigatório' } }
          }
          const same = await isSameEmpresaMember(
            db,
            targetEmpresaId,
            closureActorId,
          )
          if (!same) {
            empresaSwitchInFlight = false
            return { output: { ok: false, error: 'Empresa não encontrada' } }
          }
          const current = await Promise.resolve(
            db.prepare(`SELECT empresa_id FROM telegram_dm_active_empresa WHERE user_id = ?`).get(closureActorId),
          )
          if ((current as any)?.empresa_id === targetEmpresaId) {
            empresaSwitchInFlight = false
            return { output: { empresa_id: targetEmpresaId }, terminate: true }
          }
          switchCommitted = true
          await Promise.resolve(
            db
              .prepare(
                `INSERT INTO telegram_dm_active_empresa (user_id, empresa_id, pending_boundary)
                 VALUES (?, ?, 1)
                 ON CONFLICT(user_id) DO UPDATE SET
                   empresa_id = excluded.empresa_id,
                   pending_boundary = 1`,
              )
              .run(closureActorId, targetEmpresaId),
          )
          activeEmpresaSwitched = true
          return { output: { empresa_id: targetEmpresaId }, terminate: true }
        } catch (error) {
          if (!switchCommitted) empresaSwitchInFlight = false
          throw error
        }
      },
      }),
    )
  }

  return tools
}
