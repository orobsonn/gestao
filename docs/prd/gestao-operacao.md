# Gestão da operação (lançamentos) — v1 teste

- **slug:** gestao-operacao
- **status:** pronto
- **criado:** 2026-08-03 · **atualizado:** 2026-08-04

## Problema

Times de agência de lançamentos digitais (casas distintas, donos distintos) não têm um **contrato materializado** do trabalho: o que está com quem, o que atrasou, em qual expert/campanha. ClickUp e similares foram tentados e não vingaram por complexidade. A operação já vive no Telegram; falta um sistema **simples** (web + bot) com **uma infra só**, **multi-empresa isolada**, sem billing e sem monstro de PM.

## Quem se beneficia

- **Operador da plataforma** (super-admin): provisiona empresas sem manter um deploy por casa.
- **Admin da empresa:** visão da casa + próprio trabalho; configura IA, pessoas, Telegram.
- **Membro:** sabe o que é dele e atualiza no fluxo (web ou Telegram).
- **Empresário pouco “PM”:** home por papel, vocabulário do domínio real (Empresa → Expert → Campanha → Tarefa), IA no repetitivo.

## Requisitos

1. Isolamento multi-tenant por **Empresa**: usuário autenticado na empresa A nunca lê nem escreve dados da empresa B (experts, campanhas, tarefas, pessoas, configs).
2. Super-admin da plataforma cria Empresa e define o primeiro admin da casa; essa camada não aparece para membros/admins da empresa.
3. Uma conta (e-mail) pode pertencer a **várias empresas**; após login, se houver mais de uma, o usuário escolhe/alterna a **empresa ativa**; todo dado exibido e mutado é só da empresa ativa.
4. Papéis na empresa: **admin** e **membro** apenas.
5. Home do **membro** mostra só **Meu trabalho** (tarefas em que é dono), com destaque para atrasadas.
6. Home do **admin** mostra **Meu trabalho** e **visão empresa** (abertas/atrasadas na casa), com **toggle** para focar uma lente.
7. Domínio v1: **Empresa → Expert → Campanha → Tarefa** (sem andar “projeto” genérico; sem oferta/template no v1).
8. Campanha tem: nome; expert pai; tipo entre `lançamento pago` | `lançamento gratuito` | `perpétuo` | `webinário` (enum fechado, extensível depois); status (`aberta` | `encerrada` | `arquivada`); datas início/fim opcionais; notas opcionais. Criação/edição só na **web** no v1 (form curto). Só **admin** cria expert e campanha. “Aberta” = elegível para o bot assumir contexto.
9. Tarefa v1 contém: título, dono (usuário da empresa), prazo opcional, status (`a fazer` | `fazendo` | `feito`), campanha pai, notas opcionais. Sistema pode sugerir prazo; **não bloqueia** criar/salvar sem prazo. Links externos (Drive etc.) vão em **notas** no v1 — sem campo de anexo/upload.
10. Qualquer membro ou admin da empresa pode criar, editar, atribuir dono, mudar status e **excluir** qualquer tarefa da empresa (web e bot). Exclusão **sem** passo extra de confirmação.
11. Acesso web v1: admin cria usuário com senha e entrega fora do sistema; sem magic link e sem fluxo caprichado de “esqueci senha”.
12. Admin da empresa configura chave de LLM (**OpenAI** ou **Anthropic**), com ação **Validar chave**; sem chave válida ou com falha, fluxos de IA/bot falham com erro claro; CRUD de gestão continua disponível.
13. Telegram: **um bot único** para toda a aplicação; **um grupo por Empresa**, **um tópico por Expert**, mais **DM**. Isolamento MT pelo vínculo grupo/tópico, não por bot separado.
14. Resolução de campanha no @: bot consulta campanhas do expert do tópico; se exatamente uma aberta, assume; se zero, várias ou dúvida, **pergunta** ao usuário. Bot nunca infere empresa/expert só por texto — só por vínculo grupo/tópico.
15. Vínculo pessoa↔Telegram (DM): em **Minha conta**, botão único abre deep link fixo do bot (`t.me/<bot>?start=<codigo>`); ao Start, conta fica vinculada. Sem colar user id.
15b. Vínculo grupo/tópico (Admin, à prova de leigo): web gera comandos copiáveis; admin cola no Telegram — `/vincular_empresa <codigo>` no grupo e `/vincular_expert <codigo>` no tópico do expert. Sem obrigar colar chat id/thread id manualmente.
16. Bot v1 (quando chamado com @ no tópico ou em DM), via tools da LLM: listar/consultar tarefas no contexto, listar campanhas do expert, criar, atualizar, excluir, notificar pessoa. **Não** cria campanha no v1. O agente **descobre estado pelo tool** (D1); não se injeta dump/snapshot grande de tasks no prompt — só identidade mínima do turno (empresa, expert, usuário, superfície).
17. Tool de notificar: se o alvo não vinculou Telegram, bot informa isso e não inventa outro canal; se vinculou, envia DM.
17b. Memória de conversa: agente **Flue nativo** (Cloudflare), **1 DO/sessão estável por superfície** — tópico do expert = `topic:{chat_id}:{thread_id}` (memória do **tópico inteiro**, opção A); DM = `dm:{user_id}` após vínculo. Sem id aleatório por mensagem. Stack alinhada ao padrão victor-bot (Flue sobre Agents SDK), não app “só SDK cru” no v1.
17c. Reset de memória: super-admin (e, se barato, admin da empresa) pode **zerar a sessão** de um tópico ou DM quando encher/corromper — operação explícita na web admin/plataforma; próximo @ começa fio limpo (D1 de tasks **não** apaga).
18. Web v1 (telas): login; seletor de empresa; home por papel; navegação Expert → Campanhas → lista de tarefas; detalhe/edição de tarefa; admin: pessoas (alta com senha), chave IA + validar, mapeamento Telegram (grupo/tópicos), vínculo Telegram (código). Sem kanban no v1.
19. UI web construída com **shadcn/ui** (e Tailwind do stack já previsto), paleta fria, com **light e dark mode** (toggle do usuário; ambos de primeira classe). Home do admin inclui resumo numérico/gráfico simples (atrasadas, vencem hoje, minhas abertas, carga por urgência/expert) além das listas — sem dashboard analítico pesado. Home do membro: KPIs só pessoais + lista; linhas de tarefa são clicáveis para abrir o detalhe.
20. Prioridade de tarefa, dependência entre tarefas, template de campanha, montagem de campanha por entrevista no bot, billing e signup público de empresa ficam **fora** do v1 (evolução).

