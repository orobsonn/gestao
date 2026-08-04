# Project Memory — Index

One line per durable, reusable, non-obvious project pattern or anti-pattern.

**Never write secrets, credentials, or PII here — this file is committed to git.**

<!-- index entries go below -->

- [composite-tenant-fks](#composite-tenant-fks) — D1 multi-tenant parent/child links must use UNIQUE(id,empresa_id)+composite FK, never single-column parent id alone
- [membership-hard-delete](#membership-hard-delete) — empresa_membros is hard-delete only; domain entities use soft-delete deleted_at
- [hermetic-migration-tests](#hermetic-migration-tests) — schema contract tests use node:sqlite in-memory + node:test, not Workers/miniflare
- [pragma-foreign-keys-on](#pragma-foreign-keys-on) — SQLite/D1 FK enforcement requires PRAGMA foreign_keys=ON at every connection; migration SQL cannot set it

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
