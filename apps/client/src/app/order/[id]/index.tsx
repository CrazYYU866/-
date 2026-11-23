import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Icon } from '@kovsh/mobile';
import { RouteScheme } from '@kovsh/mobile';
import { Button, Card, Choice, Divider, ErrorView, Field, Loading, Notice, Pill, Row, Section, T } from '@kovsh/mobile';
import { api, post } from '@kovsh/mobile';
import { dateShort, dateTime, hoursWord, rub, time } from '@kovsh/mobile';
import { CHAT_OPEN, SHIFT_UI, VISIBLE_UI, whatNow, type OrderView } from '../../../lib/orders';
import { useOrderRealtime } from '@kovsh/mobile';
import { radius, space, useTheme } from '@kovsh/mobile';

interface Tracking {
  mode: 'none' | 'base' | 'live' | 'on_site' | 'finished';
  site: { lat: number; lng: number };
  base?: { lat: number; lng: number; address: string; label: string };
  route?: { distanceKm?: number; durationMin?: number; provider: string };
  position?: { lat: number; lng: number; updatedAt: string } | null;
  stale?: boolean;
  etaMin?: number | null;
  remainingKm?: number | null;
  message?: string;
}
interface Extension { id: string; hours: number; amount_kopecks: string; status: string }
interface Rating { id: string; author_side: string; target_user_id: string; stars: number }
interface Payment { id: string; part: string; amountKopecks: number; status: string; confirmationUrl: string | null }

