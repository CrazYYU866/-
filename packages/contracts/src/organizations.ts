import { z } from 'zod';
import { LEGAL_FORMS, ORGANIZATION_KINDS, ORG_MEMBER_ROLES } from './roles';

const digits = (n: number[]) => z.string().regex(new RegExp(`^(${n.map((x) => `\\d{${x}}`).join('|')})$`));

export const CreateOrganizationSchema = z.object({
  kind: z.enum(ORGANIZATION_KINDS),
  legalForm: z.enum(LEGAL_FORMS),
  name: z.string().trim().min(2).max(300),
  representativeName: z.string().trim().min(2).max(200),
  inn: digits([10, 12]),
  ogrn: digits([13, 15]),
  kpp: digits([9]).optional(),
  legalAddress: z.string().trim().min(5).max(500),
  email: z.string().trim().email().max(200),
  contactPhone: z.string().min(5).max(32),
});
export type CreateOrganization = z.infer<typeof CreateOrganizationSchema>;

export const UpdateOrganizationSchema = CreateOrganizationSchema.omit({ kind: true }).partial();
export type UpdateOrganization = z.infer<typeof UpdateOrganizationSchema>;

export const RejectSchema = z.object({ reason: z.string().trim().min(3).max(2000) });
export type RejectRequest = z.infer<typeof RejectSchema>;

export const BankAccountSchema = z.object({
  bik: digits([9]),
  accountNumber: digits([20]),
  correspondentAccount: digits([20]),
  bankName: z.string().trim().min(2).max(300),
  code: z.string().regex(/^\d{4,8}$/),
});
export type BankAccountRequest = z.infer<typeof BankAccountSchema>;

export const MEMBER_STATUSES = ['invited', 'active', 'blocked', 'detached'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const InviteMemberSchema = z.object({
  phone: z.string().min(5).max(32),
  role: z.enum(ORG_MEMBER_ROLES).exclude(['owner']),
  fullName: z.string().trim().min(2).max(200).optional(),
});
export type InviteMember = z.infer<typeof InviteMemberSchema>;

export const ChangeMemberRoleSchema = z.object({ role: z.enum(ORG_MEMBER_ROLES).exclude(['owner']) });
export type ChangeMemberRole = z.infer<typeof ChangeMemberRoleSchema>;

export const SetOperatesSchema = z.object({ canOperate: z.boolean() });
export type SetOperates = z.infer<typeof SetOperatesSchema>;

export const DOCUMENT_OWNER_TYPES = ['organization', 'equipment', 'operator'] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];
export const DOCUMENT_STATUSES = ['uploaded', 'approved', 'rejected', 'expired'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const UploadDocumentSchema = z.object({
  documentTypeCode: z.string().min(2).max(64),
  fileId: z.string().uuid(),
  expiresAt: z.string().date().optional(),
});
export type UploadDocument = z.infer<typeof UploadDocumentSchema>;

export const TransferOwnershipSchema = z.object({
  newOwnerPhone: z.string().min(5).max(32),
  reason: z.string().trim().min(3).max(2000),
  basisFileIds: z.array(z.string().uuid()).min(1),
});
export type TransferOwnership = z.infer<typeof TransferOwnershipSchema>;
