export interface CreatePaymentInput {
  amountKopecks: number;
  description: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface CreatedPayment {
  providerPaymentId: string;
  /** Страница оплаты, на которую приложение отправляет заказчика. */
  confirmationUrl: string;
}

export interface PaymentEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.cancelled';
  providerPaymentId: string;
  amountKopecks: number;
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
  parseWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): PaymentEvent;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
