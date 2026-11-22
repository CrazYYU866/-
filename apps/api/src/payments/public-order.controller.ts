import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfirmByLinkSchema, InvoiceRequestSchema, OptionalReasonSchema, ReasonSchema, type Payer } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrderCore } from '../orders/order-core';
import { OrdersService } from '../orders/orders.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';

/**
 * Заказ по SMS-ссылке без регистрации (Н-27, Н-30): фактический заказчик подтверждает заявку независимого диспетчера,
 * выбирает плательщика, оплачивает, подтверждает завершение или открывает спор. Доступ — по секретному токену из ссылки.
 */
@ApiTags('public: заказ по ссылке')
@Controller('public/orders/:token')
export class PublicOrderController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly core: OrderCore,
    private readonly invoices: InvoicesService,
  ) {}

  @Get()
  async view(@Param('token') token: string) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    const order = await this.orders.viewForCustomer(customerId, orderId);
    const orgs = await this.core.db.execute(sql`
      SELECT p.id, p.name, p.inn FROM customer_org_members m JOIN customer_legal_profiles p ON p.id = m.profile_id
      WHERE m.user_id = ${customerId} AND m.status = 'active' AND p.archived_at IS NULL ORDER BY p.name`);
    return { order, payerOptions: [{ kind: 'individual' }, ...orgs.rows.map((o) => ({ kind: 'legal', legalProfileId: o['id'], name: o['name'], inn: o['inn'] }))] };
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirm(@Param('token') token: string, @Body(new ZodValidationPipe(ConfirmByLinkSchema)) dto: { payer: Payer }): Promise<void> {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    await this.orders.confirmByCustomer(customerId, orderId, dto.payer);
  }

  @Post('payments')
  async pay(@Param('token') token: string) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.payments.create(customerId, orderId);
  }

  @Get('payments')
  async paymentsList(@Param('token') token: string) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.payments.list(customerId, orderId);
  }

  @Post('invoices')
  async invoice(@Param('token') token: string, @Body(new ZodValidationPipe(InvoiceRequestSchema)) dto: { part: 'first' | 'final' }) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.invoices.issue(customerId, orderId, dto.part);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@Param('token') token: string, @Body(new ZodValidationPipe(OptionalReasonSchema)) dto: { reason?: string }): Promise<void> {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    await this.orders.cancelByCustomer(customerId, orderId, dto.reason);
  }

  @Post('confirm-completion')
  @HttpCode(HttpStatus.NO_CONTENT)
  async complete(@Param('token') token: string): Promise<void> {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    await this.orders.confirmCompletion(customerId, orderId);
  }

  @Post('dispute')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dispute(@Param('token') token: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }): Promise<void> {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    await this.orders.openDispute(customerId, orderId, dto.reason);
  }

  @Post('extensions/:extId/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(@Param('token') token: string, @Param('extId', ParseUUIDPipe) ext: string): Promise<void> {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    await this.orders.decideExtension(customerId, orderId, ext, true);
  }

  @Post('extensions/:extId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(@Param('token') token: string, @Param('extId', ParseUUIDPipe) ext: string): Promise<void> {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    await this.orders.decideExtension(customerId, orderId, ext, false);
  }
}