const TRACK = ['assigned', 'en_route', 'arrived', 'in_progress'];
const RATE = ['completed', 'awaiting_final_payment'];

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  useOrderRealtime(id);
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<OrderView>(`/client/orders/${id}`), refetchInterval: 20_000 });
  const o = q.data;
  const tracking = useQuery({
    queryKey: ['tracking', id], enabled: Boolean(o && TRACK.includes(o.status) && o.equipment), refetchInterval: 15_000,
    queryFn: () => api<Tracking>(`/client/orders/${id}/tracking`),
  });
  const exts = useQuery({ queryKey: ['order', id, 'ext'], enabled: Boolean(o && o.price.prepaid), queryFn: () => api<Extension[]>(`/client/orders/${id}/extensions`) });
  const ratings = useQuery({ queryKey: ['order', id, 'ratings'], enabled: Boolean(o && RATE.includes(o.status)), queryFn: () => api<Rating[]>(`/client/orders/${id}/ratings`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['order', id] }).then(() => qc.invalidateQueries({ queryKey: ['orders'] }));

  if (q.isLoading) return <Loading />;
  if (q.error || !o) return <View style={{ padding: space.lg }}><ErrorView error={q.error} onRetry={() => q.refetch()} /></View>;
  const ui = VISIBLE_UI[o.visibleStatus];
  const operators = [...new Map(o.shifts.filter((s) => s.operator).map((s) => [s.operator!.userId, s.operator!])).values()];
  const pendingExt = exts.data?.filter((e) => e.status === 'requested') ?? [];

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={st.body} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: `Заказ №${o.number}` }} />
      <View style={{ gap: space.sm }}>
        <Pill label={ui.label} tone={ui.tone} />
        <T v="h2">{o.category}</T>
        <T muted>{whatNow(o.status)}</T>
      </View>

      <Actions order={o} onDone={refresh} />

      {o.refundReview ? (
        <Notice tone={o.refundReview.status === 'in_review' ? 'warning' : 'info'}>
          {o.refundReview.status === 'in_review'
            ? `Вы оплатили ${rub(o.price.paidKopecks)}. Поддержка рассматривает отмену и решит, какую сумму вернуть. Мы сообщим о решении.`
            : o.refundReview.decision === 'full_retention'
              ? `Поддержка решила не возвращать оплату.${o.refundReview.reason ? ` Причина: ${o.refundReview.reason}.` : ''}`
              : `Поддержка одобрила возврат ${rub(o.refundReview.refundKopecks)}.${o.refundReview.reason ? ` Комментарий: ${o.refundReview.reason}.` : ''} Деньги вернутся тем же способом, которым вы платили.`}
        </Notice>
      ) : null}

      {pendingExt.map((e) => <ExtensionCard key={e.id} orderId={o.id} ext={e} onDone={refresh} />)}

      {tracking.data && tracking.data.mode !== 'none' && tracking.data.mode !== 'finished' ? <TrackingCard tr={tracking.data} /> : null}

      {o.partner ? (
        <Section title="Исполнитель">
          <Card>
            <T style={{ fontWeight: '600' }}>{o.partner.name}</T>
            {o.equipment ? (
              <T muted>{o.equipment.brand} {o.equipment.model}{o.equipment.year ? `, ${o.equipment.year} г.` : ''}{o.equipment.regNumber ? ` · ${o.equipment.regNumber}` : ''}</T>
            ) : null}
            {operators.map((op) => (
              <View key={op.userId} style={st.operator}>
                <View style={[st.avatar, { backgroundColor: t.accentSoft }]}><T style={{ fontWeight: '700' }}>{(op.fullName ?? 'М')[0]}</T></View>
                <View style={{ flex: 1 }}>
                  <T style={{ fontWeight: '600' }}>{op.fullName ?? 'Машинист'}</T>
                  <T v="small" muted>{op.rating ? `★ ${op.rating.toFixed(1)}` : 'Пока без оценок'}</T>
                </View>
              </View>
            ))}
            {CHAT_OPEN.includes(o.status) ? <Contact orderId={o.id} hasOperator={operators.length > 0} /> : null}
          </Card>
        </Section>
      ) : null}

      <Section title="Где и когда">
        <Card>
          <T style={{ fontWeight: '600' }}>{o.site.address}</T>
          {o.site.comment ? <T v="small" muted>{o.site.comment}</T> : null}
          <Divider />
          {o.shifts.map((s) => (
            <View key={s.id} style={st.shift}>
              <View style={{ flex: 1 }}>
                <T>{dateShort(s.start)}, {time(s.start)}–{time(s.end)}</T>
                <T v="small" muted>{s.hours} {hoursWord(s.hours)}{s.operator?.fullName ? ` · ${s.operator.fullName}` : ''}</T>
              </View>
              {s.status !== 'pending' ? <Pill label={SHIFT_UI[s.status] ?? s.status} tone={s.status === 'finished' ? 'success' : s.status === 'cancelled' ? 'neutral' : 'accent'} /> : null}
            </View>
          ))}
        </Card>
      </Section>

      <Section title="Стоимость">
        <Card>
          <Row label="Аренда" value={rub(o.price.rentKopecks)} />
          <Row label={`Доставка · ${o.price.deliveryKm} км`} value={rub(o.price.deliveryKopecks)} />
          {o.price.extraHours ? <Row label={`Доп. часы · ${o.price.extraHours}`} value={rub(o.price.extraKopecks)} /> : null}
          {o.price.discountKopecks ? <Row label="Скидка" value={`−${rub(o.price.discountKopecks)}`} /> : null}
          <Divider />
          <Row label="Итого" value={rub(o.price.payableKopecks)} strong />
          <Row label="Оплачено" value={rub(o.price.paidKopecks)} />
          {o.price.refundedKopecks ? <Row label="Возвращено" value={rub(o.price.refundedKopecks)} /> : null}
          <T v="small" muted>{o.price.payerKind === 'legal' ? 'Оплата от организации: 50% после принятия, 50% в течение 24 часов после завершения.' : 'Оплата частным лицом: 100% после принятия заказа.'}</T>
        </Card>
      </Section>

      {RATE.includes(o.status) && operators.length ? (
        <Section title="Оценка">
          {operators.map((op) => {
            const done = ratings.data?.find((r) => r.author_side === 'customer' && r.target_user_id === op.userId);
            return <RateCard key={op.userId} orderId={o.id} operator={op} done={done?.stars} onDone={() => ratings.refetch()} />;
          })}
        </Section>
      ) : null}

      <History order={o} />
      <CancelBlock order={o} onDone={refresh} />
    </ScrollView>
  );
}

