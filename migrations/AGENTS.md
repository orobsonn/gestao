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
| `0008_empresa_llm_model.sql` | Forward: nullable provider-native `model_id` on `empresa_llm_settings`; legacy settings remain null. |
| `0009_telegram_turn_model.sql` | Forward: nullable **provider-namespaced** `model_id` on `telegram_agent_turn_context` (e.g. `openai/gpt-4o-mini`) — note this is the OPPOSITE format from `0008`, which stores the provider-native id. Legacy contexts remain compatible. |
| `0010_telegram_agent_reply_send_guard.sql` | Forward: `telegram_agent_reply_sends` (PK `answered_by_submission_id`, `created_at` timestamp) for duplicate reply guard. |
| `0011_drop_telegram_agent_turn_context.sql` | Forward: `DROP TABLE telegram_agent_turn_context`. The D1 turn-context bridge is gone — the turn's non-secret facts (`empresaId`, `expertId`, `actorUserId`, `surface`, `provider`, `modelId`, `dmBoundaryLine`) now ride the dispatched signal's `attributes` instead of a row keyed by the shared topic agent id (root cause of a `turn_token` PRIMARY KEY collision that dropped a second user's message and could wedge a topic permanently). |

### Hermetic openDb rule (tests + local)

Every connection that builds schema from this folder must:

1. Open SQLite (e.g. `:memory:` or local file).
2. `PRAGMA foreign_keys = ON` immediately after open.
3. Apply **every** `migrations/*.sql` file, sorted **lexically by filename** (not a hand-picked subset).

Skipping files or applying out of order breaks the chain contract locked by `tests/domain-migrations.test.mjs`.

## Hierarchy (v1)

`Empresa → Expert → Campanha → Tarefa` only. No `projects` / `tasks` synonym tables.

## Deploy order for `0011_drop_telegram_agent_turn_context.sql` (accepted trade-off)

Migration `0011` DROPs `telegram_agent_turn_context`, a table the still-live beta Worker **reads**
on every turn. The decided order for this migration is:

**migrate-all → build → deploy**

i.e. `npm run db:migrate` (applies `0010` + `0011` to prod D1) runs and completes **before** the new
Worker is built and deployed. This accepts a short window — between the migration landing and the
new Worker going live — where the still-running beta Worker's read against the now-dropped table
fails.

**Why this order, and why the window is accepted:**

- The new Worker needs `0010`'s send-guard table (`telegram_agent_reply_sends`) in place **before**
  its very first turn — reversing the order (deploy first, migrate after) would leave the new Worker
  without the guard it depends on for its own first requests.
- The beta turn path this window can degrade is **already broken** — `0011` exists specifically to
  fix the `turn_token` PRIMARY KEY collision in the D1 turn-context bridge that could drop a second
  user's message and wedge a topic permanently (see `turn-context-attributes-not-d1` in
  `MEMORY.md`). The window trades a few extra minutes of an already-known-broken path for a clean
  cutover, not a regression from a healthy state.
- **Blast radius at decision time:** production has **0 linked Telegram groups, 0 linked topics, 1
  linked Telegram user.** The window's worst case is one DM user's bot reply failing for the minutes
  between migration and deploy — not a multi-tenant incident.

This is a written trade-off, not silence: do not "fix" the ordering to be simultaneous or
deploy-first without re-evaluating the send-guard dependency above.
