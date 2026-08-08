/** @description Build stable session id for topic or dm surfaces. topic:chat:thread or dm:userId. String canonical, no spaces. */
export function buildSessionId({ kind, chatId, threadId, userId }) {
  if (kind === 'topic') {
    return `topic:${String(chatId)}:${String(threadId)}`;
  }
  if (kind === 'dm') {
    return `dm:${String(userId)}`;
  }
  throw new Error('invalid kind');
}
