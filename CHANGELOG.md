# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

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
