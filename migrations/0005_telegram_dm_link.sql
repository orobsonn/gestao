-- User-scoped Telegram DM link: one-time codes + permanent user↔telegram binding.
-- No empresa_id — link is global per user account (not per-tenant).

CREATE TABLE telegram_link_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_telegram_link_codes_user ON telegram_link_codes(user_id);

CREATE TABLE user_telegram_links (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_telegram_link_codes_one_unused_per_user
  ON telegram_link_codes(user_id)
  WHERE used_at IS NULL;
