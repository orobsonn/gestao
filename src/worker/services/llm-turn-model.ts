/** @description Resolves provider-native empresa model identifiers into namespaced turn models. */

export type TurnModelProvider = 'openai' | 'anthropic'

export const DEFAULT_TURN_MODELS: Record<TurnModelProvider, string> = {
  openai: 'openai/gpt-4o-mini',
  anthropic: 'anthropic/claude-sonnet-4-6',
}

/**
 * @description A stored model is usable only if it is a non-blank, provider-native identifier.
 *
 * An already-namespaced value would produce `openai/openai/x`, and a blank one `openai/` — both
 * fail validation two layers down, inside the turn path where the exception is swallowed by the
 * webhook. Treating them as unusable here degrades to the locked default instead.
 */
function isUsableProviderNativeModel(modelId: unknown): modelId is string {
  return typeof modelId === 'string' && modelId.length > 0 && !/[/\s]/.test(modelId)
}

/** @description Namespaces a persisted provider-native model or returns its locked legacy default. */
export function resolveEmpresaLlmTurnModel(
  provider: TurnModelProvider,
  modelId: string | null,
): string {
  // Normalize BEFORE testing: validating a trimmed value while interpolating the raw one would
  // emit `openai/gpt-4o-mini ` and throw two layers down, where the webhook swallows it.
  const native = typeof modelId === 'string' ? modelId.trim() : modelId
  return isUsableProviderNativeModel(native)
    ? `${provider}/${native}`
    : DEFAULT_TURN_MODELS[provider]
}

/**
 * @description Single normalization for a stored `empresa_llm_settings.model_id`.
 *
 * The settings route and the bot gate both read this column; a divergence between them would let
 * the dashboard report "using the default" while the turn path resolves something else.
 */
export function normalizeStoredModelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}
