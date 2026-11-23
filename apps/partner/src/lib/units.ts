export interface Unit {
  id: string; categoryId: string; categoryName: string; brand: string; model: string; year: number | null; regNumber: string | null;
  attributes: Record<string, unknown>; base: { lat: number; lng: number; address: string }; workRadiusKm: number; allowBeyondRadius: boolean;
  isOnline: boolean; verificationStatus: 'draft' | 'pending' | 'approved' | 'rejected'; rejectionReason: string | null; archived: boolean;
  photos: { id: string; fileId: string; sort: number }[];
  schedule: { weekday: number; start: string; end: string }[];
}
export const UNIT_STATUS = {
  draft: { label: 'Черновик', tone: 'neutral' },
  pending: { label: 'На проверке', tone: 'info' },
  approved: { label: 'Проверена', tone: 'success' },
  rejected: { label: 'Отклонена', tone: 'danger' },
} as const;
export interface Attr { id: string; key: string; label: string; type: 'number' | 'integer' | 'boolean' | 'text' | 'enum' | 'multi_enum'; unit: { label: string } | null; options: string[] | null; required: boolean }
