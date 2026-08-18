/** @description Build stable session id for topic or dm surfaces. topic:chat:thread or dm:userId. String canonical, no spaces. */

/** Telegram ids arrive as numbers from the wire and as strings from storage; both canonicalize. */
type TelegramId = string | number

export type SessionIdInput =
  | { kind: 'topic'; chatId: TelegramId; threadId: TelegramId; userId?: TelegramId }
  | { kind: 'dm'; userId: TelegramId; chatId?: TelegramId; threadId?: TelegramId }

export function buildSessionId(input: SessionIdInput): string {
  if (input.kind === 'topic') {
    return `topic:${String(input.chatId)}:${String(input.threadId)}`
  }
  if (input.kind === 'dm') {
    return `dm:${String(input.userId)}`
  }
  // Unreachable for typed callers, but this module is also imported from .mjs tests and from the
  // webhook path, where `kind` arrives as untyped data. Keep the runtime guard.
  throw new Error('invalid kind')
}
