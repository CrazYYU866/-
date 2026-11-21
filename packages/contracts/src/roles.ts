/** Роли сотрудников организации-партнёра (решения Р-10, Р-11, П-10, К-12). */
export const ORG_MEMBER_ROLES = ['owner', 'manager', 'dispatcher', 'operator'] as const;
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

/** Вид организации: исполнитель или независимый диспетчер (Н-24, К-12). */
export const ORGANIZATION_KINDS = ['partner', 'agent'] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

/** Допустимые организационные формы: только ИП и юрлица (ТЗ §3). */
export const LEGAL_FORMS = ['ip', 'llc', 'jsc', 'other_legal_entity'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

/** Статусы аккаунта организации (ТЗ §3). */
export const ORGANIZATION_STATUSES = [
  'draft',
  'pending_review',
  'verified',
  'rejected',
  'blocked',
] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** Роли администраторов (В-40). */
export const ADMIN_ROLES = ['superadmin', 'support', 'finance', 'moderator'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Приложения, в которые может войти пользователь. */
export const CLIENT_APPS = ['client', 'partner'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];
