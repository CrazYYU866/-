export interface CreatePaymentInput {
  amountKopecks: number;
  description: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
  receipt?: ReceiptInput;
}

export interface CreatedPayment {
  providerPaymentId: string;
  /** Страница оплаты, на которую приложение отправляет заказчика. */
  confirmationUrl: string;
}

/**
 * Уведомления провайдера. Возвраты и выплаты у реальных провайдеров часто завершаются не сразу,
 * поэтому их итог тоже приходит уведомлением.
 */
export type PaymentEvent =
  | { eventId: string; type: 'payment.succeeded' | 'payment.cancelled'; providerPaymentId: string; amountKopecks: number }
  | { eventId: string; type: 'refund.succeeded' | 'refund.cancelled'; providerRefundId: string; reason?: string }
  | { eventId: string; type: 'payout.succeeded' | 'payout.cancelled'; providerPayoutId: string; reason?: string };

/**
 * Данные чека (54-ФЗ). Кто формирует чек, ставки НДС, предмет и способ расчёта определяют юрист и бухгалтер
 * (В-34, Н-23); до их решения чек не передаётся. Поле в интерфейсе есть, чтобы подключение не меняло архитектуру.
 */
export interface ReceiptInput {
  customer: { phone?: string; email?: string };
  items: { description: string; amountKopecks: number; quantity: number; vatCode: number; paymentSubject: string; paymentMode: string }[];
}

/**
 * Платёжный провайдер (ТЗ §14; В-34: ЮKassa, заменяемый). Бизнес-логика зависит только от интерфейса.
 */
export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  refund(providerPaymentId: string, amountKopecks: number, idempotencyKey: string): Promise<{ providerRefundId: string; status: 'succeeded' | 'pending' }>;
  payout(input: { amountKopecks: number; bik: string; accountNumber: string; recipientInn: string; idempotencyKey: string; description: string }): Promise<{ providerPayoutId: string; status: 'succeeded' | 'pending' }>;
  /** Проверить подлинность уведомления провайдера и разобрать его. */
  /**
   * Разобрать и проверить уведомление. Асинхронно: реальный провайдер может проверять подпись или
   * перезапрашивать статус объекта по API (ЮKassa рекомендует так подтверждать уведомления).
   */
  parseWebhook(headers: Record<string, string | string[] | undefined>, body: unknown, sourceIp?: string): Promise<PaymentEvent>;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
