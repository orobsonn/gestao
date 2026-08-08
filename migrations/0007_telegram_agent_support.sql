-- Forward: telegram webhook dedup (update_id PK), DM active empresa pin (pending_boundary 0|1), and one-shot turn context bridge (ciphertext+iv, composite nullable expert FK).
-- No PRAGMA; forward only.

CREATE TABLE telegram_webhook_updates (
  update_id TEXT PRIMARY KEY NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE telegram_dm_active_empresa (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  pending_boundary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE telegram_agent_turn_context (
  turn_token TEXT PRIMARY KEY NOT NULL,
  empresa_id TEXT NOT NULL REFERENCES empresas(id),
  expert_id TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  surface TEXT NOT NULL CHECK (surface IN ('topic', 'dm')),
  provider TEXT NOT NULL,
   api_key_ciphertext TEXT NOT NULL,
   api_key_iv TEXT NOT NULL,
   dm_boundary_line TEXT,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (expert_id, empresa_id) REFERENCES experts(id, empresa_id)
);
