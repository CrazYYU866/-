import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ORDER_STATUSES, toCustomerVisibleStatus, type OrderStatus } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AdminAuthGuard, AdminRoles, CurrentAdmin, type AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrderCore } from './order-core';
import { OrdersService } from './orders.service';

const ListQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Все заказы и их статусы (ТЗ §2.3: «просматривать все заказы, отслеживать статусы»). */
const ResolveDispute = z.object({ outcome: z.enum(['accept_work', 'cancel']), reason: z.string().trim().min(3).max(2000) });

@ApiTags('admin: заказы')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminOrdersController {
  constructor(private readonly core: OrderCore, private readonly orders: OrdersService, private readonly audit: AuditService) {}

  /** Закрыть спор (С-35): «работа принята» — обычное завершение; «отменить» — отмена с решением поддержки по возврату. */
  @Post('orders/:id/dispute/resolve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminRoles('superadmin', 'support')
  async resolveDispute(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ResolveDispute)) dto: z.infer<typeof ResolveDispute>): Promise<void> {
    await this.orders.resolveDispute(id, a.adminId, dto.outcome, dto.reason);
    await this.audit.log({ adminId: a.adminId, action: `dispute.${dto.outcome}`, entity: 'order', entityId: id, reason: dto.reason, ip: a.ip });
  }

  @Get('orders')
  async list(@Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    const digits = q.q?.replace(/\D/g, '') ?? '';
    const res = await this.core.db.execute<{ id: string; number: string; status: OrderStatus; created_at: Date; first_start_at: Date; total_kopecks: string; site_address: string; category: string; customer_phone: string; partner_name: string | null; agent_name: string | null }>(sql`
      SELECT o.id, o.number, o.status, o.created_at, o.first_start_at, o.total_kopecks, o.site_address, c.name AS category,
             u.phone AS customer_phone, p.name AS partner_name, a.name AS agent_name
      FROM orders o JOIN equipment_categories c ON c.id = o.category_id JOIN users u ON u.id = o.customer_id
      LEFT JOIN organizations p ON p.id = o.partner_org_id LEFT JOIN organizations a ON a.id = o.agent_org_id
      WHERE TRUE
        ${q.status ? sql`AND o.status = ${q.status}` : sql``}
        ${q.q ? sql`AND (o.number::text = ${digits} OR u.phone LIKE ${'%' + digits + '%'} OR p.name ILIKE ${'%' + q.q + '%'})` : sql``}
      ORDER BY o.created_at DESC LIMIT ${q.limit}`);
    return res.rows.map((r) => ({
      id: r.id, number: Number(r.number), status: r.status, visibleStatus: toCustomerVisibleStatus(r.status), category: r.category,
      siteAddress: r.site_address, customerPhone: r.customer_phone, partnerName: r.partner_name, agentName: r.agent_name,
      totalKopecks: Number(r.total_kopecks), firstStartAt: new Date(r.first_start_at).toISOString(), createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  @Get('orders/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const order = await this.core.get(id);
    const [view, customer, payments, review, offers] = await Promise.all([
      this.orders.view(order, 'admin'),
      this.core.db.execute(sql`SELECT id, phone, full_name FROM users WHERE id = ${order.customer_id}`),
      this.core.db.execute(sql`SELECT id, part, amount_kopecks, provider, status, created_at, paid_at FROM payments WHERE order_id = ${id} ORDER BY created_at`),
      this.core.db.execute(sql`SELECT * FROM cancellation_reviews WHERE order_id = ${id}`),
      this.core.db.execute(sql`
        SELECT f.id, o.name AS org_name, f.status, f.radius_km, f.distance_km, f.score, f.offered_at, f.responded_at
        FROM order_offers f JOIN organizations o ON o.id = f.org_id WHERE f.order_id = ${id} ORDER BY f.offered_at`),
    ]);
    return { ...view, customer: customer.rows[0], payments: payments.rows, cancellationReview: review.rows[0] ?? null, offers: offers.rows };
  }

  /** Сводка для главной страницы админки. */
  @Get('dashboard')
  async dashboard() {
    const res = await this.core.db.execute<Record<string, number>>(sql`
      SELECT
        (SELECT count(*)::int FROM organizations WHERE status = 'pending_review') AS orgs_pending,
        (SELECT count(*)::int FROM documents WHERE status = 'uploaded' AND superseded_at IS NULL) AS documents_pending,
        (SELECT count(*)::int FROM equipment_units WHERE verification_status = 'pending' AND archived_at IS NULL) AS equipment_pending,
        (SELECT count(*)::int FROM cancellation_reviews WHERE status = 'pending') AS cancellations_pending,
        (SELECT count(*)::int FROM cancellation_reviews WHERE status = 'awaiting_approval') AS refunds_awaiting_approval,
        (SELECT count(*)::int FROM customer_debts WHERE status = 'open') AS debts_open,
        (SELECT count(*)::int FROM rating_complaints WHERE status = 'open') AS rating_complaints_open,
        (SELECT count(*)::int FROM orders WHERE status = 'disputed') AS disputes_open,
        (SELECT count(*)::int FROM orders WHERE status IN ('searching', 'offered')) AS orders_searching,
        (SELECT count(*)::int FROM orders WHERE status IN ('awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress', 'awaiting_completion_confirmation')) AS orders_active,
        (SELECT count(*)::int FROM orders WHERE created_at > now() - interval '1 day') AS orders_today,
        (SELECT count(*)::int FROM equipment_units WHERE is_online) AS units_online`);
    return res.rows[0];
  }
}
