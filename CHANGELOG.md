# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.1.0] - 2026-08-04

### Added

- Schema D1 multi-tenant: Empresa → Expert → Campanha → Tarefa, com isolamento por empresa e FKs compostas
- Vocabulário TypeScript compartilhado (`src/shared/domain/enums.ts`)
- Testes herméticos do contrato de schema (`node:test` + `node:sqlite`)

### Removed

- Tabelas genéricas `projects` / `tasks` do esboço inicial (substituídas pelo domínio do produto)
