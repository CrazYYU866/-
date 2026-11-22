import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  BroadcastSchema, CHAT_CHANNELS, ERROR_CODES, LocationBatchSchema, MarkNotificationsReadSchema, RateSchema, ReadMessagesSchema, ReasonSchema, SendMessageSchema,
  type Broadcast, type ChatChannel, type LocationBatch, type RateInput,
} from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AdminAuthGuard, AdminRoles, CurrentAdmin, type AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrderCore } from '../orders/order-core';
import { OrdersService } from '../orders/orders.service';
import { CurrentOrg, OrgContextGuard, type OrgContext } from '../organizations/org-context.guard';
import { CallsService } from './calls.service';
import { ChatService } from './chat.service';
import { NotificationsService } from './notifications.service';
import { RatingsService } from './ratings.service';
import { TrackingService } from './tracking.service';

const ChannelQuery = z.enum(CHAT_CHANNELS).default('order');
const AfterQuery = z.coerce.number().int().min(0).default(0);

/** Центр уведомлений — оба приложения. */
@ApiTags('уведомления')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService, private readonly ratings: RatingsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.notifications.list(u.userId);
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(MarkNotificationsReadSchema)) dto: { ids?: number[]; all?: boolean }): Promise<void> {
    await this.notifications.markRead(u.userId, dto.ids, dto.all);
  }
}

/** Жалоба на оценку — тот, кого оценили (ТЗ §15). */
@ApiTags('оценки')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ratings')
export class RatingComplaintsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post(':id/complaint')
  complain(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }) {
    return this.ratings.complain(id, u.userId, dto.reason);
  }
}

/** Связь, отслеживание и оценки по заказу — для заказчика и для сотрудников компании (права проверяются по роли в заказе). */
@ApiTags('заказ: связь, GPS, оценки')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class OrderCommsController {
  constructor(
    private readonly chat: ChatService,
    private readonly calls: CallsService,
    private readonly tracking: TrackingService,
    private readonly ratings: RatingsService,
  ) {}

  @Get(['client/orders/:id/chat', 'partner/orders/:id/chat', 'partner/operator/orders/:id/chat'])
  chatList(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('channel', new ZodValidationPipe(ChannelQuery)) channel: ChatChannel, @Query('after', new ZodValidationPipe(AfterQuery)) after: number) {
    return this.chat.list(id, u.userId, u.app === 'client' ? 'order' : channel, after);
  }

  @Post(['client/orders/:id/chat', 'partner/orders/:id/chat', 'partner/operator/orders/:id/chat'])
  chatSend(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('channel', new ZodValidationPipe(ChannelQuery)) channel: ChatChannel, @Body(new ZodValidationPipe(SendMessageSchema)) dto: { body: string }) {
    return this.chat.send(id, u.userId, u.app === 'client' ? 'order' : channel, dto.body);
  }

  @Post(['client/orders/:id/chat/read', 'partner/orders/:id/chat/read', 'partner/operator/orders/:id/chat/read'])
  @HttpCode(HttpStatus.NO_CONTENT)
  async chatRead(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('channel', new ZodValidationPipe(ChannelQuery)) channel: ChatChannel, @Body(new ZodValidationPipe(ReadMessagesSchema)) dto: { lastReadId: number }): Promise<void> {
    await this.chat.markRead(id, u.userId, u.app === 'client' ? 'order' : channel, dto.lastReadId);
  }

  @Post(['client/orders/:id/call', 'partner/orders/:id/call', 'partner/operator/orders/:id/call'])
  call(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.request(id, u.userId);
  }

  @Get(['client/orders/:id/tracking', 'partner/orders/:id/tracking'])
  track(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tracking.view(id, u.userId);
  }

  @Get(['client/orders/:id/ratings', 'partner/orders/:id/ratings'])
  orderRatings(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ratings.forOrder(id, u.userId);
  }

  @Post('client/orders/:id/ratings')
  rateOperator(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RateSchema)) dto: RateInput) {
    if (u.app !== 'client') throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно в приложении заказчика', HttpStatus.FORBIDDEN);
    return this.ratings.rateByCustomer(id, u.userId, dto);
  }

  @Post(['partner/orders/:id/ratings', 'partner/operator/orders/:id/ratings'])
  rateCustomer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RateSchema)) dto: RateInput) {
    if (u.app !== 'partner') throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно в приложении партнёра', HttpStatus.FORBIDDEN);
    return this.ratings.rateByPartner(id, u.userId, dto);
  }
}

