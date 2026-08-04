/** @description Home dashboard read API — role-scoped KPIs, charts, and open-task lists. */

import type { Hono } from 'hono'
import type { ActiveEmpresaVariables } from '../middleware/require-active-empresa.ts'
import { requireActiveEmpresa } from '../middleware/require-active-empresa.ts'
import { requireSession } from '../middleware/require-session.ts'
import type { DbLike, MembershipPapel } from '../types.ts'

/** @description Open-task row in home lists (meu_trabalho / empresa_abertas). */
export type HomeTarefa = {
  id: string
  titulo: string
  status: string
  prazo: string | null
  dono_id: string | null
  dono_nome: string | null
  campanha_id: string
  expert_id: string
  expert_nome: string
  atrasada: boolean
}

/** @description Canonical KPI block for GET /api/empresa/home. */
export type HomeKpis = {
  atrasadas_empresa: number
  vencem_hoje_empresa: number
  abertas_empresa: number
  feitas_7d_empresa: number
  minhas_atrasadas: number
  minhas_vencem_hoje: number
  minhas_abertas: number
  minhas_feitas_7d: number
}

/** @description Urgency chart bucket entry. */
export type HomeUrgenciaBucket = {
  bucket: 'atrasadas' | 'hoje' | 'semana' | 'depois'
  count: number
}

/** @description Status chart key entry. */
export type HomeStatusKey = {
  key: 'atrasada' | 'a_fazer' | 'fazendo' | 'feito'
  count: number
}

/** @description Late-by-expert chart entry (admin only; empty for membro). */
export type HomeAtrasadaPorExpert = {
  expert_id: string
  expert_nome: string
  count: number
}

/** @description Fixed payload shape for GET /api/empresa/home. */
export type HomePayload = {
  papel: MembershipPapel
  viewer_user_id: string
  kpis: HomeKpis
  charts: {
    urgencia: HomeUrgenciaBucket[]
    status: HomeStatusKey[]
    atrasadas_por_expert: HomeAtrasadaPorExpert[]
  }
  meu_trabalho: HomeTarefa[]
  empresa_abertas: HomeTarefa[]
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
 * @description Map a joined home-list row to HomeTarefa, or null if shape is invalid.
 */
function mapHomeTarefa(row: Record<string, unknown>): HomeTarefa | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.titulo !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.campanha_id !== 'string' ||
    typeof row.expert_id !== 'string' ||
    typeof row.expert_nome !== 'string'
  ) {
    return null
  }
  if (row.prazo != null && typeof row.prazo !== 'string') return null
  if (row.dono_id != null && typeof row.dono_id !== 'string') return null
  if (row.dono_nome != null && typeof row.dono_nome !== 'string') return null

  const atrasadaRaw = row.atrasada
  const atrasada =
    atrasadaRaw === true ||
    atrasadaRaw === 1 ||
    atrasadaRaw === '1' ||
    atrasadaRaw === 'true'

  return {
    id: row.id,
    titulo: row.titulo,
    status: row.status,
    prazo: row.prazo ?? null,
    dono_id: row.dono_id ?? null,
    dono_nome: row.dono_nome ?? null,
    campanha_id: row.campanha_id,
    expert_id: row.expert_id,
    expert_nome: row.expert_nome,
    atrasada,
  }
}

/** @description Shared SELECT + joins for home open-task lists. */
const HOME_TAREFA_SELECT = `
  t.id AS id,
  t.titulo AS titulo,
  t.status AS status,
  t.prazo AS prazo,
  t.dono_id AS dono_id,
  u.name AS dono_nome,
  t.campanha_id AS campanha_id,
  c.expert_id AS expert_id,
  e.nome AS expert_nome,
  CASE
    WHEN t.prazo IS NOT NULL AND t.prazo < date('now') THEN 1
    ELSE 0
  END AS atrasada
`

