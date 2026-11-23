import { api, Button, Card, Choice, dateShort, dateTime, Divider, ErrorView, Field, hoursWord, Loading, Notice, Pill, post, RouteScheme, Row, rub, Section, space, T, time, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, RefreshControl, ScrollView, View } from 'react-native';
import { SHIFT_UI, VISIBLE_UI, whatNow, type OrderView } from '../../lib/orders';

interface PublicView { order: OrderView; payerOptions: ({ kind: 'individual' } | { kind: 'legal'; legalProfileId: string; name: string; inn: string })[] }
interface Extension { id: string; hours: number; amount_kopecks: string; status: string }

/**
 * Заявка независимого диспетчера по SMS-ссылке (Н-27, Н-30): заказчик без регистрации видит заказ, выбирает
 * плательщика, подтверждает, платит, отвечает на продления, подтверждает завершение или открывает спор.
 * Тот же экран открывается в приложении по ссылке (kovsh://o/<токен>).
 */
export default function PublicOrder() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  const base = `/public/orders/${token}`;
  const q = useQuery({ queryKey: ['public', token], queryFn: () => api<PublicView>(base), refetchInterval: 20_000 });
  const o = q.data?.order;
  const exts = useQuery({ queryKey: ['public', token, 'ext'], enabled: Boolean(o?.price.prepaid), queryFn: () => api<Extension[]>(`${base}/extensions`) });
  const tracking = useQuery({
    queryKey: ['public', token, 'tracking'], enabled: Boolean(o && ['assigned', 'en_route', 'arrived', 'in_progress'].includes(o.status)), refetchInterval: 15_000,
    queryFn: () => api<{ mode: string; site: { lat: number; lng: number }; position?: { lat: number; lng: number; updatedAt: string } | null; base?: { lat: number; lng: number }; stale?: boolean; etaMin?: number | null }>(`${base}/tracking`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['public', token] });
  const [payer, setPayer] = useState('individual');
  const [dispute, setDispute] = useState<string | null>(null);
  const [cancelAsk, setCancelAsk] = useState(false);
  const confirm = useMutation({ mutationFn: () => post(`${base}/confirm`, { payer: payer === 'individual' ? { kind: 'individual' } : { kind: 'legal', legalProfileId: payer } }), onSuccess: refresh });
  const pay = useMutation({
    mutationFn: () => post<{ confirmationUrl: string | null }>(`${base}/payments`),
    onSuccess: async (p) => {
      if (!p.confirmationUrl) return;
      if (Platform.OS === 'web') globalThis.location?.assign(p.confirmationUrl);
      else await WebBrowser.openBrowserAsync(p.confirmationUrl);
      refresh();
    },
  });
  const invoice = useMutation({ mutationFn: (part: 'first' | 'final') => post(`${base}/invoices`, { part }) });
  const complete = useMutation({ mutationFn: () => post(`${base}/confirm-completion`), onSuccess: refresh });
  const openDispute = useMutation({ mutationFn: () => post(`${base}/dispute`, { reason: dispute }), onSuccess: () => { setDispute(null); refresh(); } });
  const cancel = useMutation({ mutationFn: () => post(`${base}/cancel`, {}), onSuccess: () => { setCancelAsk(false); refresh(); } });
  const decide = useMutation({ mutationFn: (a: { id: string; ok: boolean }) => post(`${base}/extensions/${a.id}/${a.ok ? 'approve' : 'reject'}`), onSuccess: refresh });
  const err = (confirm.error ?? pay.error ?? invoice.error ?? complete.error ?? openDispute.error ?? cancel.error ?? decide.error) as Error | null;

  if (q.isLoading) return <Loading />;
  if (!o) return <View style={{ padding: space.lg }}><ErrorView error={q.error ?? new Error('Ссылка недействительна или устарела')} /></View>;
  const ui = VISIBLE_UI[o.visibleStatus];
  const legal = o.price.payerKind === 'legal';
  const due = o.status === 'awaiting_prepayment' ? o.price.firstPaymentKopecks : o.price.remainingKopecks;
  const canPay = o.status === 'awaiting_prepayment' || o.status === 'awaiting_final_payment' || (o.price.prepaid && o.price.payerKind === 'individual' && o.price.remainingKopecks > 0 && !['completed', 'cancelled', 'refund_pending', 'disputed'].includes(o.status));
  const tr = tracking.data;

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 64, width: '100%', maxWidth: 640, alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: `Заявка №${o.number}` }} />
      <View style={{ gap: space.sm }}>
        <Pill label={ui.label} tone={ui.tone} />
        <T v="h2">{o.category}</T>
        <T muted>{whatNow(o.status)}</T>
      </View>

      {o.status === 'awaiting_customer_confirmation' ? (
        <Card accent>
          <T style={{ fontWeight: '600' }}>Итого {rub(o.price.payableKopecks)} · кто платит?</T>
          <Choice value={payer} onChange={setPayer} options={q.data!.payerOptions.map((p) => p.kind === 'individual'
            ? { value: 'individual', label: 'Я — частное лицо', hint: '100% после того, как исполнитель примет заказ' }
            : { value: p.legalProfileId, label: p.name, hint: `ИНН ${p.inn} · 50% после принятия, 50% после завершения` })} />
          <Button title="Подтвердить заявку" loading={confirm.isPending} onPress={() => confirm.mutate()} />
          <T v="small" muted>Чтобы платить от организации, добавьте её в приложении «Ковш на Час» под этим номером телефона.</T>
        </Card>
      ) : null}

      {canPay ? (
        <Card accent>
          <Button title={`Оплатить ${rub(due)}`} loading={pay.isPending} onPress={() => pay.mutate()} />
          {legal ? <Button kind="secondary" title={invoice.isSuccess ? 'Счёт отправлен на email организации' : 'Получить счёт'} disabled={invoice.isSuccess} loading={invoice.isPending} onPress={() => invoice.mutate(o.status === 'awaiting_prepayment' ? 'first' : 'final')} /> : null}
        </Card>
      ) : null}

      {exts.data?.filter((e) => e.status === 'requested').map((e) => (
        <Card key={e.id} accent>
          <T v="h3">Продлить на {e.hours} {hoursWord(e.hours)} за {rub(Number(e.amount_kopecks))}?</T>
          <Button title="Продлить" onPress={() => decide.mutate({ id: e.id, ok: true })} />
          <Button kind="secondary" title="Не нужно" onPress={() => decide.mutate({ id: e.id, ok: false })} />
        </Card>
      ))}

      {o.status === 'awaiting_completion_confirmation' ? (
        <Card accent>
          {dispute === null ? (
            <>
              <Button title="Подтвердить завершение" loading={complete.isPending} onPress={() => complete.mutate()} />
              <Button kind="secondary" title="Есть проблема" onPress={() => setDispute('')} />
            </>
          ) : (
            <>
              <Field label="Что не так?" value={dispute} onChangeText={setDispute} multiline />
              <Button kind="danger" title="Отправить в поддержку" disabled={dispute.trim().length < 3} loading={openDispute.isPending} onPress={() => openDispute.mutate()} />
            </>
          )}
        </Card>
      ) : null}

      {err ? <Notice tone="danger">{err.message}</Notice> : null}

      {tr && (tr.mode === 'live' || tr.mode === 'base') ? (
        <Section title="Где техника">
          <Card>
            <T style={{ fontWeight: '600' }}>{tr.mode === 'live' ? (tr.stale ? 'Нет связи с машинистом' : tr.etaMin ? `Будет через ~${tr.etaMin} мин` : 'Машинист в пути') : 'Техника на стоянке'}</T>
            {tr.position ? <T v="small" muted>Обновлено {dateTime(tr.position.updatedAt)}</T> : null}
            <RouteScheme site={tr.site} from={tr.mode === 'live' ? tr.position : tr.base} fromLabel={tr.mode === 'live' ? 'Машинист' : 'Стоянка'} stale={tr.stale} />
          </Card>
        </Section>
      ) : null}

      <Section title="Где и когда">
        <Card>
          <T style={{ fontWeight: '600' }}>{o.site.address}</T>
          {o.site.comment ? <T v="small" muted>{o.site.comment}</T> : null}
          <Divider />
          {o.shifts.map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <T>{dateShort(s.start)}, {time(s.start)}–{time(s.end)}</T>
              {s.status !== 'pending' ? <T v="small" muted>{SHIFT_UI[s.status] ?? s.status}</T> : null}
            </View>
          ))}
          {o.partner ? <T v="small" muted>Исполнитель: {o.partner.name}{o.shifts[0]?.operator?.fullName ? ` · машинист ${o.shifts[0].operator.fullName}` : ''}</T> : null}
        </Card>
      </Section>

      <Section title="Стоимость">
        <Card>
          <Row label="Аренда" value={rub(o.price.rentKopecks)} />
          <Row label={`Доставка · ${o.price.deliveryKm} км`} value={rub(o.price.deliveryKopecks)} />
          <Divider />
          <Row label="Итого" value={rub(o.price.payableKopecks)} strong />
          <Row label="Оплачено" value={rub(o.price.paidKopecks)} />
        </Card>
      </Section>

      {['awaiting_customer_confirmation', 'searching', 'offered', 'accepted', 'awaiting_prepayment', 'awaiting_assignment', 'assigned'].includes(o.status) ? (
        cancelAsk ? (
          <Card>
            <T v="h3">Отменить заявку?</T>
            <T muted>{o.price.paidKopecks > 0 ? 'Вы уже оплатили — сумму возврата решит поддержка.' : 'Заказ ещё не оплачен — отмена бесплатная.'}</T>
            <Button kind="danger" title="Да, отменить" loading={cancel.isPending} onPress={() => cancel.mutate()} />
            <Button kind="ghost" title="Не отменять" onPress={() => setCancelAsk(false)} />
          </Card>
        ) : <Button kind="ghost" title="Отменить заявку" onPress={() => setCancelAsk(true)} />
      ) : null}
    </ScrollView>
  );
}
