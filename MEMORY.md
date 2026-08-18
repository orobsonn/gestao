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
- [session-active-empresa-pointer](#session-active-empresa-pointer) — sessions.active_empresa_id is a user-scoped nullable pointer (single-column FK), not a tenant-owned child; do not composite-FK it
- [login-auto-select-one-membership](#login-auto-select-one-membership) — login sets active_empresa only when exactly one non-deleted membership; 0 or N>1 leaves null until POST active-empresa
- [toctou-clear-active-empresa](#toctou-clear-active-empresa) — invalidate stale active_empresa with conditional UPDATE … AND active_empresa_id = expected, never blind NULL
- [atomic-live-parent-insert](#atomic-live-parent-insert) — child create via INSERT…SELECT live same-tenant parent; never check-then-act; 0 changes → 404
- [atomic-parent-soft-delete](#atomic-parent-soft-delete) — parent soft-delete UPDATE…AND NOT EXISTS live children; map 0 changes to 404/204/409
- [soft-delete-no-existence-oracle](#soft-delete-no-existence-oracle) — own tombstone DELETE 204; other-tenant and never-existed share identical 404 body
- [dual-axis-papel-vs-role](#dual-axis-papel-vs-role) — shell Admin nav/route = active membership papel only; platform UI = users.role super_admin only; never cross-wire
- [after-auth-mutation-get-me](#after-auth-mutation-get-me) — after login or setActiveEmpresa success always GET /api/auth/me; never treat mutation JSON as full me
- [set-active-empresa-optimistic-gen](#set-active-empresa-optimistic-gen) — optimistic active_empresa_id + request generation; keep on 5xx; clear me on 401; lock picker clicks
- [platform-spa-outside-shell](#platform-spa-outside-shell) — /platform outside shell RequireAuth and empresa picker; page self-gates super_admin
- [shadcn-cn-not-utils](#shadcn-cn-not-utils) — shadcn cn helper at lib/cn.ts; components.json utils alias @/lib/cn; never lib/utils.ts
- [status-transition-updated-at](#status-transition-updated-at) — tarefas.updated_at bumps only on real status change; feitas_7d is completion window not activity
- [home-fetch-active-empresa](#home-fetch-active-empresa) — tenant SPA pages key fetch on me.active_empresa_id and cancel stale in-flight responses
- [open-task-count-predicates](#open-task-count-predicates) — abertas/atrasadas shared home↔experts list: live deleted_at IS NULL; open status!=feito; late prazo past; never filter campanhas.status
- [shell-domain-breadcrumb](#shell-domain-breadcrumb) — hierarchical Experts→… trail owned by AppShell; pages only inject names via useDomainBreadcrumbNames (clear-on-unmount)
- [route-bound-parent-ids](#route-bound-parent-ids) — create under expert/campanha binds parent id from the route; nested campanha.expert mismatch → canonical redirect
- [campanha-task-filters-delete](#campanha-task-filters-delete) — campaign task list filters are status+dono only; task delete is direct (no confirm modal)
- [telegram-link-user-global](#telegram-link-user-global) — user↔Telegram link is account-global (no empresa_id); multi-empresa shares one Telegram identity
- [partial-unique-one-unused-code](#partial-unique-one-unused-code) — at most one unused link code per user via partial UNIQUE WHERE used_at IS NULL + mint invalidate batch
- [telegram-webhook-atomic-claim](#telegram-webhook-atomic-claim) — webhook claim+bind atomic (D1 batch / BEGIN IMMEDIATE); secret fail-closed; always-200 after secret OK
- [me-telegram-linked-boolean-only](#me-telegram-linked-boolean-only) — client sees only telegram.linked boolean; never telegram_user_id, code, or bot token
- [telegram-unlink-burn-codes](#telegram-unlink-burn-codes) — DELETE unlink hard-removes link + burns unused mint codes in one batch; 204 empty; session user only
- [bind-code-reject-without-claim](#bind-code-reject-without-claim) — one-shot bind codes: pre-check map conflicts before claim (or unclaim on reject); D1 batch must not burn code without map
- [partial-unique-no-null-key](#partial-unique-no-null-key) — SQLite partial UNIQUE never keys a NULL-able column alone; split indexes by kind with non-null keys
- [telegram-forum-reply-thread-id](#telegram-forum-reply-thread-id) — Bot API sendMessage inside a forum topic must include message_thread_id or the reply lands in General
- [bot-session-id-stable](#bot-session-id-stable) — agent session ids are `tp2:{chat}:{thread}` / `dm2:{empresaId}:{userId}` (String-canonical, empresa-scoped DM), never random UUID per message
- [bot-tenant-closure-not-model](#bot-tenant-closure-not-model) — tool tenant scope comes only from closure (binding/pin/actor), never model-supplied empresa_id
- [turn-context-attributes-not-d1](#turn-context-attributes-not-d1) — the D1 turn-context bridge is deleted; the turn's non-secret facts ride the dispatched signal's `attributes`, the API key is resolved inside the DO
- [flue-deploy-is-plain-wrangler](#flue-deploy-is-plain-wrangler) — `flue build` does not exist in 2.x; deploy is plain `wrangler deploy` from the project root via the `.wrangler/deploy/config.json` redirect written by `vite build`; `npm run deploy` is the only sanctioned invocation
- [d1-run-changes-dual-shape](#d1-run-changes-dual-shape) — stmt.run() changes may be `{changes}` (node:sqlite) or `{meta.changes}` (D1); normalize both
- [flue-vite-pi-ai-pin-cascade](#flue-vite-pi-ai-pin-cascade) — `@flue/vite` peers `vite ^8`, cascading `@cloudflare/vite-plugin`/`@vitejs/plugin-react`/`wrangler`; `@earendil-works/pi-ai` must pin `0.83.0` EXACT (never a caret range) or npm resolves 2-3 distinct copies and forks the provider registry `setProvider()`/`useModel()` read from

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

---

## session-active-empresa-pointer

**Why:** `sessions` is user-scoped auth state, not a row owned by a tenant. Applying the composite-tenant FK pattern here is wrong — the session points *at* an empresa optionally. Soft-delete/membership loss is enforced in app middleware.

**How to apply:** Keep `sessions.active_empresa_id TEXT REFERENCES empresas(id)` nullable single-column. Declare `sessions` **after** `empresas` in `0001_init.sql`. Tenant handlers still re-check membership + `deleted_at IS NULL` via `requireActiveEmpresa`. See `src/worker/auth/session.ts`.

---

## login-auto-select-one-membership

**Why:** Multi-empresa must not silently bind to an arbitrary house. Auto-pick when N>1 scopes the wrong tenant; null when N=1 forces a useless round-trip.

**How to apply:** After login memberships (non-deleted only): length === 1 → set active; 0 or >1 → null + return memberships for `POST /api/auth/active-empresa`. Never accept client empresa id on login body. See LD-9.

---

## toctou-clear-active-empresa

**Why:** Between “read stale active” and “clear it”, another request can switch to a valid house. Blind `SET NULL` wipes the concurrent switch.

**How to apply:** Always `clearActiveEmpresaIf(db, rawToken, expectedEmpresaId)` — conditional UPDATE on token_hash + active_empresa_id = expected. Use on `/me` stale path and `requireActiveEmpresa` failure paths.

---

## atomic-live-parent-insert

**Why:** Check-then-act (`SELECT` live parent, then `INSERT` child) races with concurrent parent soft-delete and leaves live children under tombstoned parents.

**How to apply:** Create children with `INSERT…SELECT … FROM parent WHERE id=? AND empresa_id=? AND deleted_at IS NULL`. If `changes === 0`, return 404 (same body as unknown id). See `campanhas.ts` / `tarefas.ts` POST handlers.

---

## atomic-parent-soft-delete

**Why:** Separate “count live children” then “soft-delete parent” races with concurrent child create and orphans hierarchy navigation.

**How to apply:** One `UPDATE parent SET deleted_at=… WHERE … AND deleted_at IS NULL AND NOT EXISTS (live children)`. On 0 changes, re-read: missing → 404; tombstone → 204; live → 409 Has children. See `experts.ts` / `campanhas.ts` DELETE.

---

## soft-delete-no-existence-oracle

**Why:** Returning 200 for “already deleted” on random UUIDs while 404 on other-tenant ids leaks whether a foreign id exists.

**How to apply:** DELETE succeeds (204) only when a row exists for `(id, active_empresa_id)` including tombstones. Never-existed and other-tenant share identical 404 body. GET/PATCH of tombstones stay 404.

---

## dual-axis-papel-vs-role

**Why:** `users.role` is platform authority; `memberships[].papel` is tenant authority. Wiring Admin nav to `super_admin` or platform create to `papel=admin` breaks isolation.

**How to apply:** Shell Admin item + `/admin` guard use only `resolveActivePapel` / `canAccessAdmin(activePapel)`. Platform create uses `canShowPlatformCreate(users.role)`. Never pass `me.role` into `buildSidebarNavItems`.

---

## after-auth-mutation-get-me

**Why:** Login and active-empresa responses are partial; treating them as full `me` drops `name`/`role` and breaks dual-axis UI.

**How to apply:** After successful login or setActiveEmpresa, always `GET /api/auth/me` before exposing session to UI. Login body is never full me.

---

## set-active-empresa-optimistic-gen

**Why:** POST can succeed while GET /me fails or races with a second switch, leaving UI on tenant A and server on B.

**How to apply:** Optimistic `active_empresa_id` after POST ok; monotonic request gen so stale getMe cannot overwrite; on 401 clear me; on 5xx keep optimistic; lock picker while in flight.

---

## platform-spa-outside-shell

**Why:** Super_admin often has zero memberships; wrapping `/platform` in shell RequireAuth or empresa picker blocks house provisioning.

**How to apply:** Register `/platform` outside RequireAuth and outside EmpresaPicker. Page self-gates via `canShowPlatformCreate`. Unauth `/platform` is not forced to `/login` by shell redirect helpers.

---

## shadcn-cn-not-utils

**Why:** AGENTS forbids generic `utils.ts`; shadcn CLI defaults to `@/lib/utils`.

**How to apply:** Export `cn` from `src/react-app/lib/cn.ts`. Set `components.json` aliases.utils to `@/lib/cn`. Never create `lib/utils.ts`.

---

## status-transition-updated-at

**Why:** Home KPI `feitas_7d` uses `date(updated_at)` as a completion window. Bumping `updated_at` on every PATCH (or no-op status re-save) turns the metric into an activity counter and lets old completions re-enter the 7-day window.

**How to apply:** On `PATCH /api/empresa/tarefas/:id`, set `updated_at = datetime('now')` only when `status` is present **and** differs from the live row's current status. Titulo/notas/prazo/dono-only patches must not touch `updated_at`.

---

## home-fetch-active-empresa

**Why:** After sidebar empresa switch, a mounted Home (or any tenant page) that fetched once on mount keeps the previous tenant's KPIs/lists; a late in-flight response can also overwrite the new tenant.

**How to apply:** Key the load `useEffect` on `me.active_empresa_id`. Clear local data on change. Use a cancelled/generation flag so only the latest fetch may `setState`.

---

## open-task-count-predicates

**Why:** Experts list badges and Home “atrasadas por expert” must agree. Filtering by `campanhas.status` (or treating “live” as campanha-open) splits the work contract across screens.

**How to apply:** Open task = `t.deleted_at IS NULL AND t.status != 'feito'`. Late = open + `prazo IS NOT NULL AND prazo < date('now')`. Join parents only for expert_id scope — **never** `campanhas.status`. Same predicates in `listExperts` counts and `home.ts` (`countOpenMetric` / `buildAtrasadasPorExpert`). Locked in `tests/domain-experts.test.mjs`.

---

## shell-domain-breadcrumb

**Why:** Nested domain routes (`/experts/:id/campanhas/:id`) used to fall through to a single “Gestão” title. Page-local trails diverge from the shell chrome e2e asserts against.

**How to apply:** `AppShell` owns `nav[aria-label=breadcrumb]` via `resolveDomainBreadcrumbSegments` + page names. Pages call `useDomainBreadcrumbNames({ expert, campanha, tarefa })` after load; the hook clears on unmount so labels never stick on `/experts`. Do not duplicate hierarchical trails inside pages.

---

## route-bound-parent-ids

**Why:** A free expert picker on “create campanha” or a deep link with mismatched `expertId`/`campanha.expert_id` shows the wrong tree and wrong back navigation.

**How to apply:** Create campanha/tarefa bodies take parent id from the route only (`buildCreateCampanhaBody(routeExpertId, …)`). After GET campanha, `resolveCampanhaRouteIntegrity` → redirect to `/experts/{campanha.expert_id}/campanhas/{id}` on mismatch. Tarefa back path = GET tarefa → GET campanha → campaign list.

---

## campanha-task-filters-delete

**Why:** PRD locks campaign list filters to status + dono (no campaign filter inside a campaign). Task delete is intentionally direct (no confirm) for web and bot parity.

**How to apply:** UI filter controls = exactly `CAMPANHA_TASK_FILTER_CONTROL_IDS` (`status`, `dono`); client `filterTarefas`. `TAREFA_DELETE_REQUIRES_CONFIRMATION = false`; Excluir calls DELETE immediately then navigates to the campaign list.

---

## telegram-link-user-global

**Why:** Telegram identity is a person, not a tenant membership. Putting `empresa_id` on the link would force re-link per house and break multi-empresa DM notify.

**How to apply:** `user_telegram_links` / `telegram_link_codes` are user-scoped only (FK → users, no empresa_id). One Telegram per user, one user per Telegram (UNIQUE).

---

## partial-unique-one-unused-code

**Why:** Concurrent mints can leave two unused codes if only soft-invalidate then insert without a DB constraint.

**How to apply:** Partial UNIQUE index on `telegram_link_codes(user_id) WHERE used_at IS NULL`. Mint invalidates prior unused in the same batch as insert; retry once on UNIQUE.

---

## telegram-webhook-atomic-claim

**Why:** Check-then-act claim or claim-then-bind without a transaction burns codes or unlinks users under concurrency/Telegram retries.

**How to apply:** Conditional `UPDATE … used_at IS NULL AND expires_at > now` with `changes===1`; bind (UPSERT) in the same immediate txn/batch. Require `TELEGRAM_WEBHOOK_SECRET` (401 if missing/mismatch). After secret OK always HTTP 200 to Telegram.

---

## me-telegram-linked-boolean-only

**Why:** Exposing `telegram_user_id` or code material on `/me` leaks identifiers and expands the client attack surface.

**How to apply:** `GET /api/auth/me` returns only `telegram: { linked: boolean }`. Raw code appears once in mint `deep_link`; DB stores SHA-256 only.

---

## telegram-unlink-burn-codes

**Why:** Unlink that only deletes `user_telegram_links` leaves unused mint codes valid until TTL — a leaked deep_link could re-bind after the user unlinked.

**How to apply:** `DELETE /api/auth/telegram-link` (session) batches hard-DELETE of the session user's link row **and** `UPDATE telegram_link_codes SET used_at=now() WHERE user_id=? AND used_at IS NULL`. Always **204** empty body (idempotent). Never return `telegram_user_id`.

---

## bind-code-reject-without-claim

**Why:** A D1 path that `UPDATE used_at` in its own batch, then checks map conflicts and fails, burns the one-shot code with no binding. Hermetic `BEGIN IMMEDIATE` + ROLLBACK tests stay green and hide the prod hole.

**How to apply:** Pre-check chat_taken / already_linked / wrong_chat / thread_taken / soft-delete **before** claim (or unclaim on reject). Redelivery: used code + map already matching target → success. See `telegram-bind-empresa.ts` / `telegram-bind-expert.ts` claimViaBatch.

---

## partial-unique-no-null-key

**Why:** SQLite UNIQUE treats every NULL as distinct, so `UNIQUE(empresa_id, expert_id) WHERE used_at IS NULL` does not enforce one unused empresa code when expert_id is NULL.

**How to apply:** Split partial indexes: `UNIQUE(empresa_id) WHERE used_at IS NULL AND kind='empresa'` and `UNIQUE(expert_id) WHERE used_at IS NULL AND kind='expert'`, plus CHECK pairing kind↔expert_id. Pattern in `migrations/0006_telegram_grupo_topico.sql`.

---

## telegram-forum-reply-thread-id

**Why:** In Telegram forum groups, `sendMessage` without `message_thread_id` posts to General — admin who pasted `/vincular_expert` in a topic never sees the success/error reply in-place.

**How to apply:** When the inbound update has `message.message_thread_id`, pass it through on Bot API sendMessage. Extend `sendTelegramMessage(chatId, text, threadId?)`.

---

## bot-session-id-stable

**Why:** Random session ids per message break Flue agent memory continuity across turns on the same topic/DM. A DM id keyed on `userId` alone also collapses two empresas' turns for the same Telegram user onto one Durable Object.

**How to apply:** `buildSessionId({ kind:'topic', chatId, threadId })` → `tp2:{String(chat)}:{String(thread)}`; `buildSessionId({ kind:'dm', empresaId, userId })` → `dm2:{String(empresaId)}:{String(userId)}` — constructing a DM id without an `empresaId` throws. Canonicalize ids with `String()` so number/string parity holds. See `src/worker/services/build-session-id.ts` and `tests/build-session-id.test.mjs`.

---

## bot-tenant-closure-not-model

**Why:** Model-supplied `empresa_id` / expert ids are an authz bypass vector for multi-tenant tools.

**How to apply:** `createGestaoBotTools(closure)` fixes `empresa_id`, `expert_id`, `actor_user_id`, `surface` from orchestrator gates only. Tool inputs never authorize tenant scope. Topic campanha must match closure expert (LD-22).

---

## turn-context-attributes-not-d1

**Why:** The D1 turn-context bridge (`telegram_agent_turn_context`, dropped by migration `0011`) was a `turn_token` PRIMARY KEY keyed by the shared topic agent id — a second user's message in the same window collided on that key, dropped the message, and could wedge the topic permanently. Flue 2.x's `init(GestaoBot, { id })` dispatch has no D1/HTTP hop to bridge through.

**How to apply:** The orchestrator (`buildSignalAttributes` in `bot-turn-orchestrator.ts`) dispatches `{ kind: 'signal', type: 'telegram.message', body, attributes }` where `attributes` is a closed `Record<string,string>` of `empresaId`, `expertId`, `actorUserId`, `surface`, `provider`, `modelId`, `dmBoundaryLine` — **no key material**, every value is emitted verbatim into the model's context. `GestaoBot` reads `useDelivery().attributes` and resolves+decrypts the empresa's LLM API key itself inside the Durable Object via `loadEmpresaLlmForBot` — the key never travels on the signal. See `tests/flue2-signal-attributes.test.mjs`.

---

## flue-deploy-is-plain-wrangler

**Why:** `flue build` does not exist in Flue 2.x — `@flue/vite`'s `flue()` + `cloudflare({ config: flueWorkerConfig() })` plugin pair generates the Worker entry and `dist/gestao/wrangler.json` as part of `vite build` itself, and writes a redirect at `.wrangler/deploy/config.json` that points a plain `wrangler deploy` (run from the project root) at that generated config — no `--config` flag, no separate Flue CLI step.

**How to apply:** `npm run deploy` (`wrangler deploy`) is the **only sanctioned invocation**. It is preceded by `predeploy` (`clean:deploy-redirect && cf-typegen && build`), which wipes any stale `.wrangler/deploy` redirect and rebuilds from HEAD before wrangler resolves the redirect. Running raw `wrangler deploy` directly — skipping `npm run deploy` — skips `predeploy` and can publish a **stale `dist/`** together with whatever Durable-Object migration is currently declared, which is destructive if that migration deletes/renames a live DO class. `wrangler.jsonc` no longer authors `main` or any `FLUE_`-prefixed DO binding name — that surface is Flue-generated, not authored (locked by `tests/flue2-build-wiring.test.mjs`). For the migration-vs-deploy sequencing around a schema change that a still-live Worker reads, see "Deploy order for `0011_drop_telegram_agent_turn_context.sql`" in `migrations/AGENTS.md`.

---

## d1-run-changes-dual-shape

**Why:** Hermetic node:sqlite returns `{ changes }`; D1 returns `{ meta: { changes } }`. Claim/dedup logic that reads only one shape silently fails open or closed.

**How to apply:** Normalize via helper reading both shapes (see `runChanges` in gestao-bot-tools / claim helpers). Assert `changes === 1` for first-processor semantics.

---

## flue-vite-pi-ai-pin-cascade

**Why:** `@flue/vite@2.0.3` declares `peerDependencies: { vite: "^8.0.0" }`, so adding/upgrading Flue is never an isolated bump — it forces `vite` to `^8`, which forces `@cloudflare/vite-plugin` (peer `vite ^6.1|^7|^8`, needs `^1.53.0`+) and `@vitejs/plugin-react` (peer `vite ≤^7`, needs `^6.0.5`), which in turn needs `wrangler ^4.124.0+`. Separately, `@flue/runtime@2.0.3` depends on `@earendil-works/pi-ai: ^0.83.0` and `pi-agent-core: ^0.83.0` — pinning the project's OWN `pi-ai` dependency to anything outside that range (e.g. `0.84.2`) does not just risk a breaking API change, it makes npm resolve **multiple distinct copies** of the package in `node_modules` (measured: 3 copies at `0.84.2` vs 1 hoisted copy at `0.83.0`). `createProvider()`/`openaiProvider()` from one copy and the `Models` registry `setProvider()`/`useModel()` read/write from another copy are then two different module instances — it survives on structural typing alone until an `instanceof` check, module-level singleton, or symbol identity breaks silently.

**How to apply:** Any future `@flue/vite`/`@flue/runtime` upgrade must re-check the full peer cascade above (vite → cloudflare-plugin → plugin-react → wrangler) with `npm --package-lock-only` BEFORE committing, not just bump the one package the changelog mentions. Pin `@earendil-works/pi-ai` to the EXACT version `@flue/runtime` depends on (currently `0.83.0`, never a caret/tilde range) so only one copy is ever hoisted — verify with `npm ls @earendil-works/pi-ai` showing exactly one resolved version (should print exactly one line). Current pinned versions live in `package.json` (`vite`, `@flue/vite`, `@flue/runtime`, `@earendil-works/pi-ai`, `@cloudflare/vite-plugin`, `@vitejs/plugin-react`, `wrangler`).
