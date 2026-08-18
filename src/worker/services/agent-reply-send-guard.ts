/**
 * @description SCAFFOLD STUB — durable single-send claim for a coalesced agent reply.
 *
 * Not implemented yet: the export throws so the frozen locked test COLLECTS (a non-vacuous gate)
 * while staying legitimately RED until the real implementation lands.
 */
import type { DbLike } from '../types.ts'

/** @description Claims the right to post ONE reply for a settled answer. */
export async function claimAgentReplySend(
  _db: DbLike,
  _answeredBySubmissionId: string,
): Promise<{ claimed: boolean }> {
  throw new Error('not implemented')
}
