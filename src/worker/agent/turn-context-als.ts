/** @description DO-local AsyncLocalStorage for turn context after D1 consume in Flue gestao-bot. */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface TurnContext {
  empresa_id: string
  expert_id: string | null
  actor_user_id: string
  surface: 'topic' | 'dm'
  provider: string
  apiKey: string
  message: string
  dm_boundary_line?: string | null
  db?: any
  sendNotify?: (p: any) => Promise<void>
}

export const turnContextAls = new AsyncLocalStorage<TurnContext>()

/**
 * @description Run fn with the given turn context bound to ALS.
 */
export function runWithTurnContext<T>(ctx: TurnContext, fn: () => T): T {
  return turnContextAls.run(ctx, fn)
}

/**
 * @description Retrieve current turn context from ALS (undefined if none).
 */
export function getTurnContext(): TurnContext | undefined {
  return turnContextAls.getStore()
}
