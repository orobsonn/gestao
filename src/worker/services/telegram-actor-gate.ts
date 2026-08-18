import type { RowReaderDb } from "../types.ts";

/** @description Resolve Telegram actor: telegramUserId → user_telegram_links → live empresa_membros (empresas.deleted_at IS NULL). Returns {ok:true,userId} or {ok:false,reason:'not_linked'|'not_member'}. */
export type TelegramActor =
  | { ok: true; userId: string }
  | { ok: false; reason: 'not_linked' | 'not_member' }

export async function resolveTelegramActor(
  db: RowReaderDb,
  telegramUserId: string | number,
  empresaId: string | number,
): Promise<TelegramActor> {
  const link = await Promise.resolve(
    db
      .prepare(`SELECT user_id FROM user_telegram_links WHERE telegram_user_id = ? LIMIT 1`)
      .get(String(telegramUserId)),
  );
  if (!link) return { ok: false, reason: "not_linked" };
  const userId = String(link.user_id);
  const member = await Promise.resolve(
    db
      .prepare(
        `SELECT 1 FROM empresa_membros m
         INNER JOIN empresas e ON e.id = m.empresa_id
         WHERE m.user_id = ? AND m.empresa_id = ? AND e.deleted_at IS NULL
         LIMIT 1`,
      )
      .get(userId, String(empresaId)),
  );
  if (!member) return { ok: false, reason: "not_member" };
  return { ok: true, userId };
}