/** Координаты телефона машиниста (ТЗ §9). */
@ApiTags('partner: машинист')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtAuthGuard, OrgContextGuard)
@Controller('partner/operator/locations')
export class OperatorLocationsController {
  constructor(private readonly tracking: TrackingService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  ingest(@CurrentOrg() org: OrgContext, @CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(LocationBatchSchema)) dto: LocationBatch) {
    return this.tracking.ingest(org, u.userId, dto);
  }
}

/** Связь и оценки по SMS-ссылке для фактического заказчика (Н-27). */
@ApiTags('public: заказ по ссылке')
@Controller('public/orders/:token')
export class PublicCommsController {
  constructor(
    private readonly orders: OrdersService,
    private readonly chat: ChatService,
    private readonly calls: CallsService,
    private readonly tracking: TrackingService,
    private readonly ratings: RatingsService,
  ) {}

  @Get('chat')
  async chatList(@Param('token') token: string, @Query('after', new ZodValidationPipe(AfterQuery)) after: number) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.chat.list(orderId, customerId, 'order', after);
  }

  @Post('chat')
  async chatSend(@Param('token') token: string, @Body(new ZodValidationPipe(SendMessageSchema)) dto: { body: string }) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.chat.send(orderId, customerId, 'order', dto.body);
  }

  @Post('call')
  async call(@Param('token') token: string) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.calls.request(orderId, customerId);
  }

  @Get('tracking')
  async track(@Param('token') token: string) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.tracking.view(orderId, customerId);
  }

  @Post('ratings')
  async rate(@Param('token') token: string, @Body(new ZodValidationPipe(RateSchema)) dto: RateInput) {
    const { orderId, customerId } = await this.orders.byLinkToken(token);
    return this.ratings.rateByCustomer(orderId, customerId, dto);
  }
}

@ApiTags('admin: связь и оценки')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminCommsController {
  constructor(
    private readonly chat: ChatService,
    private readonly tracking: TrackingService,
    private readonly ratings: RatingsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly core: OrderCore,
  ) {}

  /** Просмотр переписки — с записью в журнал (В-27). */
  @Get('orders/:id/chat')
  @AdminRoles('superadmin', 'support')
  async chatView(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    await this.audit.log({ adminId: a.adminId, action: 'chat.view', entity: 'order', entityId: id, ip: a.ip });
    return this.chat.adminList(id);
  }

  @Get('orders/:id/calls')
  @AdminRoles('superadmin', 'support')
  async callsView(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    await this.audit.log({ adminId: a.adminId, action: 'calls.view', entity: 'order', entityId: id, ip: a.ip });
    const res = await this.core.db.execute(sql`SELECT * FROM call_sessions WHERE order_id = ${id} ORDER BY created_at`);
    return res.rows;
  }

  @Get('orders/:id/tracking')
  @AdminRoles('superadmin', 'support')
  async trackingView(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    await this.audit.log({ adminId: a.adminId, action: 'gps.view', entity: 'order', entityId: id, ip: a.ip });
    const track = await this.core.db.execute(sql`
      SELECT ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, accuracy_m, phase, recorded_at, received_at
      FROM location_pings WHERE order_id = ${id} ORDER BY recorded_at`);
    return { current: await this.tracking.build(id), track: track.rows };
  }

  @Get('rating-complaints')
  @AdminRoles('superadmin', 'support', 'moderator')
  complaints(@Query('status') status?: string) {
    return this.ratings.complaints(status ?? 'open');
  }

  @Post('ratings/:id/hide')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support', 'moderator')
  hide(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }) {
    return this.ratings.setHidden(id, true, dto.reason, a);
  }

  @Post('ratings/:id/show')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support', 'moderator')
  show(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.ratings.setHidden(id, false, null, a);
  }

  @Post('broadcasts')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  async broadcast(@CurrentAdmin() a: AuthAdmin, @Body(new ZodValidationPipe(BroadcastSchema)) dto: Broadcast) {
    const recipients = await this.notifications.broadcast(dto.audience, dto.userId, dto.title, dto.body);
    await this.audit.log({ adminId: a.adminId, action: 'broadcast.send', entity: 'notification', entityId: null, after: { ...dto, recipients }, ip: a.ip });
    return { recipients };
  }
}