/** Главное действие по заказу — одно, крупно. */
function Actions({ order: o, onDone }: { order: OrderView; onDone: () => void }) {
  const t = useTheme();
  const [disputeText, setDisputeText] = useState<string | null>(null);
  const pay = useMutation({
    mutationFn: () => post<Payment>(`/client/orders/${o.id}/payments`),
    onSuccess: async (p) => {
      if (!p.confirmationUrl) return;
      if (Platform.OS === 'web') globalThis.open?.(p.confirmationUrl, '_blank');
      else await WebBrowser.openBrowserAsync(p.confirmationUrl);
      onDone();
    },
  });
  const invoice = useMutation({ mutationFn: (part: 'first' | 'final') => post(`/client/orders/${o.id}/invoices`, { part }) });
  const complete = useMutation({ mutationFn: () => post(`/client/orders/${o.id}/confirm-completion`), onSuccess: onDone });
  const dispute = useMutation({ mutationFn: () => post(`/client/orders/${o.id}/dispute`, { reason: disputeText }), onSuccess: () => { setDisputeText(null); onDone(); } });
  const err = (pay.error ?? complete.error ?? dispute.error ?? invoice.error) as Error | null;

  let body: ReactNode = null;
  if (o.status === 'awaiting_customer_confirmation') body = <ConfirmAgentOrder order={o} onDone={onDone} />;
  const extraDue = o.price.payerKind === 'individual' && o.price.prepaid && o.price.remainingKopecks > 0 && !['completed', 'cancelled', 'refund_pending', 'disputed'].includes(o.status);
  if (o.status === 'awaiting_prepayment' || o.status === 'awaiting_final_payment' || extraDue) {
    const amount = o.status === 'awaiting_prepayment' ? o.price.firstPaymentKopecks : o.price.remainingKopecks;
    const part = o.status === 'awaiting_prepayment' ? 'first' : 'final';
    body = (
      <>
        <Button title={`Оплатить ${rub(amount)}`} loading={pay.isPending} onPress={() => pay.mutate()} />
        {o.price.payerKind === 'legal' && !extraDue ? (
          <Button kind="secondary" title={invoice.isSuccess ? 'Счёт выставлен' : 'Получить счёт для оплаты'} disabled={invoice.isSuccess} loading={invoice.isPending} onPress={() => invoice.mutate(part)} />
        ) : null}
        {o.status === 'awaiting_prepayment' ? <T v="small" muted>Если не оплатить вовремя, заказ отменится автоматически.</T> : null}
        {o.status === 'awaiting_final_payment' ? <T v="small" muted>Оплатите в течение 24 часов после завершения — иначе образуется задолженность и новые заказы будут недоступны.</T> : null}
      </>
    );
  }
  if (o.status === 'awaiting_completion_confirmation') {
    body = disputeText === null ? (
      <>
        <Button title="Подтвердить завершение" loading={complete.isPending} onPress={() => complete.mutate()} />
        <Button kind="secondary" title="Есть проблема" onPress={() => setDisputeText('')} />
      </>
    ) : (
      <>
        <Field label="Что не так?" value={disputeText} onChangeText={setDisputeText} multiline placeholder="Опишите проблему — поддержка разберётся" />
        <Button kind="danger" title="Отправить в поддержку" disabled={disputeText.trim().length < 3} loading={dispute.isPending} onPress={() => dispute.mutate()} />
        <Button kind="ghost" title="Назад" onPress={() => setDisputeText(null)} />
      </>
    );
  }
  if (!body) return null;
  return (
    <View style={[st.actions, { backgroundColor: t.surface, borderColor: t.accent }]}>
      {body}
      {err ? <Notice tone="danger">{err.message}</Notice> : null}
    </View>
  );
}

function ConfirmAgentOrder({ order: o, onDone }: { order: OrderView; onDone: () => void }) {
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api<{ id: string; name: string; inn: string }[]>('/client/organizations') });
  const [payer, setPayer] = useState('individual');
  const confirm = useMutation({
    mutationFn: () => post(`/client/orders/${o.id}/confirm`, { payer: payer === 'individual' ? { kind: 'individual' } : { kind: 'legal', legalProfileId: payer } }),
    onSuccess: onDone,
  });
  return (
    <>
      <T style={{ fontWeight: '600' }}>Итого {rub(o.price.payableKopecks)} · кто платит?</T>
      <Choice value={payer} onChange={setPayer} options={[
        { value: 'individual', label: 'Я — частное лицо', hint: '100% после принятия заказа' },
        ...(orgs.data ?? []).map((g) => ({ value: g.id, label: g.name, hint: `ИНН ${g.inn} · 50/50` })),
      ]} />
      <Button title="Подтвердить заявку" loading={confirm.isPending} onPress={() => confirm.mutate()} />
      {confirm.error ? <Notice tone="danger">{(confirm.error as Error).message}</Notice> : null}
    </>
  );
}