/** @description List order: late first, then prazo ASC NULLS LAST, then titulo. */
const HOME_TAREFA_ORDER = `
  CASE
    WHEN t.prazo IS NOT NULL AND t.prazo < date('now') THEN 1
    ELSE 0
  END DESC,
  CASE WHEN t.prazo IS NULL THEN 1 ELSE 0 END ASC,
  t.prazo ASC,
  t.titulo ASC
`

/**
 * @description Count live open tasks matching optional dono filter and metric predicate.
 * metric: 'abertas' | 'atrasadas' | 'vencem_hoje'
 */
async function countOpenMetric(
  db: DbLike,
  empresaId: string,
  metric: 'abertas' | 'atrasadas' | 'vencem_hoje',
  donoId: string | null,
): Promise<number> {
  const donoClause = donoId != null ? 'AND t.dono_id = ?' : ''
  let metricClause = ''
  if (metric === 'atrasadas') {
    metricClause = `AND t.prazo IS NOT NULL AND t.prazo < date('now')`
  } else if (metric === 'vencem_hoje') {
    metricClause = `AND t.prazo = date('now')`
  }

  const params: string[] = [empresaId]
  if (donoId != null) params.push(donoId)

  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM tarefas t
         WHERE t.empresa_id = ?
           AND t.deleted_at IS NULL
           AND t.status != 'feito'
           ${donoClause}
           ${metricClause}`,
      )
      .get(...params),
  )
  return asCount(row?.n)
}

/**
 * @description Count live feito tasks with date(updated_at) within last 7 days.
 */
async function countFeitas7d(
  db: DbLike,
  empresaId: string,
  donoId: string | null,
): Promise<number> {
  const donoClause = donoId != null ? 'AND t.dono_id = ?' : ''
  const params: string[] = [empresaId]
  if (donoId != null) params.push(donoId)

  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM tarefas t
         WHERE t.empresa_id = ?
           AND t.deleted_at IS NULL
           AND t.status = 'feito'
           AND date(t.updated_at) >= date('now', '-7 days')
           ${donoClause}`,
      )
      .get(...params),
  )
  return asCount(row?.n)
}

/**
 * @description Build the eight canonical KPI fields; empresa_* zeroed when failClosed.
 */
async function buildKpis(
  db: DbLike,
  empresaId: string,
  viewerUserId: string,
  failClosedEmpresa: boolean,
): Promise<HomeKpis> {
  const minhas_atrasadas = await countOpenMetric(
    db,
    empresaId,
    'atrasadas',
    viewerUserId,
  )
  const minhas_vencem_hoje = await countOpenMetric(
    db,
    empresaId,
    'vencem_hoje',
    viewerUserId,
  )
  const minhas_abertas = await countOpenMetric(
    db,
    empresaId,
    'abertas',
    viewerUserId,
  )
  const minhas_feitas_7d = await countFeitas7d(db, empresaId, viewerUserId)

  if (failClosedEmpresa) {
    return {
      atrasadas_empresa: 0,
      vencem_hoje_empresa: 0,
      abertas_empresa: 0,
      feitas_7d_empresa: 0,
      minhas_atrasadas,
      minhas_vencem_hoje,
      minhas_abertas,
      minhas_feitas_7d,
    }
  }

  const atrasadas_empresa = await countOpenMetric(
    db,
    empresaId,
    'atrasadas',
    null,
  )
  const vencem_hoje_empresa = await countOpenMetric(
    db,
    empresaId,
    'vencem_hoje',
    null,
  )
  const abertas_empresa = await countOpenMetric(db, empresaId, 'abertas', null)
  const feitas_7d_empresa = await countFeitas7d(db, empresaId, null)

  return {
    atrasadas_empresa,
    vencem_hoje_empresa,
    abertas_empresa,
    feitas_7d_empresa,
    minhas_atrasadas,
    minhas_vencem_hoje,
    minhas_abertas,
    minhas_feitas_7d,
  }
}

