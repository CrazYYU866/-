import { randomUUID } from 'node:crypto';
import type { CreatedPayment, CreatePaymentInput, PaymentEvent, PaymentProvider } from './payment.provider';

/**
 * ТЕСТОВЫЙ платёжный провайдер для разработки и демонстрации, пока нет договора с ЮKassa.
 * Деньги не списываются: страница оплаты — служебная ссылка «оплатить / отказ». В production запрещён конфигурацией.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly name = 'dev';
  constructor(private readonly publicBaseUrl: string) {}

  async createPayment(_input: CreatePaymentInput): Promise<CreatedPayment> {
    const id = `devpay_${randomUUID()}`;
    return { providerPaymentId: id, confirmationUrl: `${this.publicBaseUrl}/api/v1/dev/payments/${id}` };
  }

  async refund(): Promise<{ providerRefundId: string; status: 'succeeded' }> {
    return { providerRefundId: `devref_${randomUUID()}`, status: 'succeeded' };
  }

  async payout(): Promise<{ providerPayoutId: string; status: 'succeeded' }> {
    return { providerPayoutId: `devout_${randomUUID()}`, status: 'succeeded' };
  }

  parseWebhook(_headers: Record<string, string | string[] | undefined>, body: unknown): PaymentEvent {
    const b = body as Partial<PaymentEvent>;
    if (!b.eventId || !b.type || !b.providerPaymentId || typeof b.amountKopecks !== 'number') throw new Error('Некорректное уведомление');
    return b as PaymentEvent;
  }
}