function ExtensionCard({ orderId, ext, onDone }: { orderId: string; ext: Extension; onDone: () => void }) {
  const decide = useMutation({ mutationFn: (ok: boolean) => post(`/client/orders/${orderId}/extensions/${ext.id}/${ok ? 'approve' : 'reject'}`), onSuccess: onDone });
  return (
    <Card accent>
      <T v="h3">Продлить работу на {ext.hours} {hoursWord(ext.hours)}?</T>
      <T muted>Машинист просит дополнительное время. Стоимость: {rub(Number(ext.amount_kopecks))}. Работает тот же машинист на той же технике.</T>
      <Button title="Продлить" loading={decide.isPending && decide.variables} onPress={() => decide.mutate(true)} />
      <Button kind="secondary" title="Не нужно" loading={decide.isPending && !decide.variables} onPress={() => decide.mutate(false)} />
      {decide.error ? <Notice tone="danger">{(decide.error as Error).message}</Notice> : null}
    </Card>
  );
}

function TrackingCard({ tr }: { tr: Tracking }) {
  const from = tr.mode === 'live' ? tr.position : tr.mode === 'base' ? tr.base : null;
  let title = '';
  let sub = '';
  if (tr.mode === 'base') { title = 'Техника на стоянке'; sub = `${tr.base?.label}. До объекта ~${tr.route?.distanceKm} км, ~${tr.route?.durationMin} мин в пути.`; }
  if (tr.mode === 'live') {
    title = tr.etaMin ? `Будет через ~${tr.etaMin} мин` : 'Машинист в пути';
    sub = !tr.position ? 'Ожидаем координаты машиниста' : tr.stale ? `Нет связи с техникой. Последнее обновление: ${dateTime(tr.position.updatedAt)}. Время прибытия не рассчитываем.` : `Осталось ~${tr.remainingKm} км · обновлено в ${time(tr.position.updatedAt)}`;
  }
  if (tr.mode === 'on_site') { title = 'Техника на объекте'; sub = 'После прибытия перемещения не показываются.'; }
  return (
    <Section title="Где техника">
      <Card>
        <T style={{ fontWeight: '600' }}>{title}</T>
        {sub ? <T v="small" muted>{sub}</T> : null}
        {tr.mode !== 'on_site' ? <RouteScheme site={tr.site} from={from} fromLabel={tr.mode === 'base' ? 'Стоянка' : 'Машинист'} stale={tr.stale} /> : null}
        {tr.route?.provider === 'dev' ? <T v="small" muted>Тестовый расчёт пути (по прямой × 1,3). Карта и пробки — с ключом Яндекса.</T> : null}
      </Card>
    </Section>
  );
}

function Contact({ orderId, hasOperator }: { orderId: string; hasOperator: boolean }) {
  const t = useTheme();
  const call = useMutation({
    mutationFn: () => post<{ virtualNumber: string; expiresAt: string }>(`/client/orders/${orderId}/call`),
    onSuccess: (r) => Linking.openURL(`tel:${r.virtualNumber}`).catch(() => undefined),
  });
  return (
    <View style={{ gap: space.sm, marginTop: space.sm }}>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}><Button kind="secondary" title="Написать" icon={<Icon name="chat" color={t.text} size={18} />} onPress={() => router.push({ pathname: '/order/[id]/chat', params: { id: orderId } })} /></View>
        <View style={{ flex: 1 }}><Button kind="secondary" title="Позвонить" disabled={!hasOperator} icon={<Icon name="phone" color={t.text} size={18} />} loading={call.isPending} onPress={() => call.mutate()} /></View>
      </View>
      {call.data ? <T v="small" muted>Номер для звонка: {call.data.virtualNumber} (действует до {time(call.data.expiresAt)}). Ваш номер машинисту не показывается.</T> : null}
      {call.error ? <Notice tone="danger">{(call.error as Error).message}</Notice> : null}
    </View>
  );
}

function RateCard({ orderId, operator, done, onDone }: { orderId: string; operator: { userId: string; fullName: string | null }; done?: number; onDone: () => void }) {
  const t = useTheme();
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const rate = useMutation({ mutationFn: () => post(`/client/orders/${orderId}/ratings`, { stars, text: text.trim() || undefined, targetUserId: operator.userId }), onSuccess: onDone });
  const shown = done ?? stars;
  return (
    <Card>
      <T style={{ fontWeight: '600' }}>{operator.fullName ?? 'Машинист'}</T>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} disabled={done !== undefined} onPress={() => setStars(n)} accessibilityRole="button" accessibilityLabel={`${n} из 5`} hitSlop={6}>
            <Icon name="star" size={34} color={n <= shown ? t.accent : t.border} fill={n <= shown ? t.accent : 'none'} />
          </Pressable>
        ))}
      </View>
      {done !== undefined ? <T v="small" muted>Спасибо за оценку!</T> : stars ? (
        <>
          <Field value={text} onChangeText={setText} placeholder="Комментарий (необязательно)" multiline />
          <Button title="Отправить оценку" loading={rate.isPending} onPress={() => rate.mutate()} />
          {rate.error ? <Notice tone="danger">{(rate.error as Error).message}</Notice> : null}
        </>
      ) : null}
    </Card>
  );
}