/**
 * @description Urgency buckets for open tasks in chart scope (empresa-wide or dono=viewer).
 */
async function buildUrgenciaChart(
  db: DbLike,
  empresaId: string,
  chartDonoId: string | null,
): Promise<HomeUrgenciaBucket[]> {
  const donoClause = chartDonoId != null ? 'AND t.dono_id = ?' : ''
  const params: string[] = [empresaId]
  if (chartDonoId != null) params.push(chartDonoId)

  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT
           SUM(CASE
             WHEN t.prazo IS NOT NULL AND t.prazo < date('now') THEN 1
             ELSE 0
           END) AS atrasadas,
           SUM(CASE
             WHEN t.prazo = date('now') THEN 1
             ELSE 0
           END) AS hoje,
           SUM(CASE
             WHEN t.prazo > date('now')
              AND t.prazo <= date('now', '+7 days') THEN 1
             ELSE 0
           END) AS semana,
           SUM(CASE
             WHEN t.prazo IS NULL OR t.prazo > date('now', '+7 days') THEN 1
             ELSE 0
           END) AS depois
         FROM tarefas t
         WHERE t.empresa_id = ?
           AND t.deleted_at IS NULL
           AND t.status != 'feito'
           ${donoClause}`,
      )
      .get(...params),
  )

  return [
    { bucket: 'atrasadas', count: asCount(row?.atrasadas) },
    { bucket: 'hoje', count: asCount(row?.hoje) },
    { bucket: 'semana', count: asCount(row?.semana) },
    { bucket: 'depois', count: asCount(row?.depois) },
  ]
}

/**
 * @description Status chart for chart scope: late open + non-late open by status + all live feito.
 */
async function buildStatusChart(
  db: DbLike,
  empresaId: string,
  chartDonoId: string | null,
): Promise<HomeStatusKey[]> {
  const donoClause = chartDonoId != null ? 'AND t.dono_id = ?' : ''
  const params: string[] = [empresaId]
  if (chartDonoId != null) params.push(chartDonoId)

  const row = await Promise.resolve(
    db
      .prepare(
        `SELECT
           SUM(CASE
             WHEN t.status != 'feito'
              AND t.prazo IS NOT NULL
              AND t.prazo < date('now') THEN 1
             ELSE 0
           END) AS atrasada,
           SUM(CASE
             WHEN t.status = 'a_fazer'
              AND NOT (
                t.prazo IS NOT NULL AND t.prazo < date('now')
              ) THEN 1
             ELSE 0
           END) AS a_fazer,
           SUM(CASE
             WHEN t.status = 'fazendo'
              AND NOT (
                t.prazo IS NOT NULL AND t.prazo < date('now')
              ) THEN 1
             ELSE 0
           END) AS fazendo,
           SUM(CASE
             WHEN t.status = 'feito' THEN 1
             ELSE 0
           END) AS feito
         FROM tarefas t
         WHERE t.empresa_id = ?
           AND t.deleted_at IS NULL
           ${donoClause}`,
      )
      .get(...params),
  )

  return [
    { key: 'atrasada', count: asCount(row?.atrasada) },
    { key: 'a_fazer', count: asCount(row?.a_fazer) },
    { key: 'fazendo', count: asCount(row?.fazendo) },
    { key: 'feito', count: asCount(row?.feito) },
  ]
}

/**
 * @description Late open tasks grouped by expert (admin empresa-wide only).
 */
async function buildAtrasadasPorExpert(
  db: DbLike,
  empresaId: string,
): Promise<HomeAtrasadaPorExpert[]> {
  const stmt = db.prepare(
    `SELECT
       e.id AS expert_id,
       e.nome AS expert_nome,
       COUNT(*) AS count
     FROM tarefas t
     INNER JOIN campanhas c
       ON c.id = t.campanha_id AND c.empresa_id = t.empresa_id
     INNER JOIN experts e
       ON e.id = c.expert_id AND e.empresa_id = t.empresa_id
     WHERE t.empresa_id = ?
       AND t.deleted_at IS NULL
       AND t.status != 'feito'
       AND t.prazo IS NOT NULL
       AND t.prazo < date('now')
     GROUP BY e.id, e.nome
     ORDER BY count DESC, e.nome ASC`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(empresaId))

  const result: HomeAtrasadaPorExpert[] = []
  for (const row of rows) {
    if (
      typeof row.expert_id === 'string' &&
      typeof row.expert_nome === 'string'
    ) {
      result.push({
        expert_id: row.expert_id,
        expert_nome: row.expert_nome,
        count: asCount(row.count),
      })
    }
  }
  return result
}

/**
 * @description Open live tasks for lists; optional dono filter; ordered late-first.
 */
async function listOpenHomeTarefas(
  db: DbLike,
  empresaId: string,
  donoId: string | null,
): Promise<HomeTarefa[]> {
  const donoClause = donoId != null ? 'AND t.dono_id = ?' : ''
  const params: string[] = [empresaId]
  if (donoId != null) params.push(donoId)

  const stmt = db.prepare(
    `SELECT ${HOME_TAREFA_SELECT}
     FROM tarefas t
     INNER JOIN campanhas c
       ON c.id = t.campanha_id AND c.empresa_id = t.empresa_id
     INNER JOIN experts e
       ON e.id = c.expert_id AND e.empresa_id = t.empresa_id
     LEFT JOIN users u ON u.id = t.dono_id
     WHERE t.empresa_id = ?
       AND t.deleted_at IS NULL
       AND t.status != 'feito'
       ${donoClause}
     ORDER BY ${HOME_TAREFA_ORDER}`,
  )

  if (!stmt.all) {
    throw new Error('db statement missing all()')
  }
  const rows = await Promise.resolve(stmt.all(...params))

  const result: HomeTarefa[] = []
  for (const row of rows) {
    const mapped = mapHomeTarefa(row)
    if (mapped) result.push(mapped)
  }
  return result
}

/**
 * @description Assemble the full home payload for the active empresa + viewer.
 */
async function buildHomePayload(
  db: DbLike,
  empresaId: string,
  viewerUserId: string,
  papel: MembershipPapel,
): Promise<HomePayload> {
  const isMembro = papel === 'membro'
  // Membro charts scoped to dono=viewer; admin empresa-wide
  const chartDonoId = isMembro ? viewerUserId : null

  const kpis = await buildKpis(db, empresaId, viewerUserId, isMembro)
  const urgencia = await buildUrgenciaChart(db, empresaId, chartDonoId)
  const status = await buildStatusChart(db, empresaId, chartDonoId)
  const atrasadas_por_expert = isMembro
    ? []
    : await buildAtrasadasPorExpert(db, empresaId)

  const meu_trabalho = await listOpenHomeTarefas(db, empresaId, viewerUserId)
  const empresa_abertas = isMembro
    ? []
    : await listOpenHomeTarefas(db, empresaId, null)

  return {
    papel,
    viewer_user_id: viewerUserId,
    kpis,
    charts: {
      urgencia,
      status,
      atrasadas_por_expert,
    },
    meu_trabalho,
    empresa_abertas,
  }
}

/**
 * @description Register GET /api/empresa/home on the empresa Hono app.
 * Any active member; tenant from session active_empresa_id only.
 */
export function registerHomeRoutes(
  app: Hono<{ Variables: ActiveEmpresaVariables }>,
  db: DbLike,
): void {
  app.get(
    '/api/empresa/home',
    requireSession(db),
    requireActiveEmpresa(db),
    async (c) => {
      const empresaId = c.get('activeEmpresaId')
      const user = c.get('user')
      const papel = c.get('membershipPapel')

      const payload = await buildHomePayload(db, empresaId, user.id, papel)
      return c.json(payload, 200)
    },
  )
}
