-- Forward: provider-native model selection for per-empresa LLM settings.
-- Nullable keeps legacy settings rows valid and preserves the provider default.

ALTER TABLE empresa_llm_settings ADD COLUMN model_id TEXT;
