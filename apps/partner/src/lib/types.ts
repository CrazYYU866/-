import type { Operator } from './shared';
export type { Operator };

export interface PartnerOrder {
  id: string;
  number: number;
  status: string;
  category: string;
  site: { lat: number; lng: number; address: string; comment: string | null };
  urgency: 'urgent' | 'scheduled';
  totalHours: number;
  shifts: { id: string; seq: number; start: string; end: string; hours: number; status: string; operator: Operator | null }[];
  partner: { name: string } | null;
  equipment: { id: string; brand: string; model: string; regNumber: string | null; year: number | null } | null;
  history: { status: string; from: string | null; reason: string | null; actor: string; at: string }[];
  partnerPrice?: { amountKopecks: number | null; deliveryKm: number | null; final: boolean };
  customerPaymentStatus?: 'not_paid' | 'partially_paid' | 'paid';
}

export const SHIFT_LABEL: Record<string, string> = {
  pending: 'Ожидает', en_route: 'В пути', arrived: 'На объекте', in_progress: 'Работает', finished: 'Завершена', cancelled: 'Отменена',
};
export const PAYMENT_LABEL = { not_paid: 'Заказчик ещё не оплатил', partially_paid: 'Оплачено частично', paid: 'Оплачено заказчиком' } as const;