## Decisões travadas

- Parede de isolamento = **Empresa** (não projeto solto).
- Uma infra / um deploy; **sem billing**.
- Entrada de empresa no teste: **provisionada** pelo super-admin (não self-service SaaS).
- Filosofia Occam / anti-ClickUp; teste útil no dia a dia, não produto monstro.
- Dor #1 do v1: **dono + prazo visíveis** (contrato materializado). Templates/montagem de campanha por chat e kanban = depois.
- Telegram = **central da operação** no dia 1 (grupo+tópico+DM), não só atalho.
- Home por papel; admin = executor+gestor na mesma home com toggle.
- Papéis: só admin e membro.
- Pessoa ligada só à **Empresa** (vê a casa inteira); sem ACL por expert/campanha no v1.
- Domínio: Empresa → Expert → Campanha → Tarefa (alinhado à ontologia `memoria-org` / operação AIDEE-Orca).
- Conta única multi-empresa (espírito Oráculo).
- Auth web: admin cria user+senha, passa no privado.
- LLM: chave por empresa, admin, validar; OpenAI + Anthropic; sem fallback pago pelo operador da plataforma.
- Bot: tasks + notificar (tool LLM); campanha manual na web.
- Excluir task: qualquer um da empresa, **direto**.
- Vínculo Telegram DM: deep link `t.me/<bot>?start=<codigo>` (um bot global).
- Vínculo grupo/tópico: comandos copiáveis `/vincular_empresa` e `/vincular_expert` (sem colar IDs).
- Tipos de campanha v1 (só estes 4): lançamento pago, lançamento gratuito, perpétuo, webinário.
- Web: pacote de telas A (listas, não kanban); filtros na campanha = status + dono.
- UI web: **shadcn/ui** + Tailwind; paleta fria; **light / dark / system** (ThemeProvider oficial).
- Kit de componentes shadcn **fechado** no § Contrato de UI (shell instala; resto reutiliza).
- Navegação: **sidebar** + breadcrumb; **Home = dashboard** por papel.
- Mockup canônico light\|dark: `docs/prd/gestao-operacao-mockup.html`.
- Links externos na task: campo **notas** (sem upload).
- Bot: Flue nativo + memória DO por tópico inteiro (A); estado operacional via **tools**, não snapshot injetado; reset de sessão por super-admin.
- Mockup wireframe em `docs/prd/gestao-operacao-mockup.html` (descoberta; não substitui requisitos).

