-- Telegram group/topic bindings for empresa (chat) and expert (topic/thread).
-- Composite tenant FKs + partial uniques for one-unused bind code per scope.

CREATE TABLE telegram_bind_codes (
  id TEXT PRIMARY KEY NOT NULL,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  kind TEXT NOT NULL CHECK (kind IN ('empresa', 'expert')),
  expert_id TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (expert_id, empresa_id) REFERENCES experts(id, empresa_id),
  CHECK ((kind='empresa' AND expert_id IS NULL) OR (kind='expert' AND expert_id IS NOT NULL))
);

CREATE INDEX idx_telegram_bind_codes_empresa ON telegram_bind_codes(empresa_id);

CREATE UNIQUE INDEX idx_telegram_bind_codes_one_unused_empresa
  ON telegram_bind_codes(empresa_id)
  WHERE used_at IS NULL AND kind = 'empresa';

CREATE UNIQUE INDEX idx_telegram_bind_codes_one_unused_expert
  ON telegram_bind_codes(expert_id)
  WHERE used_at IS NULL AND kind = 'expert';

CREATE TABLE empresa_telegram_chats (
  empresa_id TEXT PRIMARY KEY NOT NULL REFERENCES empresas(id),
  chat_id TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, chat_id)
);

CREATE TABLE expert_telegram_topics (
  expert_id TEXT PRIMARY KEY NOT NULL,
  empresa_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_thread_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chat_id, message_thread_id),
  FOREIGN KEY (expert_id, empresa_id) REFERENCES experts(id, empresa_id),
  FOREIGN KEY (empresa_id, chat_id) REFERENCES empresa_telegram_chats(empresa_id, chat_id)
);

CREATE INDEX idx_expert_telegram_topics_empresa ON expert_telegram_topics(empresa_id);
