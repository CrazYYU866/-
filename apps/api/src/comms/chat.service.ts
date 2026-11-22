import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type ChatChannel } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { OrderCore } from '../orders/order-core';
import { RealtimeGateway } from './realtime.gateway';

const OPEN = ['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress', 'awaiting_completion_confirmation', 'awaiting_final_payment', 'disputed'];

/**
 * Чат по заказу (ТЗ §10, П-14): канал заказа — заказчик, машинист, диспетчеры и руководители компании;
 * внутренний канал — только компания и машинист. Открыт после принятия заказа; после завершения — только чтение.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly core: OrderCore,
    private readonly realtime: RealtimeGateway,
  ) {}

  private async access(orderId: string, userId: string, channel: ChatChannel) {
    const p = await this.core.participant(orderId, userId);
    const allowed = channel === 'order' ? p.customer || p.operator || p.staffRole : p.operator || p.staffRole;
    if (!allowed) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    const role = p.customer ? 'customer' : p.operator ? 'operator' : (p.staffRole as string);
    return { ...p, role };
  }

  async list(orderId: string, userId: string, channel: ChatChannel, afterId = 0) {
    await this.access(orderId, userId, channel);
    const res = await this.core.db.execute(sql`
      SELECT m.id, m.sender_user_id, m.sender_role, u.full_name AS sender_name, m.body, m.created_at
      FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.order_id = ${orderId} AND m.channel = ${channel} AND m.id > ${afterId} ORDER BY m.id LIMIT 500`);
    return res.rows;
  }

  async send(orderId: string, userId: string, channel: ChatChannel, body: string) {
    const a = await this.access(orderId, userId, channel);
    if (!OPEN.includes(a.order.status)) throw new AppException(ERROR_CODES.CHAT_CLOSED, 'Чат по этому заказу закрыт', HttpStatus.CONFLICT);
    const res = await this.core.db.execute<{ id: number; created_at: Date }>(sql`
      INSERT INTO chat_messages (order_id, channel, sender_user_id, sender_role, body) VALUES (${orderId}, ${channel}, ${userId}, ${a.role}, ${body})
      RETURNING id, created_at`);
    const msg = { id: res.rows[0]?.id, orderId, channel, senderUserId: userId, senderRole: a.role, body, createdAt: res.rows[0]?.created_at };
    this.realtime.toOrder(orderId, 'chat.message', msg);
    const recipients = await this.recipients(a.order, channel, userId);
    await this.core.events.emit({ type: 'chat.message', orderId, userIds: recipients, payload: { channel, preview: body.slice(0, 120) } });
    return msg;
  }

  async markRead(orderId: string, userId: string, channel: ChatChannel, lastReadId: number): Promise<void> {
    await this.access(orderId, userId, channel);
    await this.core.db.execute(sql`
      INSERT INTO chat_reads (order_id, channel, user_id, last_read_id) VALUES (${orderId}, ${channel}, ${userId}, ${lastReadId})
      ON CONFLICT (order_id, channel, user_id) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`);
  }

  /** Просмотр переписки администрацией — с записью в журнал (В-27). */
  async adminList(orderId: string) {
    const res = await this.core.db.execute(sql`
      SELECT m.id, m.channel, m.sender_role, u.full_name AS sender_name, u.phone AS sender_phone, m.body, m.created_at
      FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.order_id = ${orderId} ORDER BY m.id`);
    return res.rows;
  }

  private async recipients(order: { id: string; customer_id: string; partner_org_id: string | null }, channel: ChatChannel, senderId: string): Promise<string[]> {
    const staff = order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id) : [];
    const operators = await this.core.operatorsOf(order.id);
    const all = channel === 'order' ? [order.customer_id, ...staff, ...operators] : [...staff, ...operators];
    return [...new Set(all)].filter((u) => u !== senderId);
  }
}
