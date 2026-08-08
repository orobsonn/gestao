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

## Migration chain

| File | Role |
|------|------|
| `0001_init.sql` | Full schema bootstrap (includes `sessions.active_empresa_id`). |
| `0002_sessions_active_empresa.sql` | **No-op forward stub.** `active_empresa_id` was folded into 0001; kept so history stays monotonic for DBs that already recorded 0002. Do **not** `ADD COLUMN` again (duplicate column on fresh apply). |
| `0003_campanha_optional_fields.sql` | Forward: `campanhas.data_inicio`, `data_fim` (nullable TEXT), `notas` (`TEXT NOT NULL DEFAULT ''`). |
| `0004_empresa_llm_settings.sql` | Forward: `empresa_llm_settings` (PK `empresa_id` → `empresas`, encrypted key material + provider + status `unvalidated\|valid\|invalid`). No plaintext key; no soft-delete; Metadata `none` = no row. |
| `0005_telegram_dm_link.sql` | Forward: `telegram_link_codes` (user-scoped one-shot codes, UNIQUE `code_hash`, FK `users` CASCADE, partial unique index one-unused-per-user on `user_id` WHERE `used_at IS NULL`) + `user_telegram_links` (PK `user_id`, UNIQUE `telegram_user_id`, FK `users` CASCADE). No `empresa_id` — link is global per user. |
| `0006_telegram_grupo_topico.sql` | Forward: `telegram_bind_codes` (empresa-scoped, kind empresa|expert + CHECK + split partial uniques on empresa_id/expert_id WHERE unused), `empresa_telegram_chats` (PK empresa_id, UNIQUE chat_id, composite UNIQUE for FK target), `expert_telegram_topics` (PK expert_id, UNIQUE(chat_id,message_thread_id), composite FKs to experts + mandatory FK to empresa_telegram_chats). |
| `0007_telegram_agent_support.sql` | Forward: `telegram_webhook_updates` (update_id PK for dedup), `telegram_dm_active_empresa` (user_id PK, empresa_id FK, pending_boundary 0|1), `telegram_agent_turn_context` (turn_token PK, ciphertext+iv NOT NULL, composite nullable expert FK). |

### Hermetic openDb rule (tests + local)

Every connection that builds schema from this folder must:

1. Open SQLite (e.g. `:memory:` or local file).
2. `PRAGMA foreign_keys = ON` immediately after open.
3. Apply **every** `migrations/*.sql` file, sorted **lexically by filename** (not a hand-picked subset).

Skipping files or applying out of order breaks the chain contract locked by `tests/domain-migrations.test.mjs`.

## Hierarchy (v1)

`Empresa → Expert → Campanha → Tarefa` only. No `projects` / `tasks` synonym tables.
