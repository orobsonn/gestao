/** @description Resolve {empresa_id, expert_id} from chat+thread via inner join on live expert_telegram_topics + empresa_telegram_chats (deleted_at IS NULL). Map-only, no text parsing. */
export function resolveTelegramTopicContext(db, chatId, messageThreadId) {
  const row = db
    .prepare(
      `SELECT t.empresa_id, t.expert_id
       FROM expert_telegram_topics t
       INNER JOIN empresa_telegram_chats c
         ON c.empresa_id = t.empresa_id AND c.chat_id = t.chat_id
       INNER JOIN experts e ON e.id = t.expert_id AND e.deleted_at IS NULL
       INNER JOIN empresas emp ON emp.id = t.empresa_id AND emp.deleted_at IS NULL
       WHERE t.chat_id = ? AND t.message_thread_id = ?
       LIMIT 1`,
    )
    .get(chatId, messageThreadId);
  return row ? { empresa_id: String(row.empresa_id), expert_id: String(row.expert_id) } : null;
}
