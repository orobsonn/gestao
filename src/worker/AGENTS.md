# src/worker/ — folder law

Cloudflare Worker API (Hono) for auth, bootstrap, and platform provision.

## Conventions

- **Await DB ops:** always `await Promise.resolve(stmt.run/get(...))` and `await db.batch(...)` — D1 is async; bare calls race.
- **PRAGMA foreign_keys=ON** on every request path that touches DB (see `db.ts` / index middleware on `/api/*` only).
- **Sessions:** store SHA-256 hex of raw token only; never raw token. `expires_at` via SQL `datetime('now', '+14 days')`; resolve with `expires_at > datetime('now')`.
- **Active empresa:** `sessions.active_empresa_id` (nullable single-column FK → empresas; not composite). Tenant routes use `requireActiveEmpresa` — scope from session only, never client-supplied empresa id.
- **Stale active clear (TOCTOU):** when membership missing / empresa soft-deleted / invalid papel, call `clearActiveEmpresaIf(db, token, expectedId)` — never blind `SET active_empresa_id = NULL`.
- **Login auto-select:** exactly one non-deleted membership → set active on mint; 0 or N>1 → null until `POST /api/auth/active-empresa`.
- **Cookies:** `gestao_session` HttpOnly + Secure + SameSite=Lax + Path=/ on set **and** clear (Max-Age=0).
- **Passwords:** PBKDF2-SHA-256 100k, hex salt/hash, timing-safe verify; length 8..1024 at crypto + Zod boundaries.
- **Platform gate:** `users.role === 'super_admin'` only — membership `papel` never elevates.
- **Membership papel:** `admin` | `membro` only; never elevates platform role; empresa-admin gates use `requireEmpresaAdmin` after `requireActiveEmpresa`.
- **Multi-row writes:** empresa + first admin user + membership in a single `db.batch`.
- **Create membro:** new email → batch user(role=user) + membership; existing email already member → 409; existing other empresa → membership only, never change password_hash/salt. On UNIQUE race for new email: re-SELECT user + membership before mapping to 409. Result `created: true` only when a new user row was inserted.
- **D1 adapter:** must implement `all()` for multi-row reads (memberships, membros list).
- **Bootstrap:** secrets `SUPER_ADMIN_*` only; never wrangler.jsonc vars; no password overwrite; no promote of existing user; pre-hash email collision check; middleware only under `/api/*`.
- **Hermetic tests:** export `createAuthApp(db)` / `createPlatformApp(db)` / `createEmpresaApp(db)` factories; node:sqlite + `0001_init.sql`.
