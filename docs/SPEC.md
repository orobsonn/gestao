# Spec inicial — Gestão

Status: rascunho de produto (conversa inicial)  
Data: 2026-07-20

## Visão

Sistema **leve** de gestão de projetos para time pequeno (ex.: agência multi-cliente), com:

1. **Web** — gestão visual
2. **Telegram + agente (Flue)** — interface de ação por conversa
3. **D1** — fonte da verdade

Não é um PM completo (sem Gantt, billing, etc.). É o mínimo para dono de tarefa, prazo, dependência e coordenação via chat.

---

## Personas / contexto

- Time pequeno (várias pessoas)
- Agência com **vários clientes**
- Trabalho acontece no Telegram (grupo) e na web
- Agente **não** manda lembrete proativo; só age quando chamado (ou em fluxos explícitos de “avisar alguém”)

---

## Núcleo de domínio

### Entidades

| Entidade | Descrição |
|---|---|
| **Workspace** | Time/agência |
| **User** | Pessoa do time (web + opcional link Telegram) |
| **Project / Cliente** | Unidade de trabalho (1 cliente ≈ 1 projeto no MVP) |
| **Task** | Tarefa dentro do projeto |
| **Task dependency** | Tarefa A depende de tarefa B |
| **Note** | Nota/anexo textual na tarefa (campo `notes` no MVP) |

### Task — campos

- título
- notas
- status (`todo` \| `doing` \| `done`)
- prioridade (`low` \| `medium` \| `high` \| `urgent`)
- prazo (`due_date`)
- **dono** (`assignee`)
- dependências (outras tasks)
- projeto pai
- timestamps

### Project — campos (MVP)

- nome
- descrição
- status (`backlog` \| `active` \| `done` \| `archived`)
- vínculo opcional com tópico Telegram

### Regras de produto

- Toda task tem (ou pode ter) um **dono**
- Dependência bloqueia leitura de progresso: “o que me bloqueia / o que eu bloqueio”
- Time pequeno: no MVP, membros autenticados veem os projetos do workspace (sem ACL fina por projeto, salvo se surgir necessidade)

---

## Web

### Stack pretendida

- Cloudflare Workers + D1
- React + Vite
- **shadcn/ui** para agilizar UI
- API Hono no Worker

### Telas (MVP)

1. **Auth** — login do time
2. **Lista de projetos**
3. **Detalhe do projeto** — tasks (lista ou board simples)
4. **Detalhe/edição de task** — status, prazo, dono, notas, dependências
5. (Opcional cedo) **Meu trabalho** — tasks onde eu sou dono

### Fora do MVP web

- Gantt, time tracking, arquivos pesados, multi-tenant billing
- Notificações push web

---

## Telegram

### Modelo de uso

- Grupo da agência com **tópicos (forum topics)**
- **1 tópico por cliente/projeto**
- Pessoas conversam entre si no tópico normalmente
- Agente só responde quando **@mencionado**
- Agente também pode:
  - falar no **privado (DM)** com usuário linkado
  - mandar mensagem no **grupo/tópico** (ex.: avisar outro dono)

### Ligações obrigatórias

| Ligação | Motivo |
|---|---|
| `telegram_user_id` ↔ `user` | identidade, DM, permissão |
| `telegram_chat_id` (grupo) ↔ workspace | onde o bot opera |
| `message_thread_id` (tópico) ↔ `project` | contexto do @ |

### Comportamento do agente

- **Sem @** → silêncio (não polui o grupo)
- **Com @** → monta contexto → Flue + tools → responde no tópico
- **DM** → gestão pessoal (“minhas tasks”, updates rápidos)
- **Avisar dono** → DM e/ou menção no tópico (regra a definir na implementação)

### Framework

