CREATE TABLE telegram_agent_reply_sends (
  answered_by_submission_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