const ACTOR: Record<string, string> = { customer: 'вы', partner: 'исполнитель', operator: 'машинист', system: 'сервис', admin: 'поддержка' };
const STEP: Record<string, string> = {
  searching: 'Заказ создан, идёт поиск', accepted: 'Исполнитель принял заказ', awaiting_prepayment: 'Ожидается оплата',
  awaiting_assignment: 'Оплата получена', assigned: 'Назначен машинист', en_route: 'Машинист выехал', arrived: 'Машинист прибыл',
  in_progress: 'Работа началась', awaiting_completion_confirmation: 'Машинист завершил работу', completed: 'Заказ завершён',
  awaiting_final_payment: 'Ожидается оплата второй части', cancelled: 'Заказ отменён', cancelled_unpaid: 'Отменён: нет оплаты',
  refund_pending: 'Отмена: решение по возврату', disputed: 'Открыт спор', search_failed: 'Исполнитель не найден',
  awaiting_customer_confirmation: 'Заявка от диспетчера',
};

function History({ order: o }: { order: OrderView }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const items = o.history.filter((h) => STEP[h.status] && h.status !== h.from);
  if (!items.length) return null;
  const shown = open ? items : items.slice(-3);
  return (
    <Section title="История" right={items.length > 3 ? <Button kind="ghost" small title={open ? 'Свернуть' : 'Все'} onPress={() => setOpen(!open)} /> : undefined}>
      <Card>
        {shown.map((h, i) => (
          <View key={i} style={st.hist}>
            <View style={[st.dot, { backgroundColor: i === shown.length - 1 ? t.accent : t.border }]} />
            <View style={{ flex: 1 }}>
              <T>{STEP[h.status]}</T>
              <T v="small" muted>{dateTime(h.at)} · {ACTOR[h.actor] ?? h.actor}{h.reason ? ` · ${h.reason}` : ''}</T>
            </View>
          </View>
        ))}
      </Card>
    </Section>
  );
}

function CancelBlock({ order: o, onDone }: { order: OrderView; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const preview = useQuery({
    queryKey: ['order', o.id, 'cancel-preview', o.status], enabled: !['completed', 'cancelled', 'cancelled_unpaid', 'refund_pending', 'search_failed', 'awaiting_final_payment', 'disputed'].includes(o.status),
    queryFn: () => post<{ allowed: boolean; paidKopecks: number; policy: 'free' | 'support_review' | 'not_allowed' }>(`/client/orders/${o.id}/cancel/preview`),
  });
  const cancel = useMutation({ mutationFn: () => post(`/client/orders/${o.id}/cancel`, { reason: reason.trim() || undefined }), onSuccess: () => { setAsking(false); onDone(); } });
  if (!preview.data?.allowed) return null;
  if (!asking) return <Button kind="ghost" title="Отменить заказ" onPress={() => setAsking(true)} />;
  return (
    <Card>
      <T v="h3">Отменить заказ?</T>
      <T muted>
        {preview.data.policy === 'free'
          ? 'Заказ ещё не оплачен — отмена бесплатная.'
          : `Вы оплатили ${rub(preview.data.paidKopecks)}. Поддержка рассмотрит отмену и решит, какую сумму вернуть. Мы сообщим о решении.`}
      </T>
      <Field value={reason} onChangeText={setReason} placeholder="Причина (необязательно)" />
      <Button kind="danger" title="Да, отменить" loading={cancel.isPending} onPress={() => cancel.mutate()} />
      <Button kind="ghost" title="Не отменять" onPress={() => setAsking(false)} />
      {cancel.error ? <Notice tone="danger">{(cancel.error as Error).message}</Notice> : null}
    </Card>
  );
}

const st = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2, width: '100%', maxWidth: 640, alignSelf: 'center' },
  actions: { gap: space.sm, borderWidth: 1.5, borderRadius: radius.lg, padding: space.lg },
  operator: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xs },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  shift: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 4 },
  hist: { flexDirection: 'row', gap: space.md, paddingVertical: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
});
