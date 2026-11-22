import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type SettingKey } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import type { AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/app-exception';
import { OrderCore } from '../orders/order-core';
import { payableOf } from '../orders/orders.service';
import { SettingsService } from '../settings/settings.service';
import { addBusinessDays, type CalendarExceptions } from './business-days';
import { PaymentsService } from './payments.service';

const TZ = 'Europe/Moscow';
const notAllowed = (m: string) => new AppException(ERROR_CODES.INVOICE_NOT_ALLOWED, m, HttpStatus.CONFLICT);
const SELLER_KEYS: SettingKey[] = ['platform_legal_name', 'platform_inn', 'platform_kpp', 'platform_legal_address', 'platform_bank_name', 'platform_bik', 'platform_account', 'platform_corr_account'];

/**
 * Оплата юрлиц по счёту (К-1, Л-5). Первая часть — только для предварительных заказов с началом не раньше чем через 3 рабочих дня;
 * срок — до конца следующего рабочего дня, но не позже чем за 24 часа до начала; техника на это время забронирована.
 * Вторая часть — 24 часа после завершения (Л-5). Поступление денег отмечает финансист.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  async issue(customerId: string, orderId: string, part: 'first' | 'final') {
    const seller = await this.seller();
    return this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      if (order.payer_kind !== 'legal' || !order.payer_legal_profile_id) throw notAllowed('Оплата по счёту доступна только юрлицам');
      let amount: number;
      let due: Date;
      if (part === 'first') {
        if (order.status !== 'awaiting_prepayment' || order.prepaid_at) throw notAllowed('Сейчас нет первой части к оплате');
        const ex = await this.calendar(tx);
        const today = await this.mskToday(tx);
        const startDate = await this.mskDate(tx, new Date(order.first_start_at));
        if (order.urgency !== 'scheduled' || startDate < addBusinessDays(today, await this.settings.get('invoice_min_lead_business_days'), ex)) {
          throw notAllowed('Оплата по счёту — для заказов с началом не раньше чем через 3 рабочих дня; оплатите онлайн');
        }
        const nextBusiness = addBusinessDays(today, 1, ex);
        const endOfNextBusiness = await this.mskDayStart(tx, addDays(nextBusiness, 1));
        const beforeStartHours = await this.settings.get('invoice_funds_deadline_before_start_hours');
        due = new Date(Math.min(endOfNextBusiness.getTime(), new Date(order.first_start_at).getTime() - beforeStartHours * 3_600_000));
        amount = Number(order.prepayment_kopecks);
        // Бронь техники держится до срока оплаты; не оплачено — заказ отменяется (К-1).
        await tx.execute(sql`UPDATE orders SET prepayment_deadline_at = ${due.toISOString()} WHERE id = ${orderId}`);
        await this.core.jobs.schedule('prepayment_timeout', { orderId }, due, { dedupeKey: `order:${orderId}:prepay`, tx });
      } else {
        if (order.status !== 'awaiting_final_payment') throw notAllowed('Сейчас нет второй части к оплате');
        amount = payableOf(order) - Number(order.paid_kopecks);
        const res = await tx.execute<{ due: Date }>(sql`SELECT final_payment_due_at AS due FROM orders WHERE id = ${orderId}`);
        due = new Date(res.rows[0]?.due ?? Date.now() + 86_400_000);
      }
      const buyer = await tx.execute(sql`SELECT inn, kpp, name, legal_address, email FROM customer_legal_profiles WHERE id = ${order.payer_legal_profile_id}`);
      const ins = await tx.execute<{ id: string; number: string }>(sql`
        INSERT INTO invoices (order_id, part, amount_kopecks, legal_profile_id, seller, buyer, due_at)
        VALUES (${orderId}, ${part}, ${amount}, ${order.payer_legal_profile_id}, ${JSON.stringify(seller)}::jsonb, ${JSON.stringify(buyer.rows[0])}::jsonb, ${due.toISOString()})
        ON CONFLICT DO NOTHING RETURNING id, number`);
      if (!ins.rows[0]) throw new AppException(ERROR_CODES.CONFLICT, 'Счёт на эту часть уже выставлен', HttpStatus.CONFLICT);
      await tx.execute(sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason)
        VALUES (${orderId}, ${order.status}, ${order.status}, 'customer', ${customerId}, ${`Выставлен счёт №${ins.rows[0].number}`})`);
      return { id: ins.rows[0].id, number: Number(ins.rows[0].number), part, amountKopecks: amount, dueAt: due.toISOString(), seller, buyer: buyer.rows[0] };
    });
  }

  async list(orderId: string) {
    const res = await this.core.db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId} ORDER BY issued_at`);
    return res.rows;
  }

  /** Деньги поступили на счёт платформы — отмечает финансист; дальше — как обычная оплата. */
  async markPaid(invoiceId: string, admin: AuthAdmin) {
    const res = await this.core.db.execute<{ id: string; order_id: string; part: 'first' | 'final'; amount_kopecks: string; number: string; status: string }>(sql`
      SELECT id, order_id, part, amount_kopecks, number, status FROM invoices WHERE id = ${invoiceId}`);
    const inv = res.rows[0];
    if (!inv) throw new AppException(ERROR_CODES.NOT_FOUND, 'Счёт не найден', HttpStatus.NOT_FOUND);
    if (inv.status !== 'issued') throw new AppException(ERROR_CODES.CONFLICT, 'Счёт уже оплачен или закрыт', HttpStatus.CONFLICT);
    const paymentId = await this.payments.recordExternalPayment(inv.order_id, inv.part, Number(inv.amount_kopecks), 'bank_transfer', `invoice:${inv.number}`);
    await this.core.db.execute(sql`UPDATE invoices SET status = 'paid', paid_at = now(), marked_paid_by = ${admin.adminId}, payment_id = ${paymentId} WHERE id = ${invoiceId}`);
    await this.audit.log({ adminId: admin.adminId, action: 'invoice.mark_paid', entity: 'invoice', entityId: invoiceId, after: { orderId: inv.order_id, amount: Number(inv.amount_kopecks) }, ip: admin.ip });
    return { id: invoiceId, status: 'paid' };
  }

  private async seller(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      for (const k of SELLER_KEYS) out[k.replace('platform_', '')] = String(await this.settings.get(k));
    } catch {
      throw notAllowed('Оплата по счёту пока недоступна: не заданы реквизиты платформы');
    }
    return out;
  }

  private async calendar(tx: Pick<OrderCore['db'], 'execute'>): Promise<CalendarExceptions> {
    const res = await tx.execute<{ day: string; is_working: boolean }>(sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, is_working FROM business_calendar WHERE day >= current_date - 7 AND day <= current_date + 120`);
    return new Map(res.rows.map((r) => [r.day, r.is_working]));
  }

  private async mskToday(tx: Pick<OrderCore['db'], 'execute'>): Promise<string> {
    return (await tx.execute<{ d: string }>(sql`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`)).rows[0]?.d as string;
  }

  private async mskDate(tx: Pick<OrderCore['db'], 'execute'>, at: Date): Promise<string> {
    return (await tx.execute<{ d: string }>(sql`SELECT to_char(${at.toISOString()}::timestamptz AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`)).rows[0]?.d as string;
  }

  private async mskDayStart(tx: Pick<OrderCore['db'], 'execute'>, date: string): Promise<Date> {
    return new Date((await tx.execute<{ t: Date }>(sql`SELECT (${date}::date::timestamp AT TIME ZONE ${TZ}) AS t`)).rows[0]?.t as Date);
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
