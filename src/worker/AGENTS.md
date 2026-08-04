# src/worker/ — folder law

Cloudflare Worker API (Hono) for auth, bootstrap, and platform provision.

## Conventions

- **Await DB ops:** always `await Promise.resolve(stmt.run/get(...))` and `await db.batch(...)` — D1 is async; bare calls race.
- **PRAGMA foreign_keys=ON** on every request path that touches DB (see `db.ts` / index middleware on `/api/*` only).
- **Sessions:** store SHA-256 hex of raw token only; never raw token. `expires_at` via SQL `datetime('now', '+14 days')`; resolve with `expires_at > datetime('now')`.
- **Cookies:** `gestao_session` HttpOnly + Secure + SameSite=Lax + Path=/ on set **and** clear (Max-Age=0).
- **Passwords:** PBKDF2-SHA-256 100k, hex salt/hash, timing-safe verify; length 8..1024 at crypto + Zod boundaries.
- **Platform gate:** `users.role === 'super_admin'` only — membership `papel` never elevates.
- **Multi-row writes:** empresa + first admin user + membership in a single `db.batch`.
- **Bootstrap:** secrets `SUPER_ADMIN_*` only; never wrangler.jsonc vars; no password overwrite; no promote of existing user; pre-hash email collision check; middleware only under `/api/*`.
- **Hermetic tests:** export `createAuthApp(db)` / `createPlatformApp(db)` factories; node:sqlite + `0001_init.sql`.
