-- Per-empresa LLM provider settings (encrypted key material + validation status; ciphertext/iv pairing CHECK).
-- One row per empresa. Metadata status 'none' = no row (API layer), never stored here.

CREATE TABLE empresa_llm_settings (
  empresa_id TEXT PRIMARY KEY NOT NULL REFERENCES empresas(id),
  provider TEXT CHECK (provider IN ('openai', 'anthropic')),
  api_key_ciphertext TEXT,
  api_key_iv TEXT,
  status TEXT NOT NULL CHECK (status IN ('unvalidated', 'valid', 'invalid')),
  validated_at TEXT,
  last_error TEXT,
  CHECK (
    (api_key_ciphertext IS NULL AND api_key_iv IS NULL)
    OR (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL)
  )
);
