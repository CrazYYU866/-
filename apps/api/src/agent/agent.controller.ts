import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AgentOrderSchema, AgentQuoteRequestSchema, ERROR_CODES, toCustomerVisibleStatus, type AgentQuoteRequest, type OrderStatus } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { normalizePhone } from '../auth/phone';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { OrderCore } from '../orders/order-core';
import { OrdersService } from '../orders/orders.service';
import { CurrentOrg, OrgContextGuard, OrgRoles, type OrgContext } from '../organizations/org-context.guard';
import { PricingService } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

/**
 * Независимый диспетчер (К-12, Н-27, Н-30): в приложении партнёра оформляет заявку за фактического заказчика.
 * Не платит за клиента, не подтверждает выполнение и не отвечает за долг заказчика.
 */
@ApiTags('partner: независимый диспетчер')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtAuthGuard, OrgContextGuard)
@OrgRoles('owner', 'manager', 'dispatcher')
@Controller('partner/agent')
export class AgentController {
  constructor(
    private readonly pricing: PricingService,
    private readonly orders: OrdersService,
    private readonly users: UsersService,
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  private assertAgent(org: OrgContext): void {
    if (org.orgKind !== 'agent') throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно независимым диспетчерам', HttpStatus.FORBIDDEN);
    if (org.orgStatus !== 'verified') throw new AppException(ERROR_CODES.ORG_NOT_VERIFIED, 'Организация ещё не прошла проверку', HttpStatus.FORBIDDEN);
  }

  @Post('quotes')
  async quote(@CurrentOrg() org: OrgContext, @Body(new ZodValidationPipe(AgentQuoteRequestSchema)) dto: AgentQuoteRequest) {
    this.assertAgent(org);
    const { customerPhone, ...req } = dto;
    const { user } = await this.users.findOrCreateByPhone(normalizePhone(customerPhone));
    const quote = await this.pricing.quote(user.id, req, new Date(), org.orgId);
    return { ...quote, customerPhone: user.phone };
  }

  @Post('orders')
  async create(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(AgentOrderSchema)) dto: { quoteId: string; siteComment?: string }) {
    this.assertAgent(org);
    return this.orders.createForAgent(org.orgId, u.userId, dto.quoteId, dto.siteComment, this.env.PUBLIC_BASE_URL);
  }

  @Get('orders')
  async list(@CurrentOrg() org: OrgContext) {
    this.assertAgent(org);
    const agentPct = await this.settings.get('agent_commission_percent');
    const res = await this.core.db.execute<{ id: string; number: string; status: OrderStatus; phone: string; total_kopecks: string; extra_kopecks: string; agent_kopecks: string | null; site_address: string; first_start_at: Date; category: string }>(sql`
      SELECT o.id, o.number, o.status, u.phone, o.total_kopecks, o.extra_kopecks, o.agent_kopecks, o.site_address, o.first_start_at, c.name AS category
      FROM orders o JOIN users u ON u.id = o.customer_id JOIN equipment_categories c ON c.id = o.category_id
      WHERE o.agent_org_id = ${org.orgId} ORDER BY o.created_at DESC LIMIT 200`);
    return res.rows.map((r) => ({
      id: r.id, number: Number(r.number), status: r.status, visibleStatus: toCustomerVisibleStatus(r.status), customerPhone: r.phone,
      category: r.category, siteAddress: r.site_address, firstStartAt: new Date(r.first_start_at).toISOString(), totalKopecks: Number(r.total_kopecks),
      // Вознаграждение — 7% от полной суммы заказа (Ф-1); окончательное — после завершения.
      rewardKopecks: r.agent_kopecks !== null ? Number(r.agent_kopecks) : Math.round(((Number(r.total_kopecks) + Number(r.extra_kopecks)) * agentPct) / 100),
      rewardFinal: r.agent_kopecks !== null,
    }));
  }

  @Get('orders/:id')
  async get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    this.assertAgent(org);
    const order = await this.core.get(id);
    if (order.agent_org_id !== org.orgId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    // Диспетчер видит заказ и статусы, но не управляет оплатой и подтверждением (Н-27).
    return this.orders.view(order, 'operator');
  }
}
