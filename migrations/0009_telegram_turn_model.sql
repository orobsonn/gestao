-- Forward: provider-NAMESPACED resolved model (e.g. openai/gpt-4o-mini) carried by a single encrypted Telegram turn context.
-- Nullable preserves compatibility with contexts created before model selection.

ALTER TABLE telegram_agent_turn_context ADD COLUMN model_id TEXT;
