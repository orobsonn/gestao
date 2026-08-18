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
- **Hermetic tests:** export `createAuthApp(db)` / `createPlatformApp(db)` / `createEmpresaApp(db)` factories; node:sqlite + full migration chain (`migrations/*.sql` sorted lexically, `PRAGMA foreign_keys=ON`).
- **Telegram unlink:** `DELETE /api/auth/telegram-link` behind `requireSession`; batch hard-DELETE `user_telegram_links` + burn unused `telegram_link_codes` for session `user.id` only; always **204** empty body; never return `telegram_user_id`.

## LLM settings (`empresa_llm_settings`)

- **Two model formats, deliberately opposite:** `empresa_llm_settings.model_id` is **provider-native**
  (`gpt-4o-mini`); `telegram_agent_turn_context.model_id` is **provider-namespaced**
  (`openai/gpt-4o-mini`). `resolveEmpresaLlmTurnModel` is the only bridge. There is NO format guard
  on the write — `insertTurnContext` stores what the orchestrator passes, so the caller owns the
  contract.
- **Curated catalog is a second source of truth — pin it.** Every id in `llm-model-catalog.ts` must
  resolve in the bundled `@earendil-works/pi-ai` registry with a non-zero token budget. An id that
  is a real provider model but unknown to the registry resolves to zero metadata, so the request
  goes out with `max_tokens: 0` and every turn fails while the dashboard still says "saved" and
  "valid". Pinned by `lt-catalog-models-resolve-in-runtime`.
- **Each provider's locked default must be a catalog member**, or a legacy empresa cannot select
  the model it is running on and clearing becomes a one-way door.
- **PUT body is a `.strict()` exclusive union**: either `{provider, api_key}` or
  `{model_id: string | null}`. `null` clears back to the default; the empty string is rejected —
  persisting it would make the gate unable to resolve and the empresa's bot go silent.
- **The model CAS predicate carries provider AND key identity AND the prior model**
  (`WHERE empresa_id = ? AND provider = ? AND api_key_ciphertext IS ? AND <normalized model_id> IS ?`),
  with `RETURNING` and **no retry**. Provider alone is not enough: rotating the key of the same
  provider deliberately resets `model_id`, and a PUT in flight would otherwise re-attach a model to
  the fresh credential. Normalize the stored value **in SQL** to match what `loadSettingsRow`
  returned — comparing a trimmed value against a raw column makes a padded row unsaveable forever.
- A credential PUT always resets `model_id` to NULL and `status` to `unvalidated`; the dashboard
  must re-read the model from the response rather than keep its own pick.
- **Never register a tenant credential under the canonical provider id, and scope the slot by
  EMPRESA.** Flue's provider registry is module-scoped and last-write-wins, and the key is resolved
  lazily on every model call — so any shared id lets another turn swap an in-flight turn onto a
  different empresa's account. `.flue/agents/gestao-bot.ts` registers under
  `<provider>--<hex empresa id>--<hex native model>`. Scoping by AGENT is NOT enough: a DM's agent
  id is `dm:<userId>`, agnostic of empresa, so a user who belongs to two empresas would collapse
  both credentials onto one slot. Pinned by `lt-turn-provider-isolated-per-empresa`.
- **A provider id outside Flue's catalog resolves to ZERO metadata**, so the registration must
  carry `api`/`baseUrl`/`maxTokens`/`contextWindow` from the canonical entry or the request goes
  out with `max_tokens: 0`. Note what an `HttpProviderRegistration` canNOT carry: `cost`,
  `reasoning`, `input` and `compat` are zeroed by construction under any non-catalog id. Per-turn
  cost telemetry therefore reads zero, and a reasoning model is treated as non-reasoning.
  Because `reasoning` is zeroed, the `thinkingLevelMap` branch in the wire builders is
  UNREACHABLE — the live loss is **`compat`**. Concretely: `claude-sonnet-4-6`,
  `claude-sonnet-5` and `claude-opus-4-8` carry `compat.forceAdaptiveThinking`, whose absence
  means every anthropic turn currently ships the `anthropic-beta: interleaved-thinking-2025-05-14`
  header that pi-ai suppresses on purpose for those models; and `claude-opus-4-8` carries
  `compat.supportsTemperature: false`, latent until someone sets a temperature.
  **OPERATOR DECISION, NOT TAKEN HERE:** a "no curated id may carry compat" guard would evict
  `claude-sonnet-4-6`, which is the locked anthropic default. Choosing between moving that default
  (only `claude-haiku-4-5` has no compat) and accepting the loss is the operator's call.
  Pass `telemetry.providerName` so observability aggregates by `openai`/`anthropic` — note the
  event's `providerId` still carries the derived id, so this is aggregation, not containment.
