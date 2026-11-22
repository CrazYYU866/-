import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { normalizePhone } from '../auth/phone';
import { SMS_PROVIDER, type SmsProvider } from '../auth/sms/sms.provider';
import { UsersService } from '../users/users.service';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CancellationDecisionSchema, ERROR_CODES, InviteCustomerEmployeeSchema, LegalProfileSchema, ReasonSchema, type CancellationDecision, type LegalProfileInput } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { AdminAuthGuard, AdminRoles, CurrentAdmin, type AuthAdmin } from '../admin/admin-auth.guard';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ACC, LedgerService } from '../finance/ledger.service';
import { OrderCore } from '../orders/order-core';
import { CurrentOrg, OrgContextGuard, OrgRoles, type OrgContext } from '../organizations/org-context.guard';
import { isValidInn } from '../organizations/requisites';
import { CancellationService } from './cancellation.service';
import { PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';

const clientOnly = (u: AuthUser) => {
  if (u.app !== 'client') throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно в приложении заказчика', HttpStatus.FORBIDDEN);
};

@ApiTags('client: оплата')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client')
export class ClientFinanceController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly core: OrderCore,
    private readonly users: UsersService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  /** Организации заказчика, к которым у пользователя есть доступ (Н-30). */
  @Get('organizations')
  async organizations(@CurrentUser() u: AuthUser) {
    clientOnly(u);
    const res = await this.core.db.execute(sql`
      SELECT p.id, p.inn, p.kpp, p.name, p.legal_address, p.email, m.role
      FROM customer_org_members m JOIN customer_legal_profiles p ON p.id = m.profile_id
      WHERE m.user_id = ${u.userId} AND m.status = 'active' AND p.archived_at IS NULL ORDER BY p.name`);
    return res.rows;
  }

  /** Добавить организацию: создатель становится руководителем. Один ИНН — одна организация (Н-30). */
  @Post('organizations')
  async addOrganization(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(LegalProfileSchema)) dto: LegalProfileInput) {
    clientOnly(u);
    if (!isValidInn(dto.inn)) throw new AppException(ERROR_CODES.INVALID_INN, 'Проверьте ИНН', HttpStatus.BAD_REQUEST);
    return this.core.db.transaction(async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        INSERT INTO customer_legal_profiles (user_id, inn, kpp, name, legal_address, email)
        VALUES (${u.userId}, ${dto.inn}, ${dto.kpp ?? null}, ${dto.name}, ${dto.legalAddress}, ${dto.email})
        ON CONFLICT DO NOTHING RETURNING id`);
      const id = res.rows[0]?.id;
      if (!id) {
        throw new AppException(ERROR_CODES.CUSTOMER_ORG_EXISTS, 'Организация с этим ИНН уже добавлена — попросите её руководителя пригласить вас', HttpStatus.CONFLICT);
      }
      await tx.execute(sql`INSERT INTO customer_org_members (profile_id, user_id, role, status) VALUES (${id}, ${u.userId}, 'owner', 'active')`);
      return { id, inn: dto.inn, kpp: dto.kpp ?? null, name: dto.name, legal_address: dto.legalAddress, email: dto.email, role: 'owner' };
    });
  }

  @Get('organizations/:id/members')
  async members(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    clientOnly(u);
    await this.assertCustomerOrgOwner(u.userId, id);
    const res = await this.core.db.execute(sql`
      SELECT m.id, m.role, m.status, u.phone, u.full_name FROM customer_org_members m JOIN users u ON u.id = m.user_id
      WHERE m.profile_id = ${id} AND m.status <> 'removed' ORDER BY m.created_at`);
    return res.rows;
  }

  /** Руководитель приглашает сотрудника по телефону и даёт доступ к оформлению заказов от имени организации. */
  @Post('organizations/:id/members')
  async invite(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(InviteCustomerEmployeeSchema)) dto: { phone: string }) {
    clientOnly(u);
    const org = await this.assertCustomerOrgOwner(u.userId, id);
    const { user } = await this.users.findOrCreateByPhone(normalizePhone(dto.phone));
    const res = await this.core.db.execute<{ id: string }>(sql`
      INSERT INTO customer_org_members (profile_id, user_id, role, status, invited_by) VALUES (${id}, ${user.id}, 'employee', 'invited', ${u.userId})
      ON CONFLICT (profile_id, user_id) DO UPDATE SET status = 'invited', updated_at = now() WHERE customer_org_members.status = 'removed'
      RETURNING id`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.CONFLICT, 'Этот человек уже есть в организации', HttpStatus.CONFLICT);
    await this.sms.send(user.phone, `Вас пригласили оформлять заказы от имени «${org.name}» в приложении «Ковш на Час».`);
    return { id: res.rows[0].id, status: 'invited' };
  }

  @Delete('organizations/:id/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('memberId', ParseUUIDPipe) memberId: string): Promise<void> {
    clientOnly(u);
    await this.assertCustomerOrgOwner(u.userId, id);
    await this.core.db.execute(sql`UPDATE customer_org_members SET status = 'removed', updated_at = now() WHERE id = ${memberId} AND profile_id = ${id} AND role <> 'owner'`);
  }

  @Get('organization-invitations')
  async invitations(@CurrentUser() u: AuthUser) {
    clientOnly(u);
    const res = await this.core.db.execute(sql`
      SELECT m.id, p.name, p.inn FROM customer_org_members m JOIN customer_legal_profiles p ON p.id = m.profile_id
      WHERE m.user_id = ${u.userId} AND m.status = 'invited'`);
    return res.rows;
  }

  @Post('organization-invitations/:id/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  async acceptInvitation(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    clientOnly(u);
    const res = await this.core.db.execute(sql`UPDATE customer_org_members SET status = 'active', updated_at = now() WHERE id = ${id} AND user_id = ${u.userId} AND status = 'invited' RETURNING id`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.NOT_FOUND, 'Приглашение не найдено', HttpStatus.NOT_FOUND);
  }

  private async assertCustomerOrgOwner(userId: string, profileId: string): Promise<{ name: string }> {
    const res = await this.core.db.execute<{ name: string }>(sql`
      SELECT p.name FROM customer_org_members m JOIN customer_legal_profiles p ON p.id = m.profile_id
      WHERE m.profile_id = ${profileId} AND m.user_id = ${userId} AND m.role = 'owner' AND m.status = 'active'`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.NOT_FOUND, 'Организация не найдена', HttpStatus.NOT_FOUND);
    return res.rows[0];
  }

  @Post('orders/:id/payments')
  pay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    clientOnly(u);
    return this.payments.create(u.userId, id);
  }

  @Get('orders/:id/payments')
  list(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    clientOnly(u);
    return this.payments.list(u.userId, id);
  }

  @Get('debts')
  async debts(@CurrentUser() u: AuthUser) {
    clientOnly(u);
    const res = await this.core.db.execute(sql`SELECT id, order_id, amount_kopecks, status, created_at FROM customer_debts WHERE customer_id = ${u.userId} ORDER BY created_at DESC`);
    return res.rows;
  }
}

/** Уведомления платёжного провайдера. */
@ApiTags('webhooks')
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<{ ok: true }> {
    await this.payments.handleWebhook(req.headers, req.body);
    return { ok: true };
  }
}

/** Тестовая страница оплаты (только тестовый провайдер, вне production). */
@ApiTags('dev')
@Controller('dev/payments')
export class DevPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get(':providerPaymentId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(@Param('providerPaymentId') id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Тестовая оплата</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h1>Тестовая оплата</h1><p>Это тестовый режим: деньги не списываются.</p>
<form method="post" action="${safe}/succeed"><button style="padding:12px 20px">Оплатить</button></form><br>
<form method="post" action="${safe}/cancel"><button style="padding:12px 20px">Отказаться</button></form></body></html>`;
  }

  @Post(':providerPaymentId/succeed')
  @HttpCode(HttpStatus.OK)
  async succeed(@Param('providerPaymentId') id: string) {
    await this.payments.devComplete(id, 'succeeded');
    return { ok: true, message: 'Оплата прошла (тестовый режим)' };
  }

  @Post(':providerPaymentId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('providerPaymentId') id: string) {
    await this.payments.devComplete(id, 'cancelled');
    return { ok: true, message: 'Оплата отменена (тестовый режим)' };
  }
}

