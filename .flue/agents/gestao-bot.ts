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

function asDbLike(d1: D1Database): DbLike {
  return {
    prepare(sql) {
      const stmt = d1.prepare(sql);
      return {
        run(...params: unknown[]) {
          if (params.length === 0) return stmt.run();
          return stmt.bind(...params).run();
        },
        async get(...params: unknown[]) {
          const row =
            params.length === 0
              ? await stmt.first()
              : await stmt.bind(...params).first();
          return (row ?? undefined) as Record<string, unknown> | undefined;
        },
        async all(...params: unknown[]) {
          const result =
            params.length === 0
              ? await stmt.all()
              : await stmt.bind(...params).all();
          return (result?.results ?? []) as Record<string, unknown>[];
        },
      };
    },
  };
}

type AgentSecrets = {
  LLM_KEY_ENCRYPTION_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
};

export function GestaoBot(_props: AgentProps) {
  const delivery = useDelivery();
  const a = (
    delivery.kind === 'signal' ? (delivery.attributes ?? {}) : {}
  ) as Record<string, unknown>;

  const secrets = env as unknown as AgentSecrets;

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
      String(secrets.LLM_KEY_ENCRYPTION_SECRET ?? ''),
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

  const token = String(secrets.TELEGRAM_BOT_TOKEN ?? '').trim();
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
