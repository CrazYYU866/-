import type { Tone } from '@kovsh/mobile';

export type VisibleStatus = 'new' | 'in_progress' | 'completed' | 'cancelled' | 'disputed';

export interface OrderListItem {
  id: string;
  number: number;
  status: string;
  visibleStatus: VisibleStatus;
  category: string;
  siteAddress: string;
  firstStartAt: string;
  totalKopecks: number;
}

export interface Operator { userId: string; fullName: string | null; photoFileId: string | null; rating: number | null }

export interface OrderView {
  id: string;
  number: number;
  status: string;
  visibleStatus: VisibleStatus;
  category: string;
  site: { lat: number; lng: number; address: string; comment: string | null };
  urgency: 'urgent' | 'scheduled';
  totalHours: number;
  shifts: { id: string; seq: number; start: string; end: string; hours: number; status: string; operator: Operator | null }[];
  partner: { name: string } | null;
  equipment: { id: string; brand: string; model: string; regNumber: string | null; year: number | null; photoFileIds: string[] } | null;
  history: { status: string; from: string | null; reason: string | null; actor: string; at: string }[];
  price: {
    rentKopecks: number;
    deliveryKopecks: number;
    deliveryKm: number;
    totalKopecks: number;
    payerKind: 'individual' | 'legal' | null;
    firstPaymentKopecks: number;
    paidKopecks: number;
    refundedKopecks: number;
    extraHours: number;
    extraKopecks: number;
    discountKopecks: number;
    payableKopecks: number;
    remainingKopecks: number;
    prepaid: boolean;
  };
  /** Отмена после оплаты: решение поддержки по возврату. */
  refundReview: { status: 'in_review' | 'decided'; decision: 'full_refund' | 'partial_refund' | 'full_retention' | null; refundKopecks: number | null; reason: string | null; decidedAt: string | null } | null;
}

/** Три статуса, которые видит заказчик (ТЗ §11), плюс отмена и спор. */
export const VISIBLE_UI: Record<VisibleStatus, { label: string; tone: Tone }> = {
  new: { label: 'Новый', tone: 'info' },
  in_progress: { label: 'В работе', tone: 'accent' },
  completed: { label: 'Завершён', tone: 'success' },
  cancelled: { label: 'Отменён', tone: 'neutral' },
  disputed: { label: 'Спор', tone: 'warning' },
};

/** Пояснение «что сейчас происходит» — простым языком, без внутренних статусов. */
export function whatNow(status: string): string {
  switch (status) {
    case 'awaiting_customer_confirmation': return 'Диспетчер оформил для вас заявку. Проверьте условия и подтвердите.';
    case 'searching':
    case 'offered': return 'Ищем исполнителя. Сообщим, как только заказ примут.';
    case 'search_failed': return 'Не нашли свободного исполнителя. Если вы платили — деньги вернутся полностью.';
    case 'accepted':
    case 'awaiting_prepayment': return 'Исполнитель найден. Оплатите заказ, чтобы закрепить технику.';
    case 'cancelled_unpaid': return 'Заказ отменён: оплата не поступила вовремя.';
    case 'awaiting_assignment': return 'Оплата получена. Компания назначает машиниста.';
    case 'assigned': return 'Машинист назначен. Сообщим, когда он выедет.';
    case 'en_route': return 'Машинист едет к вам.';
    case 'arrived': return 'Машинист на объекте.';
    case 'in_progress': return 'Идёт работа.';
    case 'awaiting_completion_confirmation': return 'Машинист закончил работу. Подтвердите завершение или сообщите о проблеме.';
    case 'awaiting_final_payment': return 'Работа завершена. Оплатите оставшуюся часть.';
    case 'completed': return 'Заказ завершён. Спасибо!';
    case 'cancelled': return 'Заказ отменён.';
    case 'refund_pending': return 'Заказ отменён. Поддержка рассматривает возврат.';
    case 'disputed': return 'Открыт спор. Поддержка свяжется с вами.';
    default: return '';
  }
}

export const SHIFT_UI: Record<string, string> = {
  pending: 'Ожидает', en_route: 'Машинист выехал', arrived: 'Прибыл', in_progress: 'Работает', finished: 'Завершена', cancelled: 'Отменена',
};

export const CHAT_OPEN = ['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress', 'awaiting_completion_confirmation', 'awaiting_final_payment', 'disputed'];