## Contrato de UI (obrigatório na implementação web)

**Fonte canônica de produto:** este PRD.  
**Referência visual aprovada na descoberta:** `docs/prd/gestao-operacao-mockup.html` (wireframe; hierarquia e fluxos — não pixel-perfect).  
Qualquer issue de UI **deve citar os dois paths** no summary e em `resolved_decisions`. Não reinventar navegação, paleta nem stack a partir do zero.

### Stack e visual
- **shadcn/ui** + **Tailwind** (já no ecossistema do repo) — componentes reutilizáveis; não inventar design system paralelo.
- Instalação via CLI oficial (`npx shadcn@latest init` + `add` dos itens do kit). Docs: [components](https://ui.shadcn.com/docs/components), [dark mode Vite](https://ui.shadcn.com/docs/dark-mode/vite).
- Paleta **fria** (slate + acento teal) nos **dois** temas: **light e dark** de primeira classe + opção **system** (padrão shadcn `ThemeProvider`: light | dark | system). Toggle na casca (ModeToggle da doc).
- Tipografia e densidade: limpa, anti-ClickUp; listas > kanban no v1.

### Kit shadcn v1 (fechado — não deixar a run “descobrir”)

Fonte: catálogo oficial shadcn/ui. A issue **web-shell-shadcn** instala o kit; issues web seguintes **só reutilizam** (podem pedir 1 componente extra com justificativa no PR, não trocar o kit inteiro).

| Componente (nome CLI / docs) | Uso no produto |
|---|---|
| **sidebar** | Casca: Home, Experts, Meu trabalho, Admin, empresa |
| **breadcrumb** | Experts → Expert → Campanha → Tarefa |
| **button** | Ações primárias/secundárias/destrutivas |
| **dropdown-menu** | Menu user, ModeToggle (light/dark/system), trocar empresa |
| **avatar** | Identidade no rodapé da sidebar |
| **separator** | Divisores na sidebar e admin |
| **card** | KPIs, blocos de dashboard e admin |
| **badge** | Status task, tipo campanha, Telegram ok/pendente, atrasada |
| **table** | Listas de tasks / experts (v1; data-table só se a lista exigir sort/filter pesado) |
| **input** + **label** | Login, forms, busca leve |
| **textarea** | Notas de task / campanha |
| **select** | Dono, status, tipo campanha, filtros status/dono |
| **dialog** | Forms curtos (+ Expert, + Campanha, criar user) |
| **sheet** | Menu mobile da sidebar |
| **tabs** | Seções do Admin (Pessoas / IA / Telegram) se ajudar densidade |
| **switch** ou **toggle-group** | Toggle lente Home (Tudo \| Só meu \| Só empresa); preferir **toggle-group** |
| **calendar** + **popover** (date picker) | Prazo opcional da task; datas opcionais da campanha |
| **alert** | Erro de chave IA, bot sem key, estados de falha |
| **sonner** ou **toast** | Feedback salvar/validar/copiar comando (doc atual lista **toast**) |
| **skeleton** | Loading de listas/dashboard |
| **spinner** | Ações async curtas (validar chave) |
| **scroll-area** | Listas longas na home/campanha |
| **tooltip** | Ícones da sidebar / ações ícone |
| **empty** | Campanha sem tasks, expert sem campanha |
| **chart** | KPIs da home (barras urgência / distribuição) — [charts](https://ui.shadcn.com/charts) |
| **typography** (padrão docs) | Títulos e textos base |

**Explicitamente fora do kit v1** (não instalar “por se acaso”): carousel, menubar, resizable, slider, input-otp, accordion (salvo necessidade real), command/combobox (salvo busca global depois), attachment/message/bubble (chat UI — nosso chat é Telegram).

**Dark mode (doc Vite oficial):** `ThemeProvider` + classe `dark` no `<html>` + `ModeToggle` (DropdownMenu + Button). Default inicial: `system`.

### Navegação (casca)
- **Sidebar** fixa: Home · Experts · Meu trabalho · Admin (só admin) · seletor de empresa · identidade do user.
- **Breadcrumb** no topo: Experts → Expert → Campanha → Tarefa.
- **Home = dashboard** (não landing vazia).
- Mobile: sidebar vira menu (padrão shadcn); detalhe na implementação.

### Telas e comportamento (modelo aprovado)
| Tela | Comportamento travado |
|---|---|
| Home admin | KPIs (atrasadas empresa, vencem hoje, minhas abertas, feitas 7d) + gráficos simples (urgência, status, atrasadas por expert) + blocos Meu trabalho / Empresa · toggle Tudo \| Só meu \| Só empresa · linhas clicáveis |
| Home membro | Só KPIs pessoais + lista; **sem** painel da empresa; atrasadas no topo; linhas clicáveis; botão nova tarefa |
| Experts | Lista com atrasadas/abertas em destaque; linha clicável; + Expert só admin |
| Campanha | Lista de tasks (não kanban); filtros **só status e dono** (nunca filtro de campanha dentro da campanha); KPIs da onda; + tarefa |
| Detalhe task | título, dono, prazo opcional, status, notas (links externos aqui); Salvar / Voltar / Excluir **direto** |
| Admin | Pessoas · chave IA + Validar · Telegram (comandos copiáveis) · + Expert / + Campanha (forms curtos) |
| Minha conta | Vincular Telegram via **um botão** deep link |
| Login | e-mail/senha; se multi-empresa, escolher casa |

### O que a issue de UI NÃO faz
- Não redesenha a IA “do zero” nem troca shadcn por CSS solto sem motivo.
- Não adiciona kanban, Gantt, nem campos fora do PRD.
- Mockup não substitui AC: se mockup e requisito divergirem, **vence o requisito numerado**.

## Suposições do modelo

- As duas casas reais do operador correspondem ao padrão AIDEE/Orca do `memoria-org` (agência com N experts e campanhas).
- “Campanha aberta” para o bot = campanha não arquivada/encerrada (critério exato de status de campanha ainda pode ser afiado na implementação se o PRD não detalhar enum completo).
- Migration atual (`users` com password, `projects`/`tasks` sem empresa/expert) será **substituída/evoluída** — não é contrato de produto.
- Soft-delete técnico por baixo é detalhe de implementação; produto apresenta exclusão como remoção.
- Nome de produto na UI pode permanecer “Gestão” até haver nome próprio.
- Mockup visual em `docs/prd/gestao-operacao-mockup.html` é auxílio de descoberta, não especificação substituta dos requisitos.
- Flue expõe de forma viável o uso de **API key por empresa** (OpenAI/Anthropic) por turno; se o binding nativo travar, adapta-se o provider no boundary do turno sem mudar o contrato de produto.
- “Identidade mínima do turno” = ids/nomes de empresa, expert, usuário linkado e tipo de superfície — não lista de tasks.

## Em aberto

- Validar na implementação: Telegram (deep link + `/vincular_*`), Flue com key por empresa, e reset de DO de conversa em ambiente real.
- Política de teto/compactação automática do histórico do DO (além do reset manual) — se necessário após uso real.
- Nome comercial do produto (UI pode ficar “Gestão” no teste).

## Fora de escopo

- Billing, planos, signup público de empresa.
- Kanban rico, Gantt, time tracking, arquivos/mídia pesada.
- ACL por expert/campanha.
- Prioridade e dependência de tarefas (v1).
- Template de campanha e entrevista de montagem no bot (v1).
- Bot criando campanha (v1).
- Lembretes proativos / bot falando sem @ no grupo.
- Magic link / reset de senha caprichado.
- Integrações Notion/Jira/Linear; app mobile nativo.
- ACL fina estilo ClickUp; monstro de PM.

## Riscos conhecidos

- Exclusão direta + LLM no Telegram: risco de apagar task por mal-entendido de intenção (aceito pelo operador no v1).
- Campanha ativa errada se o critério de “aberta” for frouxo — mitigado por perguntar na dúvida.
- Chave LLM e tokens Telegram são segredos por tenant — vazamento cross-tenant é falha grave de isolamento.
- Escopo “teste” ainda toca auth, multi-tenant e bot — implementação exigirá cerimônia FULL no build, não atalho QUICK.
- Vocabulário “projeto” do SPEC antigo e da migration conflita com o domínio novo — precisa aposentar na UI e no schema.
- Memória de tópico inteiro (A) em grupo falador pode encher contexto — mitigação: tools + reset manual; compactação automática fica em aberto.
