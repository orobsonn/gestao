'use agent'

import { env } from 'cloudflare:workers';
import {
  useModel,
  useTool,
  useDelivery,
  setProvider,
  type AgentProps,
} from '@flue/runtime';
import { GESTAO_BOT_DURABILITY } from '../../src/worker/agent/gestao-bot-identity.ts';
import {
  createEmpresaProvider,
  buildEmpresaProviderId,
} from '../../src/worker/agent/empresa-llm-provider.ts';
import {
  createGestaoBotTools,
  type GestaoBotToolsClosure,
} from '../../src/worker/agent/gestao-bot-tools.ts';
import { buildAgentIdentityPrompt } from '../../src/worker/agent/run-agent-turn.ts';
import { loadEmpresaLlmForBot } from '../../src/worker/services/empresa-llm-gate.ts';
import type { DbLike } from '../../src/worker/types.ts';

const playbook = `**Playbook gestao-bot (pt-br) — respostas no Telegram**

## Formato (obrigatório)
- Respostas curtas, mobile-first, otimizadas para Telegram.
- Use *negrito* (um asterisco) e _itálico_ quando ajudar; evite markdown de título (#) e HTML.
- Emojis com sentido (não enfeite à toa):
  - 📋 lista de tarefas · 📝 a fazer · 🔄 fazendo · ✅ feito
  - ➕ criou · ✏️ atualizou · 🗑 excluiu · 👥 membros · 🏢 empresa · ⚠️ erro/aviso · 📭 vazio
- Listas: uma linha por item, com bullet • ou emoji de status — sem "1. **Título:** … **Status:** …".
- Se a tool devolver \`telegram_preview\`, use esse texto (pode enxugar, não reformatar do zero).
- Máx. ~15 itens visíveis; se houver mais, diga quantos ficaram de fora.
- Sem jargão técnico, sem ids UUID na resposta (a menos que o usuário peça).
- Sem despedida longa; 1 linha de oferta de ajuda no máximo.

## Regras de domínio
- Use tools para estado (listar/criar/atualizar/excluir tarefas, listar membros, etc.).
- Recuse criar campanha — oriente pela web.
- Em DM: definir_empresa_ativa termina o turn na hora (tool terminal).
- Nunca invente tenant/expert ids nem dados de outra empresa.
- Se houver DM boundary line, avise que resultados anteriores podem ser de outra empresa.`;

const SECRET_HEADER = 'x-gestao-agent-internal-secret';

function asDbLike(d1: unknown): DbLike {
  if (
    d1 != null &&
    typeof d1 === 'object' &&
    typeof (d1 as { prepare?: unknown }).prepare === 'function' &&
    (d1 as { prepare: () => { get?: { length: number } } }).prepare('').get?.length !== undefined
  ) {
    return d1 as DbLike;
  }
  return {
    prepare(sql: string) {
      const stmt = (d1 as { prepare: (sql: string) => unknown }).prepare(sql);
      return {
        bind(...p: unknown[]) {
          return (stmt as { bind?: (...p: unknown[]) => unknown }).bind?.(...p) ?? stmt;
        },
        async get(...p: unknown[]) {
          const b = p.length ? this.bind(...p) : stmt;
          return (b as { first?: () => Promise<unknown>; get?: () => Promise<unknown> }).first?.() ??
            (b as { get?: () => Promise<unknown> }).get?.();
        },
        async run(...p: unknown[]) {
          const b = p.length ? this.bind(...p) : stmt;
          return (b as { run?: () => Promise<unknown> }).run?.() ?? Promise.resolve(b);
        },
        async all(...p: unknown[]) {
          const b = p.length ? this.bind(...p) : stmt;
          if ((b as { all?: unknown }).all) {
            const r = await (b as { all: () => Promise<unknown> }).all();
            return (r as { results?: unknown[] })?.results ?? (r as unknown[]);
          }
          return [];
        },
      };
    },
  } as DbLike;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  try {
    const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
    const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
    return crypto.subtle.timingSafeEqual(ha, hb);
  } catch {
    const { timingSafeEqual, createHash } = await import('node:crypto');
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }
}

/**
 * @description Timing-safe secret guard. Returns 403 Response on missing/wrong/empty-env; null on pass.
 */
export function createAgentSecretGuard(env: Record<string, unknown>) {
  const secret = (env?.GESTAO_AGENT_INTERNAL_SECRET as string | undefined)?.trim() ?? '';
  if (!secret) {
    return async (_req: Request) => new Response('{"error":"forbidden"}', { status: 403 });
  }
  return async (request: Request): Promise<Response | null> => {
    const header = request.headers.get(SECRET_HEADER);
    if (!header) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    if (!(await safeEqual(secret, header))) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    return null;
  };
}

export function GestaoBot({ id }: AgentProps) {
  const delivery = useDelivery();
  const a = (delivery.attributes ?? {}) as Record<string, unknown>;

  const empresaId = String(a.empresaId ?? '');
  const expertId = a.expertId != null ? String(a.expertId) : null;
  const actorUserId = String(a.actorUserId ?? '');
  const surface = a.surface === 'dm' ? 'dm' : 'topic';
  const provider = a.provider === 'anthropic' ? 'anthropic' : 'openai';
  const rawModelId = String(a.modelId ?? '');
  const nativeModelId = rawModelId.includes('/')
    ? rawModelId.slice(rawModelId.indexOf('/') + 1)
    : rawModelId;
  const dmBoundaryLine = typeof a.dmBoundaryLine === 'string' ? a.dmBoundaryLine : '';

  const db = asDbLike(env.DB);

  const resolveApiKey = async () => {
    if (!empresaId) return '';
    const loaded = await loadEmpresaLlmForBot(
      db,
      empresaId,
      String(env.LLM_KEY_ENCRYPTION_SECRET ?? ''),
    );
    return loaded.ok ? loaded.apiKey : '';
  };

  const derivedId = buildEmpresaProviderId(provider, empresaId, nativeModelId);
  setProvider(
    createEmpresaProvider({
      provider,
      empresaId,
      nativeModelId,
      resolveApiKey,
    }),
  );

  useModel(`${derivedId}/${nativeModelId}`);

  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const closure: GestaoBotToolsClosure = {
    empresa_id: empresaId,
    expert_id: expertId,
    actor_user_id: actorUserId,
    surface,
    db,
    sendNotify: async (telegramUserId: string, text: string) => {
      if (!token) throw new Error('bot token missing');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramUserId, text }),
      });
      if (!res.ok) throw new Error('notify failed');
    },
  };

  for (const tool of createGestaoBotTools(closure)) {
    useTool(tool);
  }

  const identity = buildAgentIdentityPrompt({
    empresaId,
    expertId,
    userId: actorUserId,
    surface,
  });
  const boundary = dmBoundaryLine ? `\n${dmBoundaryLine}` : '';
  return playbook + '\n' + identity + boundary;
}

GestaoBot.agentName = 'gestao-bot-v2';
GestaoBot.durability = GESTAO_BOT_DURABILITY;

export default GestaoBot;
