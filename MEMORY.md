# Project Memory — Index

One line per durable, reusable, non-obvious project pattern or anti-pattern.

**Never write secrets, credentials, or PII here — this file is committed to git.**

<!-- index entries go below -->

- [composite-tenant-fks](#composite-tenant-fks) — D1 multi-tenant parent/child links must use UNIQUE(id,empresa_id)+composite FK, never single-column parent id alone
- [membership-hard-delete](#membership-hard-delete) — empresa_membros is hard-delete only; domain entities use soft-delete deleted_at
- [hermetic-migration-tests](#hermetic-migration-tests) — schema contract tests use node:sqlite in-memory + node:test, not Workers/miniflare
- [pragma-foreign-keys-on](#pragma-foreign-keys-on) — SQLite/D1 FK enforcement requires PRAGMA foreign_keys=ON at every connection; migration SQL cannot set it
- [d1-await-statement-ops](#d1-await-statement-ops) — always await Promise.resolve on D1/DbLike prepare().run/get/batch; bare sync-style calls race on Workers
- [platform-guard-users-role](#platform-guard-users-role) — platform routes gate on users.role===super_admin only; empresa membership papel never elevates
- [multi-row-write-db-batch](#multi-row-write-db-batch) — multi-table provision (empresa+user+membro) must use a single db.batch, not sequential run
- [bootstrap-super-admin-fail-closed](#bootstrap-super-admin-fail-closed) — SUPER_ADMIN_* are secrets; existing SA never password-overwrite; email collision with role=user never promotes

---

## composite-tenant-fks

**Why:** A child row with only `parent_id` can point at a parent owned by another empresa. Single-column FKs do not encode tenant scope, so cross-tenant hierarchy links slip through at the DB layer.

**How to apply:** On every tenant-scoped parent that children reference (`experts`, `campanhas`, …), add `UNIQUE (id, empresa_id)`. On the child, denormalize `empresa_id NOT NULL` and declare `FOREIGN KEY (parent_id, empresa_id) REFERENCES parent(id, empresa_id)`. Mirror the pattern for any new hierarchy level under Empresa. See `migrations/0001_init.sql` and locked tests in `tests/schema-domain.test.mjs`.

---

## membership-hard-delete

**Why:** Soft-deleting membership blocks re-invite of the same `(empresa_id, user_id)` while `UNIQUE (empresa_id, user_id)` still holds the tombstone. Domain entities need audit-friendly soft-delete; membership does not.

**How to apply:** `empresa_membros` has no `deleted_at` — remove membership with `DELETE`. Keep `deleted_at` on `empresas`, `experts`, `campanhas`, `tarefas`. Product copy may say “removed”; schema still soft-deletes domain rows. App/auth layers (issues #5/#6) must still filter `empresas.deleted_at IS NULL` and validate `dono_id`/`created_by` membership.

---

## hermetic-migration-tests

**Why:** Migration contract tests must not depend on wrangler, D1 local journal state, or Workers runtime. Those couple schema truth to env setup and hide FK pragma mistakes.

**How to apply:** Use `node:sqlite` `DatabaseSync(":memory:")`, `PRAGMA foreign_keys = ON`, `readFileSync` the migration, and `node:test` via `package.json` script `node --experimental-strip-types --test`. Pattern: `tests/schema-domain.test.mjs`. Prefer this for pure SQL/schema locks; reserve Workers test harness for runtime binding behavior.

---

## pragma-foreign-keys-on

**Why:** SQLite (and D1’s SQLite engine) does not enforce foreign keys unless the connection enables the pragma. Composite tenant FKs are a no-op without it — inserts that should fail succeed silently.

**How to apply:** Every code path that opens a DB for writes/tests must run `PRAGMA foreign_keys = ON` immediately after connect. Do not rely on the migration file to set it (comment-only reminder in `migrations/0001_init.sql`). When adding a new DB helper or test opener, copy the `openDb()` pattern from `tests/schema-domain.test.mjs`.

---

## d1-await-statement-ops

**Why:** D1 `prepare().run/get` returns Promises. Calling them without await makes mint/resolve look sync while the write has not settled — next request 401s or reads stale state.

**How to apply:** Use `await Promise.resolve(stmt.run/get(...))` (and await `db.batch`) so both node:sqlite sync returns and D1 Promises settle. See `src/worker/auth/session.ts` and `src/worker/types.ts` StatementLike.

---

## platform-guard-users-role

**Why:** Empresa `admin` membership is not platform authority. Trusting `papel` or a client-supplied role would let any tenant admin provision houses.

**How to apply:** `/api/platform/*` requires authenticated session AND `users.role === 'super_admin'` from DB. Never read role from request body/headers. UI hide is best-effort only.

---

## multi-row-write-db-batch

**Why:** Sequential INSERT empresa then user then membership orphans a tenant when a later step hits UNIQUE(email) or fails.

**How to apply:** `createEmpresaAsSuperAdmin` must use one `db.batch([empresa, user, membro])` (or IMMEDIATE transaction emulation in hermetic tests). Map email UNIQUE to 409 with no leftover empresa.

---

## bootstrap-super-admin-fail-closed

**Why:** Bootstrap is the only path to the platform god account. Overwriting password, promoting a tenant user, or putting secrets in wrangler `vars` breaks lockout/isolation.

**How to apply:** `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD` via `.dev.vars` / `wrangler secret put` only. Skip if SA exists (no password reset). Pre-check email before PBKDF2; `role=user` collision → `{ok:false}` no promote. Run bootstrap only on `/api/*`, not ASSETS.
