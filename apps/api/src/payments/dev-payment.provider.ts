import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { AppException } from '../common/app-exception';
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

  async parseWebhook(_headers: Record<string, string | string[] | undefined>, body: unknown): Promise<PaymentEvent> {
    const b = body as Record<string, unknown>;
    const ok =
      typeof b['eventId'] === 'string' &&
      ((String(b['type']).startsWith('payment.') && typeof b['providerPaymentId'] === 'string' && typeof b['amountKopecks'] === 'number') ||
        (String(b['type']).startsWith('refund.') && typeof b['providerRefundId'] === 'string') ||
        (String(b['type']).startsWith('payout.') && typeof b['providerPayoutId'] === 'string'));
    if (!ok) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Некорректное уведомление', HttpStatus.BAD_REQUEST);
    return b as unknown as PaymentEvent;
  }
}
