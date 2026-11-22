import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { OrderCore } from '../orders/order-core';
import { SettingsService } from '../settings/settings.service';
import { TELEPHONY_PROVIDER, type TelephonyProvider } from './telephony.provider';

const CALLABLE = ['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress', 'awaiting_completion_confirmation'];

/**
 * Звонок через подменный номер (ТЗ §10, П-14): заказчик до выезда звонит управляющему диспетчеру, после выезда — машинисту;
 * машинист и диспетчер звонят заказчику. Звонки записываются (В-27).
 */
@Injectable()
export class CallsService {
  constructor(
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
  ) {}

  async request(orderId: string, userId: string): Promise<{ virtualNumber: string; expiresAt: string; calleeRole: string }> {
    const p = await this.core.participant(orderId, userId);
    if (!p.customer && !p.operator && !p.staffRole) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    if (!CALLABLE.includes(p.order.status)) throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Звонок по этому заказу сейчас недоступен', HttpStatus.CONFLICT);

    let calleeId: string | null;
    let calleeRole: string;
    if (p.customer) {
      const shifts = await this.core.shifts(orderId);
      const active = shifts.find((s) => ['en_route', 'arrived', 'in_progress'].includes(s.status) && s.operator_user_id);
      if (active) {
        calleeId = active.operator_user_id;
        calleeRole = 'operator';
      } else {
        calleeId = await this.managingUser(p.order.managing_member_id, p.order.partner_org_id);
        calleeRole = 'dispatcher';
      }
    } else {
      calleeId = p.order.customer_id;
      calleeRole = 'customer';
    }
    if (!calleeId) throw new AppException(ERROR_CODES.CONFLICT, 'Некому позвонить по этому заказу', HttpStatus.CONFLICT);
    const phones = await this.core.db.execute<{ id: string; phone: string }>(sql`SELECT id, phone FROM users WHERE id IN (${userId}, ${calleeId})`);
    const callerPhone = phones.rows.find((r) => r.id === userId)?.phone as string;
    const calleePhone = phones.rows.find((r) => r.id === calleeId)?.phone as string;
    const ttlMin = await this.settings.get('call_number_ttl_min');
    const allocated = await this.telephony.allocate({ callerPhone, calleePhone, ttlSec: ttlMin * 60, record: true });
    const expiresAt = new Date(Date.now() + ttlMin * 60_000);
    await this.core.db.execute(sql`
      INSERT INTO call_sessions (order_id, caller_user_id, callee_user_id, provider, virtual_number, provider_session_id, expires_at)
      VALUES (${orderId}, ${userId}, ${calleeId}, ${this.telephony.name}, ${allocated.virtualNumber}, ${allocated.sessionId}, ${expiresAt.toISOString()})`);
    // Реальный номер собеседника не возвращается.
    return { virtualNumber: allocated.virtualNumber, expiresAt: expiresAt.toISOString(), calleeRole };
  }

  private async managingUser(memberId: string | null, orgId: string | null): Promise<string | null> {
    if (memberId) {
      const res = await this.core.db.execute<{ user_id: string }>(sql`SELECT user_id FROM organization_members WHERE id = ${memberId} AND status = 'active'`);
      if (res.rows[0]) return res.rows[0].user_id;
    }
    if (!orgId) return null;
    const owner = await this.core.db.execute<{ user_id: string }>(sql`SELECT user_id FROM organization_members WHERE org_id = ${orgId} AND role = 'owner'`);
    return owner.rows[0]?.user_id ?? null;
  }
}
