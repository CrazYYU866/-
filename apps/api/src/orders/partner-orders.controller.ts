import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AssignOperatorSchema, ERROR_CODES, ReasonSchema, ReplaceUnitSchema, ReportIncidentSchema, StatusEventsSchema, type AssignOperator, type ReportIncident, type StatusEvents } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentOrg, OrgContextGuard, OrgRoles, type OrgContext } from '../organizations/org-context.guard';
import { AssignmentService } from './assignment.service';
import { MatchingService } from './matching.service';
import { OperatorService } from './operator.service';
import { OrderCore } from './order-core';
import { OrdersService } from './orders.service';

/** Предложения и заказы компании (Р-1, Р-4, П-8, Н-22). */
@ApiTags('partner: заказы')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtAuthGuard, OrgContextGuard)
@OrgRoles('owner', 'manager', 'dispatcher')
@Controller('partner')
export class PartnerOrdersController {
  constructor(
    private readonly core: OrderCore,
    private readonly matching: MatchingService,
    private readonly assignment: AssignmentService,
    private readonly orders: OrdersService,
  ) {}

  @Get('offers')
  async offers(@CurrentOrg() org: OrgContext) {
    const res = await this.core.db.execute<{ id: string; order_id: string; expires_at: Date; distance_km: string; unit_id: string; category: string; site_address: string; first_start_at: Date; total_hours: number; urgency: string }>(sql`
      SELECT f.id, f.order_id, f.expires_at, f.distance_km, f.unit_id, c.name AS category, o.site_address, o.first_start_at, o.total_hours, o.urgency
      FROM order_offers f JOIN orders o ON o.id = f.order_id JOIN equipment_categories c ON c.id = o.category_id
      WHERE f.org_id = ${org.orgId} AND f.status = 'pending' AND f.expires_at > now() ORDER BY f.expires_at`);
    return res.rows.map((r) => ({
      offerId: r.id, orderId: r.order_id, expiresAt: new Date(r.expires_at).toISOString(), distanceKm: Number(r.distance_km), unitId: r.unit_id,
      category: r.category, siteAddress: r.site_address, firstStartAt: new Date(r.first_start_at).toISOString(), totalHours: r.total_hours, urgency: r.urgency,
    }));
  }

  @Post('offers/:id/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  async accept(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.matching.accept(id, org, u.userId);
  }

  @Post('offers/:id/skip')
  @HttpCode(HttpStatus.NO_CONTENT)
  async skip(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.matching.skip(id, org, u.userId);
  }

  @Get('orders')
  async list(@CurrentOrg() org: OrgContext) {
    const res = await this.core.db.execute<{ id: string }>(sql`SELECT id FROM orders WHERE partner_org_id = ${org.orgId} ORDER BY first_start_at DESC LIMIT 200`);
    return Promise.all(res.rows.map(async (r) => this.orders.view(await this.core.get(r.id), 'partner')));
  }

  @Get('orders/:id')
  async get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    const order = await this.core.get(id);
    if (order.partner_org_id !== org.orgId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    return this.orders.view(order, 'partner');
  }

  @Get('orders/:id/available-operators')
  operators(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Query('shiftId') shiftId?: string) {
    return this.assignment.availableOperators(org, id, shiftId);
  }

  @Post('orders/:id/assign-operator')
  @HttpCode(HttpStatus.NO_CONTENT)
  async assign(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AssignOperatorSchema)) dto: AssignOperator): Promise<void> {
    await this.assignment.assignOperator(org, u.userId, id, dto.memberId, dto.shiftId);
  }

  @Get('orders/:id/replacement-units')
  replacementUnits(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignment.replacementUnits(org, id);
  }

  @Post('orders/:id/replace-unit')
  @HttpCode(HttpStatus.NO_CONTENT)
  async replaceUnit(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReplaceUnitSchema)) dto: { unitId: string }): Promise<void> {
    await this.assignment.replaceUnit(org, u.userId, id, dto.unitId);
  }

  @Post('orders/:id/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  async release(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }): Promise<void> {
    await this.assignment.release(org, u.userId, id, dto.reason);
  }
}

/** Рабочий профиль машиниста (ТЗ §4, Р-17). Доступен любому сотруднику, работающему машинистом (в т. ч. ИП — П-13). */
@ApiTags('partner: машинист')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtAuthGuard, OrgContextGuard)
@Controller('partner/operator')
export class OperatorController {
  constructor(
    private readonly operator: OperatorService,
    private readonly assignment: AssignmentService,
    private readonly orders: OrdersService,
    private readonly core: OrderCore,
  ) {}

  private assertOperator(org: OrgContext): void {
    if (!org.canOperate) throw new AppException(ERROR_CODES.FORBIDDEN, 'Вы не работаете машинистом в этой компании', HttpStatus.FORBIDDEN);
  }

  @Get('orders')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser) {
    this.assertOperator(org);
    return this.operator.myOrders(org, u.userId);
  }

  @Get('orders/:id')
  async get(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    this.assertOperator(org);
    await this.operator.assertAssigned(org, u.userId, id);
    return this.orders.view(await this.core.get(id), 'operator');
  }

  @Post('orders/:id/status-events')
  @HttpCode(HttpStatus.OK)
  async events(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(StatusEventsSchema)) dto: StatusEvents) {
    this.assertOperator(org);
    await this.operator.assertAssigned(org, u.userId, id);
    return { results: await this.operator.applyEvents(org, u.userId, id, dto) };
  }

  @Post('orders/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async decline(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }): Promise<void> {
    this.assertOperator(org);
    await this.assignment.operatorDecline(org, u.userId, id, dto.reason);
  }

  @Post('orders/:id/incidents')
  incident(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReportIncidentSchema)) dto: ReportIncident) {
    this.assertOperator(org);
    return this.operator.reportIncident(org, u.userId, id, dto);
  }
}
