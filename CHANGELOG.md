# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.11.0] - 2026-08-08

### Added

- Bot Telegram via Flue: tools de domínio (tarefas/membros/notify/pin DM), memória de sessão por tópico/DM
- Migration `0007` (dedup webhook, pin DM, turn-context one-shot com api key cifrada)
- Gates de ator, LLM por empresa, pin multi-empresa e composição deploy (flue build + DO FlueGestaoBotAgent/FlueRegistry)
- Secret guard no agent HTTP (`GESTAO_AGENT_INTERNAL_SECRET`); body Flue só `{message}` + turn-token

## [0.10.0] - 2026-08-05

### Added

- Vínculo Telegram grupo/tópico: comandos copiáveis `/vincular_empresa` e `/vincular_expert` na aba Admin
- Migration `0006` (`telegram_bind_codes`, `empresa_telegram_chats`, `expert_telegram_topics`) e resolução de contexto só por mapa
- Webhook aplica binds com rejeição sem sobrescrever vínculo alheio; e2e Admin Telegram

## [0.9.1] - 2026-08-05

### Added

- Desvincular Telegram na Minha conta: botão só quando vinculado (sem confirmação)
- API `DELETE /api/auth/telegram-link` (sessão, 204 idempotente) com burn de códigos mint não usados
- Toast de sucesso só após a sessão confirmar `linked === false`

## [0.9.0] - 2026-08-05

### Added

- Vínculo Telegram DM: deep link em Minha conta + webhook `/start` com código de uso único
- Migration user-scoped `telegram_link_codes` / `user_telegram_links` e secrets `TELEGRAM_*`
- API mint `POST /api/auth/telegram-link` e `me.telegram.linked`

## [0.8.0] - 2026-08-04

### Added

- Tela Admin com abas Pessoas (criar usuário/senha/papel) e IA (OpenAI|Anthropic + Validar)
- API de settings LLM por empresa com chave cifrada AES-GCM e health claro
- Migration `empresa_llm_settings` e secret `LLM_KEY_ENCRYPTION_SECRET`
- E2E Admin (`tests/e2e/web-admin.spec.ts`) — local e prod

## [0.7.0] - 2026-08-04

### Added

- Telas Experts → Campanha → Tarefa (lista com contagens atrasadas/abertas, filtros status+dono)
- Create de expert e campanha (admin); CRUD de tarefa para qualquer membro
- Detalhe de tarefa com salvar e exclusão direta (sem modal)
- Breadcrumb hierárquico no shell para a navegação de domínio
- Contagens `abertas`/`atrasadas` em `GET /api/empresa/experts` (paridade com a home)
- Suíte e2e de domínio (`tests/e2e/web-domain.spec.ts`)

### Fixed

- Typecheck estrito (`tsc -b`) nas telas de domínio

## [0.6.0] - 2026-08-04

### Added

- Home dashboard por papel (admin dual + toggle Tudo|Só meu|Só empresa; membro só Meu trabalho)
- API `GET /api/empresa/home` com KPIs, gráficos e listas (atrasadas no topo)
- Stub navegável de detalhe de tarefa (`/tarefas/:id`)
- Seed e2e com tarefas de amostra e suíte Playwright da home

### Changed

- PATCH de tarefa só atualiza `updated_at` quando o status realmente muda (KPI feitas 7d)

## [0.5.0] - 2026-08-04

### Added

- Casco web com shadcn/ui + Tailwind (kit fechado do PRD) e tema light/dark/system
- Login, seletor de empresa ativa e navegação (Home, Experts, Meu trabalho, Admin)
- Admin na sidebar só para papel admin da casa ativa; `/platform` fora do casco
- Suíte hermética `tests/web-shell-*.test.mjs` (nav, sessão, kit, rotas)

## [0.4.0] - 2026-08-04

### Added

- API multi-tenant Expert → Campanha → Tarefa sob `/api/empresa/*` (isolamento por empresa ativa)
- Só admin cria/edita/exclui expert e campanha; qualquer membro CRUD de tarefa com exclusão direta
- Migration `0003`: campos opcionais de campanha (`data_inicio`, `data_fim`, `notas`)
- Soft-delete com 409 se houver filhos vivos; DELETE idempotente no tombstone (sem oracle cross-tenant)
- Suíte hermética de domínio (migrations, experts, campanhas, tarefas)

### Changed

- Migration `0002` vira stub no-op (coluna `active_empresa_id` já em `0001`); chain full-apply em testes

## [0.3.0] - 2026-08-04

### Added

- Sessão multi-empresa: `sessions.active_empresa_id`, auto-seleção no login (1 membership), `POST /api/auth/active-empresa`
- APIs de membros da casa: `GET/POST /api/empresa/membros` com `requireActiveEmpresa` / `requireEmpresaAdmin`
- Convite de e-mail existente sem alterar senha; resposta `created` distingue alta vs convite
- Adapter D1 com `all()` para leituras multi-linha

### Changed

- `GET /api/auth/me` e login passam a expor memberships e empresa ativa
- Clear TOCTOU-safe de empresa ativa stale (`clearActiveEmpresaIf`)

## [0.2.0] - 2026-08-04

### Added

- Super-admin da plataforma: bootstrap por secrets, login/sessão, provisionar Empresa + primeiro admin
- API `POST /api/platform/empresas` (só `users.role=super_admin`) e UI mínima `/platform`
- Primitivas de auth (PBKDF2, sessão cookie HttpOnly, logout server-side)

## [0.1.0] - 2026-08-04

### Added

- Schema D1 multi-tenant: Empresa → Expert → Campanha → Tarefa, com isolamento por empresa e FKs compostas
- Vocabulário TypeScript compartilhado (`src/shared/domain/enums.ts`)
- Testes herméticos do contrato de schema (`node:test` + `node:sqlite`)

### Removed

- Tabelas genéricas `projects` / `tasks` do esboço inicial (substituídas pelo domínio do produto)