- **Flue** ([flueframework.com](https://flueframework.com)) — mesmo ecossistema do `poc-flue`
- Tools explícitas; sem autonomia de spam/lembrete

### Tools iniciais (bot)

| Tool | Função |
|---|---|
| `listar_minhas_tarefas` | tasks do usuário que falou |
| `listar_projeto` | tasks/resumo do projeto do tópico |
| `criar_tarefa` | cria task no projeto contextual |
| `atualizar_tarefa` | status, prazo, dono, notas |
| `ver_dependencias` | o que bloqueia / o que é bloqueado |
| `o_que_me_bloqueia` | atalho pessoal |
| `avisar_dono` | mensagem para responsável de outra task |
| `resumo_projeto` | parado / vencendo / bloqueado |

**Fora de escopo do bot (de propósito)**

- Lembrete automático periódico
- Agir sem @ (no grupo)
- Decidir sozinho mudanças destrutivas sem pedido claro

---

## Contexto no @ (mensagens do tópico)

Problema: no @, o agente precisa de contexto da conversa — nem tudo, nem quase nada.

### Decisão de desenho (preferência atual)

**Webhook grava mensagens do grupo/tópico** + montagem de janela **top-k** na hora do @.

### O que gravar (por mensagem)

- `chat_id`, `message_thread_id` (tópico), `message_id`
- `from` (telegram user)
- `text`
- `reply_to_message_id`
- `date`

MVP: só texto (sem mídia).

### Janela de contexto no @

1. Últimas **N** msgs do tópico (candidato: 30–50)
2. **Reply chain** da mensagem que deu @
3. **Estado do projeto no D1** (tasks abertas, donos, bloqueios, prazos)
4. (Depois) resumo rolling do tópico para não depender de histórico longo

### Retenção

- Últimos **7 dias** **ou** últimas **~200 msgs/tópico** (o que estourar primeiro)
- Evita D1 crescer sem limite e reduz risco de contexto inútil

### Alternativa descartada como default

- Só buscar histórico na API do Telegram na hora do @ — menos controle, latência, limites; pode voltar como fallback.

### Pontos a validar na implementação

- Valor exato de N (top-k)
- Se responde só à thread ou também “resumo do dia”
- Privacidade: quem do time pode ver o que o agente usou como contexto
- Rate limit / custo de tokens no Flue

---

## Arquitetura lógica

```
[Web shadcn] ──┐
               ├── Worker (Hono API) ── D1 (fonte da verdade)
[Telegram] ────┘         │
   webhook msgs          ├── grava msgs (top-k store)
   @mention / DM         └── Flue agent + tools
```

Stack alinhada aos outros projetos: **Cloudflare Workers + D1**.

---

## MVP vs depois

### MVP (v1) — candidato

1. Schema D1: users, projects, tasks, dependencies, ligações Telegram, message store
2. API + auth web
3. Web: projetos + tasks (prazo, dono, notas, dependências) com shadcn
4. Bot Telegram: @ no tópico + DM, tools de leitura/atualização + `avisar_dono`
5. Webhook gravando msgs do tópico + top-k no @
6. Mapeamento manual/admin: tópico ↔ projeto, telegram user ↔ user

### Depois

- Resumo rolling do tópico
- ACL por projeto
- Criação automática de tópicos ao criar projeto
- Mídia / arquivos
- Lembretes *opt-in* (se um dia fizer sentido; hoje está fora)
- Board kanban rico, filtros avançados

---

## Decisões em aberto

1. Auth web: magic link vs email/senha vs só convite admin
2. Workspace único no MVP ou multi-workspace desde o início
3. Criar tópico Telegram automaticamente ao criar projeto — v1 ou v2?
4. `avisar_dono`: default DM, default tópico, ou perguntar ao usuário?
5. Idioma da UI: pt-BR (assumido)
6. Nome do produto (“Gestão” é placeholder do repo)

---

## Fora de escopo (explícito)

- Bot como “cobrador” de prazo automático
- Substituição total do Telegram por app de chat próprio
- Mobile native
- Integrações (Notion, Jira, Linear) no MVP

---

## Origem

Spec extraída da conversa de produto em 2026-07-20.  
Próximo passo quando for build: fechar decisões em aberto + ordem de implementação (schema → API → web → bot).