@ApiTags('admin: финансы')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminFinanceController {
  constructor(
    private readonly cancellations: CancellationService,
    private readonly payouts: PayoutsService,
    private readonly ledger: LedgerService,
    private readonly core: OrderCore,
  ) {}

  @Get('cancellation-reviews')
  @AdminRoles('superadmin', 'support', 'finance')
  reviews(@Query('status') status?: string) {
    return this.cancellations.list(status);
  }

  @Post('cancellation-reviews/:orderId/decide')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  decide(@CurrentAdmin() a: AuthAdmin, @Param('orderId', ParseUUIDPipe) orderId: string, @Body(new ZodValidationPipe(CancellationDecisionSchema)) dto: CancellationDecision) {
    return this.cancellations.decide(orderId, dto.retainedKopecks, dto.reason, a);
  }

  @Post('cancellation-reviews/:orderId/approve')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'finance')
  approve(@CurrentAdmin() a: AuthAdmin, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.cancellations.approve(orderId, a);
  }

  @Post('cancellation-reviews/:orderId/reject')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'finance')
  reject(@CurrentAdmin() a: AuthAdmin, @Param('orderId', ParseUUIDPipe) orderId: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }) {
    return this.cancellations.reject(orderId, dto.reason, a);
  }

  @Get('payments')
  @AdminRoles('superadmin', 'finance', 'support')
  async paymentsList(@Query('orderId') orderId?: string) {
    const res = await this.core.db.execute(sql`SELECT * FROM payments ${orderId ? sql`WHERE order_id = ${orderId}` : sql``} ORDER BY created_at DESC LIMIT 500`);
    return res.rows;
  }

  @Get('orders/:id/ledger')
  @AdminRoles('superadmin', 'finance')
  async orderLedger(@Param('id', ParseUUIDPipe) id: string) {
    const res = await this.core.db.execute(sql`
      SELECT t.kind, t.idempotency_key, t.created_at, e.account, e.amount_kopecks
      FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.order_id = ${id} ORDER BY t.id, e.id`);
    return res.rows;
  }

  @Get('payouts')
  @AdminRoles('superadmin', 'finance')
  async payoutsList() {
    const res = await this.core.db.execute(sql`SELECT p.*, o.name AS org_name FROM payouts p JOIN organizations o ON o.id = p.org_id ORDER BY p.created_at DESC LIMIT 500`);
    return res.rows;
  }

  @Post('payouts/run')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'finance')
  runPayouts() {
    return this.payouts.run();
  }

  @Get('debts')
  @AdminRoles('superadmin', 'finance', 'support')
  async debts(@Query('status') status?: string) {
    const res = await this.core.db.execute(sql`SELECT * FROM customer_debts ${status ? sql`WHERE status = ${status}` : sql``} ORDER BY created_at DESC LIMIT 500`);
    return res.rows;
  }

  @Get('finance/summary')
  @AdminRoles('superadmin', 'finance')
  async summary() {
    const res = await this.core.db.execute<{ account: string; balance: string }>(sql`
      SELECT split_part(account, ':', 1) || CASE WHEN account LIKE 'platform:%' OR account LIKE 'cash:%' THEN ':' || split_part(account, ':', 2) ELSE '' END AS account,
             sum(amount_kopecks) AS balance
      FROM ledger_entries GROUP BY 1 ORDER BY 1`);
    return res.rows.map((r) => ({ account: r.account, balanceKopecks: Number(r.balance) }));
  }
}

