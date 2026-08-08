# Checklist manual — bot Telegram (Flue)

Testes manuais do bot `@gestao_ops_bot` em produção (ou preview).  
Pré-requisitos: webhook setado, secrets em prod, user com Telegram vinculado e membership em empresa, LLM da empresa `valid`.

**Ambiente:** https://gestao.robsonlins.workers.dev  
**Bot:** @gestao_ops_bot  
**Data do checklist:** 2026-08-08 (feature #14 + fixes de formato/loopback)

Marque com `[x]` ao passar. Em falha, anote: o que digitou + resposta do bot (ou “silêncio”) + horário aprox.

---

## Já validado (referência)

- [x] DM responde
- [x] Lista tarefas
- [x] UI do site com CSS
- [x] Webhook + secrets em prod
- [x] Formatação Telegram (emojis / preview de lista)

---

## 1. DM — empresa e pin

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 1.1 | Listar empresas | “quais empresas tenho?” / “trocar empresa” | Lista empresas do membership | [ ] |
| 1.2 | Trocar pin | Escolher outra empresa (nome, índice ou id) | Confirma pin; não roda agent no seletor | [ ] |
| 1.3 | Boundary pós-switch | Mensagem normal logo após trocar empresa | Aviso de que contexto anterior pode ser outra empresa | [ ] |
| 1.4 | N=1 membership | User com só 1 empresa | Pin automático, sem lista de desambiguação | [ ] |

---

## 2. Tarefas (DM)

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 2.1 | Listar | “quais tarefas existem?” | Lista agrupada (📝 / 🔄 / ✅), curta, Telegram-friendly | [ ] |
| 2.2 | Criar com campanha | “cria tarefa Revisar criativos na campanha &lt;id ou nome&gt;” | Cria; confirma em pt-br com emoji | [ ] |
| 2.3 | Criar sem campanha | “cria tarefa Teste” (sem campanha) | Pede campanha (DM não auto-escolhe) | [ ] |
| 2.4 | Atualizar status | “marca &lt;tarefa&gt; como fazendo / feito” | Status atualiza; confirma | [ ] |
| 2.5 | Excluir | “exclui a tarefa &lt;nome&gt;” | Some da lista (soft-delete) | [ ] |
| 2.6 | Lista vazia | Empresa sem tarefas live | Mensagem tipo 📭 nenhuma tarefa | [ ] |

---

## 3. Tópico (grupo Telegram)

Pré: grupo/tópico mapeado ao expert (bind `/vincular_expert` ou fluxo Admin).

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 3.1 | @mention | `@gestao_ops_bot oi` no tópico mapeado | Responde no tópico (com thread) | [ ] |
| 3.2 | Criar c/ 1 campanha aberta | Expert com exatamente 1 campanha `aberta` | Cria na campanha sem perguntar | [ ] |
| 3.3 | Criar c/ 0 ou 2+ abertas | Expert sem aberta ou com várias | Pergunta qual campanha / avisa | [ ] |
| 3.4 | Sem @ | Mensagem no grupo sem mencionar o bot | Não responde | [ ] |
| 3.5 | User sem link | Conta Telegram não vinculada na web | Fail-closed pt-br; não cria tarefa | [ ] |

---

## 4. Auth / gates

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 4.1 | Sem membership | User linkado sem `empresa_membros` | Mensagem de membership / solicitar acesso | [ ] |
| 4.2 | LLM inválida | Empresa sem key ou status ≠ valid | Mensagem de config LLM; sem tools destrutivas | [ ] |
| 4.3 | Vincular Telegram | Minha conta → deep link → `/start` no bot | `telegram.linked` true na web | [ ] |

---

## 5. Notify

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 5.1 | Colega linkado | “avisa o Fulano: oi” (mesmo tenant, com link TG) | Fulano recebe DM | [ ] |
| 5.2 | Sem link | Alvo membro sem Telegram | Informa que não tem link; não envia | [ ] |

---

## 6. Campanha

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 6.1 | Criar campanha | “cria uma campanha X” | Recusa; oriente pela web | [ ] |

---

## 7. Estabilidade / memória

| # | Caso | Como testar | Esperado | Ok? |
|---|------|-------------|----------|-----|
| 7.1 | Duas msgs seguidas | Duas perguntas no mesmo DM | Ambas respondem; mesma sessão | [ ] |
| 7.2 | Follow-up | Depois da lista: “e a primeira?” | Usa contexto da conversa | [ ] |
| 7.3 | Latência | Pergunta simples (“oi” / listar) | Resposta em ~15–20s (não silêncio longo) | [ ] |

---

## 8. Ops rápido

| # | Caso | Esperado | Ok? |
|---|------|----------|-----|
| 8.1 | Hard refresh no site pós-deploy | CSS/layout ok | [ ] |
| 8.2 | `getWebhookInfo` | URL = `…/api/telegram/webhook`, sem `last_error` recorrente | [ ] |

---

## Ordem sugerida (~30 min)

1. DM: listar → criar → atualizar → excluir  
2. Trocar empresa + 1 mensagem (boundary)  
3. @ no tópico mapeado  
4. Pedir criar campanha (recusa)  
5. Avisar alguém (notify)  
6. Follow-up de memória  

---

## Notas

- Modelo atual hardcoded por provider: `openai/gpt-4o-mini` | `anthropic/claude-sonnet-4-6` (escolha no dash = issue #56).  
- Falhas genéricas antigas (“Não consegui processar agora”) = loopback/key/cwd/waitUntil — já corrigidos em prod; se voltar, capturar horário + texto.  
- Dados E2E de seed podem poluir listas; ok para smoke, limpar depois se atrapalhar demo.
