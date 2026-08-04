# migrations/ — folder law

D1 SQL migrations for the gestao multi-tenant schema.

## Conventions

- **Composite tenant FKs:** parents that children reference need `UNIQUE (id, empresa_id)`; children use `FOREIGN KEY (parent_id, empresa_id) REFERENCES parent(id, empresa_id)` plus denormalized `empresa_id NOT NULL`. Never parent-id-only FKs across tenant-scoped tables.
- **sessions.active_empresa_id exception:** user-scoped session pointer — nullable single-column `REFERENCES empresas(id)`, **not** a composite tenant FK. Declare `sessions` **after** `empresas` (SQLite needs the referenced table first).
- **PRAGMA foreign_keys:** not set inside migration files — every connection (app + tests) must `PRAGMA foreign_keys = ON` after open.
- **Soft-delete:** `deleted_at` on domain tables (`empresas`, `experts`, `campanhas`, `tarefas`). **Never** add `deleted_at` to `empresa_membros` (hard-delete only for re-invite).
- **Replace-in-place 0001:** `0001_init.sql` assumes fresh DB / wiped local D1 journal — not a forward data migration. Changing it after a local apply requires wiping the local D1 state before re-apply.
- **IDs:** TEXT PKs supplied by caller (except `empresa_membros.id` default random blob hex).
- **Timestamps:** ISO-ish TEXT via `datetime('now')`.
- **Enums in SQL:** CHECK constraints are source of truth; TS mirrors live in `src/shared/domain/enums.ts` — keep them in lockstep.

## Hierarchy (v1)

`Empresa → Expert → Campanha → Tarefa` only. No `projects` / `tasks` synonym tables.
