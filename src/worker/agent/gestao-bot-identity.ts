/**
 * @description Single source of truth for the gestao-bot agent's durable identity
 * on Flue 2.0.3. wrangler.jsonc and the agent module import these constants so the
 * DO class / binding name / mount path can never silently drift apart.
 *
 * The DO class and binding name are authored here (not derived at runtime) because
 * the derivation was already measured against a real vite build of the Flue 2.0.3
 * scaffold: agentName 'gestao-bot-v2' emits exactly
 * { name: 'FLUE_GESTAO_BOT_V2_AGENT', class_name: 'FlueGestaoBotV2Agent' } — the
 * numeric segment camelizes as V2.
 */

/** Flue agent name — drives DO class/binding derivation in the generated worker. */
export const GESTAO_BOT_AGENT_NAME = "gestao-bot-v2";

/** Durable Object class exported by the generated worker entry. */
export const GESTAO_BOT_DO_CLASS = "FlueGestaoBotV2Agent";

/** Durable Object binding name (FLUE_-prefixed names are reserved by Flue). */
export const GESTAO_BOT_DO_BINDING = "FLUE_GESTAO_BOT_V2_AGENT";

/** HTTP mount path the agent is served at. */
export const GESTAO_BOT_MOUNT_PATH = "/agents/gestao-bot";

/** Durability policy for a single agent turn — one attempt, 60s ceiling. */
export const GESTAO_BOT_DURABILITY = {
  maxAttempts: 1,
  timeoutMs: 60000,
} as const;