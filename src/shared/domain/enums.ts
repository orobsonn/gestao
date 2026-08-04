/** @description Domain vocabulary enums mirroring migration CHECK constraints. */

/** @description Platform user roles (users.role CHECK). */
export const USER_ROLES = ['super_admin', 'user'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** @description Membership roles on empresa_membros.papel. */
export const MEMBERSHIP_PAPEIS = ['admin', 'membro'] as const
export type MembershipPapel = (typeof MEMBERSHIP_PAPEIS)[number]

/** @description Campanha tipo CHECK values. */
export const CAMPANHA_TIPOS = ['lancamento_pago', 'gratuito', 'perpetuo', 'webinario'] as const
export type CampanhaTipo = (typeof CAMPANHA_TIPOS)[number]

/** @description Campanha status CHECK values. */
export const CAMPANHA_STATUS = ['aberta', 'encerrada', 'arquivada'] as const
export type CampanhaStatus = (typeof CAMPANHA_STATUS)[number]

/** @description Tarefa status CHECK values. */
export const TAREFA_STATUS = ['a_fazer', 'fazendo', 'feito'] as const
export type TarefaStatus = (typeof TAREFA_STATUS)[number]