- **There is NO per-turn output-token ceiling.** The registration passes the canonical
  `maxTokens` straight through, so switching `gpt-4o-mini` (16384) to `gpt-5.6-sol` (128000) in the
  dashboard multiplies the ceiling ~8x and the input price ~33x with one dropdown and no redeploy —
  and because `cost` is zeroed, per-turn telemetry reads zero, so the change is invisible. A
  ceiling is an operator decision and is not specified; do not invent a value.
- **Residual, tracked in #79:** the DO-local `turnCache` in `.flue/agents/gestao-bot.ts` is keyed by
  AGENT id, not empresa. A multi-empresa DM user (`dm:<userId>`) can still be served the previous
  turn's context from it when the turn row is gone. The per-empresa provider slot bounds the
  credential, not that cache — do not read the empresa scoping above as covering it.
- **The registry has no unregister:** it accumulates one decrypted key per (empresa, provider,
  model) for the lifetime of an isolate, and the Worker isolate is shared across all tenants.
  Growth is O(empresas served).

## Domain CRUD (experts / campanhas / tarefas)

- **Compose into `createEmpresaApp`:** each domain module exports `registerXRoutes(app, db)` and is wired inside `createEmpresaApp` — single `/api/empresa/*` surface; do not add parallel dispatch in `index.ts`.
- **Tenant scope:** always from `sessions.active_empresa_id` via `requireActiveEmpresa` — never client-supplied empresa id.
- **Authz:** experts/campanhas writes use `requireEmpresaAdmin`; tarefas are full CRUD for any member (no admin gate). Reads for all three: any active member.
- **Soft-delete (LD-16 DELETE/GET split):** DELETE on own tombstone → **204** idempotent; GET/list/PATCH require `deleted_at IS NULL` → **404** `{error:'Not found'}`. Never-existed UUID and other-tenant id share the same 404 body (no existence oracle).
- **Parent delete with children:** experts (live campanhas) and campanhas (live tarefas) → atomic `UPDATE … AND NOT EXISTS (live children)` then **409** `{error:'Has children'}` if still live; tarefas have no children.
- **Create under parent:** atomic `INSERT … SELECT` from live parent same-tenant (`deleted_at IS NULL`) — parent miss / soft-deleted / other-tenant → **404** Not found (no check-then-act race).
- **PATCH:** Zod `.strict()` allowlist only; unknown keys → 400; `null` clears optional nullable fields (dates, dono_id); re-read after UPDATE.
- **tarefas updated_at:** bump `updated_at = datetime('now')` only when `status` is present **and** differs from the live row (completion window for `feitas_7d`, not activity).
- **Home route:** `GET /api/empresa/home` via `registerHomeRoutes` inside `createEmpresaApp`; any active member; membro fail-closed (empresa KPIs zero, `empresa_abertas=[]`, charts scoped to `dono=viewer`).
- **Expert list counts:** `GET /api/empresa/experts` enriches each row with `abertas`/`atrasadas` using the same open-task predicates as home (`deleted_at IS NULL`, `status != 'feito'`, late = `prazo < date('now')`); never filter `campanhas.status`.
- **IDs:** server `crypto.randomUUID()`; never trust client id on create. `created_by` on tarefas is session user id only.