/** Финансы компании и независимого диспетчера: только руководители (Р-1, Р-10, Н-22). */
@ApiTags('partner: финансы')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtAuthGuard, OrgContextGuard)
@OrgRoles('owner', 'manager')
@Controller('partner/finance')
export class PartnerFinanceController {
  constructor(private readonly ledger: LedgerService, private readonly core: OrderCore) {}

  @Get('summary')
  async summary(@CurrentOrg() org: OrgContext) {
    const account = org.orgKind === 'agent' ? ACC.agent(org.orgId) : ACC.partner(org.orgId);
    const res = await this.core.db.execute<{ accrued: string | null; paid: string | null }>(sql`
      SELECT -sum(amount_kopecks) FILTER (WHERE amount_kopecks < 0) AS accrued, sum(amount_kopecks) FILTER (WHERE amount_kopecks > 0) AS paid
      FROM ledger_entries WHERE account = ${account}`);
    const accrued = Number(res.rows[0]?.accrued ?? 0);
    const paid = Number(res.rows[0]?.paid ?? 0);
    return { accruedKopecks: accrued, paidOutKopecks: paid, balanceKopecks: accrued - paid };
  }

  @Get('payouts')
  async payouts(@CurrentOrg() org: OrgContext) {
    const res = await this.core.db.execute(sql`SELECT id, kind, payout_date, amount_kopecks, status, paid_at FROM payouts WHERE org_id = ${org.orgId} ORDER BY payout_date DESC`);
    return res.rows;
  }

  @Get('accruals')
  async accruals(@CurrentOrg() org: OrgContext) {
    const account = org.orgKind === 'agent' ? ACC.agent(org.orgId) : ACC.partner(org.orgId);
    const res = await this.core.db.execute(sql`
      SELECT t.kind, t.order_id, o.number, -sum(e.amount_kopecks) AS amount_kopecks, t.created_at
      FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id LEFT JOIN orders o ON o.id = t.order_id
      WHERE e.account = ${account} AND t.kind <> 'payout' GROUP BY t.id, o.number ORDER BY t.created_at DESC`);
    return res.rows;
  }
}
