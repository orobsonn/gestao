/** @description Versioned provider-native catalog for supported conversational models. */

export type LlmProvider = 'openai' | 'anthropic'

/**
 * Two invariants, both pinned by tests — this list is offered to admins and then handed to the
 * runtime, so an id that only LOOKS real breaks the empresa's bot on every turn:
 *  1. Each provider's locked legacy default MUST appear here, or an empresa that never chose a
 *     model cannot select the model it is running on and clearing becomes a one-way door.
 *     Pinned by `lt-catalog-contains-provider-defaults`.
 *  2. Every id MUST resolve in the bundled model registry with a transportable `api`, `baseUrl`
 *     and token budget. Pinned by `lt-catalog-models-resolve-in-runtime`.
 *
 * KNOWN LOSS, not guarded here: a per-empresa provider id is unknown to Flue's catalog, so
 * `reasoning`, `cost`, `input`, `compat` and `thinkingLevelMap` are dropped. Because `reasoning`
 * is zeroed, every curated model is treated as non-reasoning and the `thinkingLevelMap` branch is
 * unreachable — the live losses are `compat` and `input`. Guarding on "carries no compat" would
 * remove 7 of the 9 ids below, leaving only `gpt-4o-mini` and `claude-haiku-4-5` — and one of the
 * evicted is `claude-sonnet-4-6`, the LOCKED per-provider default. That guard is an operator
 * decision and is deliberately NOT applied here. See src/worker/AGENTS.md for the per-id table.
 *
 * ⚠️ BEFORE REMOVING AN ID FROM THIS LIST, read this. The catalog degrade is READ-ONLY: the
 * empresa's `model_id` column is never rewritten. So removing an id makes the dashboard report the
 * choice as discarded and the bot fall back to the default — but the dead id stays in the column.
 * Put that id BACK later and the stored choice RESURRECTS silently: the notice disappears on its
 * own and the bot resumes the old model, at the old price, with nobody acting and `cost` zeroed in
 * telemetry so the spend change is invisible. Whether a returning id should resurrect the choice or
 * whether the degrade should be persisted is an UNANSWERED OPERATOR DECISION — do not settle it by
 * editing this list. An admin can clear the dead id manually (the retirement makes the default
 * saveable, see `canSaveLlmModel`), but nothing forces them to.
 */
const CATALOG = {
  openai: ['gpt-4o-mini', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  anthropic: [
    'claude-sonnet-4-6',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ],
} as const satisfies Record<LlmProvider, readonly string[]>

/** @description Returns the exact curated choices for one configured provider. */
export function getLlmModelCatalog(provider: LlmProvider): readonly string[] {
  return CATALOG[provider]
}

/** @description Shared membership contract for provider/model validation. */
export function isCuratedLlmModel(provider: LlmProvider, modelId: string): boolean {
  return CATALOG[provider].some((candidate) => candidate === modelId)
}
