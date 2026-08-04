-- Multi-tenant domain schema (users/sessions + empresas hierarchy).
-- PRAGMA foreign_keys=ON is required at connection time (not set here).
-- Replace-in-place assumes fresh DB / wiped journal — not a forward migration on existing data.

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('super_admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

CREATE TABLE empresas (
  id TEXT PRIMARY KEY NOT NULL,
  nome TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE empresa_membros (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'membro')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, user_id)
);

CREATE TABLE experts (
  id TEXT PRIMARY KEY NOT NULL,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (id, empresa_id)
);

CREATE INDEX idx_experts_empresa ON experts(empresa_id);

CREATE TABLE campanhas (
  id TEXT PRIMARY KEY NOT NULL,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  expert_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('lancamento_pago', 'gratuito', 'perpetuo', 'webinario')),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'encerrada', 'arquivada')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (id, empresa_id),
  FOREIGN KEY (expert_id, empresa_id) REFERENCES experts(id, empresa_id)
);

CREATE INDEX idx_campanhas_empresa ON campanhas(empresa_id);
CREATE INDEX idx_campanhas_expert ON campanhas(expert_id);

CREATE TABLE tarefas (
  id TEXT PRIMARY KEY NOT NULL,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  campanha_id TEXT NOT NULL,
  titulo TEXT NOT NULL,
  notas TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'a_fazer' CHECK (status IN ('a_fazer', 'fazendo', 'feito')),
  prazo TEXT,
  dono_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (campanha_id, empresa_id) REFERENCES campanhas(id, empresa_id)
);

CREATE INDEX idx_tarefas_empresa ON tarefas(empresa_id);
CREATE INDEX idx_tarefas_campanha ON tarefas(campanha_id);
CREATE INDEX idx_tarefas_dono ON tarefas(dono_id);
CREATE INDEX idx_tarefas_status ON tarefas(status);
