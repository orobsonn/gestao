# CONTEXT.md — Domain glossary

Shared vocabulary between operator, codebase, and agents.
Implementation-free: what the term MEANS in the business, never which file implements it.

| termo | significado |
|---|---|
| Empresa | Unidade de isolamento multi-tenant: organização dona dos dados; todo dado de domínio pertence a uma empresa |
| Expert | Pessoa/marca sob uma empresa (ex.: expert de lançamento); nível da hierarquia abaixo de Empresa |
| Campanha | Ação/lançamento de um expert (pago, gratuito, perpétuo, webinário); tem ciclo de vida aberta/encerrada/arquivada |
| Tarefa | Trabalho operacional ligado a uma campanha (kanban simples: a fazer / fazendo / feito) |
| empresa_membros | Vínculo usuário↔empresa com papel; define quem acessa a empresa (sem ACL por expert/campanha no v1) |
| papel | Papel do membro na empresa: `admin` ou `membro` |
| super_admin | Papel de plataforma no usuário (não é papel de membership); acima das empresas |
| dono | Usuário opcional responsável por uma tarefa (`dono_id`); distinto de quem criou |
| created_by | Usuário que criou a tarefa; obrigatório e imutável no sentido de autoria |
| platform | Superfície de operação do super_admin da plataforma (provisionar empresas); distinta do app multi-tenant da empresa |
| empresa ativa | Empresa cujo contexto a sessão usa para escopar APIs de tenant; null quando o usuário tem zero ou várias memberships até escolher (ou auto se só tem uma) |
| membership | Vínculo do usuário a uma empresa com papel admin\|membro; só empresas não soft-deleted entram na lista e podem ser ativadas |
