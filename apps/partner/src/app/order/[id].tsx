import { api, Button, Card, Choice, dateShort, dateTime, Divider, ErrorView, Field, hoursWord, Icon, Loading, Notice, Pill, post, rub, Row, RouteScheme, Section, space, T, time, useOrderRealtime, useTheme } from '@kovsh/mobile';
import { ORDER_STATUS_UI } from '@kovsh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { can, useOrg } from '../../lib/org';
import { PAYMENT_LABEL, SHIFT_LABEL, type PartnerOrder } from '../../lib/types';

const RELEASABLE = ['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived'];
const CHAT = ['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress', 'awaiting_completion_confirmation', 'awaiting_final_payment', 'disputed'];
const TRACK = ['assigned', 'en_route', 'arrived', 'in_progress'];

export default function PartnerOrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  const { current } = useOrg();
  useOrderRealtime(id);
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<PartnerOrder>(`/partner/orders/${id}`), refetchInterval: 20_000 });
  const o = q.data;
  const tracking = useQuery({
    queryKey: ['tracking', id], enabled: Boolean(o && TRACK.includes(o.status)), refetchInterval: 15_000,
    queryFn: () => api<{ mode: string; site: { lat: number; lng: number }; position?: { lat: number; lng: number; updatedAt: string } | null; base?: { lat: number; lng: number }; stale?: boolean; etaMin?: number | null }>(`/partner/orders/${id}/tracking`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['order', id] }).then(() => qc.invalidateQueries({ queryKey: ['orders'] }));
  if (q.isLoading) return <Loading />;
  if (!o) return <View style={{ padding: space.lg }}><ErrorView error={q.error} onRetry={() => q.refetch()} /></View>;
  const ui = ORDER_STATUS_UI[o.status] ?? { label: o.status, tone: 'neutral' as const };
  const tr = tracking.data;

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 64, width: '100%', maxWidth: 640, alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: `Заказ №${o.number}` }} />
      <View style={{ gap: space.sm }}>
        <Pill label={ui.label} tone={ui.tone} />
        <T v="h2">{o.category}</T>
        {o.equipment ? <T muted>{o.equipment.brand} {o.equipment.model}{o.equipment.regNumber ? ` · ${o.equipment.regNumber}` : ''}</T> : null}
      </View>

      {o.partnerPrice?.amountKopecks != null ? (
        <Card>
          <Row label={o.partnerPrice.final ? 'Начислено компании' : 'Компания получит'} value={rub(o.partnerPrice.amountKopecks)} strong />
          {o.partnerPrice.deliveryKm != null ? <Row label="Доставка от стоянки" value={`${o.partnerPrice.deliveryKm} км`} /> : null}
          {o.customerPaymentStatus ? <T v="small" muted>{PAYMENT_LABEL[o.customerPaymentStatus]}. Выплата — на следующий день после завершения заказа.</T> : null}
        </Card>
      ) : null}

      {o.status === 'awaiting_prepayment' ? <Notice tone="info">Ждём оплату заказчика. После оплаты назначьте машиниста.</Notice> : null}

      <Section title="Смены и машинисты">
        {o.shifts.map((s) => <ShiftCard key={s.id} order={o} shift={s} onDone={refresh} />)}
      </Section>

      <Section title="Объект">
        <Card>
          <T style={{ fontWeight: '600' }}>{o.site.address}</T>
          {o.site.comment ? <T v="small" muted>{o.site.comment}</T> : null}
          <Button kind="secondary" small title="Открыть в Яндекс Картах" icon={<Icon name="nav" color={t.text} size={18} />}
            onPress={() => Linking.openURL(`https://yandex.ru/maps/?pt=${o.site.lng},${o.site.lat}&z=16&l=map`)} />
        </Card>
        {tr && (tr.mode === 'live' || tr.mode === 'base') ? (
          <Card>
            <T style={{ fontWeight: '600' }}>{tr.mode === 'live' ? (tr.stale ? 'Нет связи с машинистом' : tr.etaMin ? `Машинист будет через ~${tr.etaMin} мин` : 'Машинист в пути') : 'Техника на стоянке'}</T>
            {tr.position ? <T v="small" muted>Обновлено {dateTime(tr.position.updatedAt)}</T> : null}
            <RouteScheme site={tr.site} from={tr.mode === 'live' ? tr.position : tr.base} fromLabel={tr.mode === 'live' ? 'Машинист' : 'Стоянка'} stale={tr.stale} />
          </Card>
        ) : null}
      </Section>

      {CHAT.includes(o.status) ? <Contact orderId={o.id} /> : null}
      {can(current).dispatch && RELEASABLE.includes(o.status) ? <ReplaceAndRelease order={o} onDone={refresh} /> : null}
      {['completed', 'awaiting_final_payment'].includes(o.status) ? <RateCustomer orderId={o.id} /> : null}

      <Section title="История">
        <Card>
          {o.history.filter((h) => h.status !== h.from).slice(-8).map((h, i) => (
            <View key={i} style={{ paddingVertical: 3 }}>
              <T>{ORDER_STATUS_UI[h.status]?.label ?? h.status}</T>
              <T v="small" muted>{dateTime(h.at)}{h.reason ? ` · ${h.reason}` : ''}</T>
            </View>
          ))}
        </Card>
      </Section>
    </ScrollView>
  );
}

function ShiftCard({ order: o, shift: s, onDone }: { order: PartnerOrder; shift: PartnerOrder['shifts'][number]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const canAssign = s.status === 'pending' && ['awaiting_assignment', 'assigned'].includes(o.status);
  const ops = useQuery({
    queryKey: ['order', o.id, 'ops', s.id], enabled: open,
    queryFn: () => api<{ operators: { memberId: string; fullName: string | null; free: boolean }[] }>(`/partner/orders/${o.id}/available-operators?shiftId=${s.id}`),
  });
  const [pick, setPick] = useState('');
  const assign = useMutation({ mutationFn: () => post(`/partner/orders/${o.id}/assign-operator`, { memberId: pick, shiftId: s.id }), onSuccess: () => { setOpen(false); onDone(); } });
  return (
    <Card accent={canAssign && !s.operator}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <T style={{ fontWeight: '600' }}>{dateShort(s.start)}, {time(s.start)}–{time(s.end)}</T>
          <T v="small" muted>{s.hours} {hoursWord(s.hours)} · {s.operator?.fullName ?? 'машинист не назначен'}</T>
        </View>
        <Pill label={SHIFT_LABEL[s.status] ?? s.status} tone={s.status === 'finished' ? 'success' : s.status === 'pending' ? 'neutral' : 'accent'} />
      </View>
      {canAssign && !open ? <Button small kind={s.operator ? 'secondary' : 'primary'} title={s.operator ? 'Заменить машиниста' : 'Назначить машиниста'} onPress={() => setOpen(true)} /> : null}
      {open ? (
        <View style={{ gap: space.sm }}>
          {ops.isLoading ? <Loading /> : null}
          {ops.data && !ops.data.operators.length ? <Notice tone="warning">Нет проверенных машинистов. Добавьте сотрудника и загрузите его документы.</Notice> : null}
          {ops.data?.operators.length ? (
            <Choice value={pick} onChange={setPick} options={ops.data.operators.map((m) => ({ value: m.memberId, label: m.fullName ?? 'Без имени', hint: m.free ? 'Свободен в этот день' : 'Занят в этот день' }))} />
          ) : null}
          {assign.error ? <Notice tone="danger">{(assign.error as Error).message}</Notice> : null}
          <Button small title="Назначить" disabled={!pick} loading={assign.isPending} onPress={() => assign.mutate()} />
          <Button small kind="ghost" title="Отмена" onPress={() => setOpen(false)} />
        </View>
      ) : null}
    </Card>
  );
}

function Contact({ orderId }: { orderId: string }) {
  const t = useTheme();
  const call = useMutation({
    mutationFn: () => post<{ virtualNumber: string; expiresAt: string }>(`/partner/orders/${orderId}/call`),
    onSuccess: (r) => Linking.openURL(`tel:${r.virtualNumber}`).catch(() => undefined),
  });
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}><Button kind="secondary" title="Переписка" icon={<Icon name="chat" color={t.text} size={18} />} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: orderId, as: 'partner' } })} /></View>
        <View style={{ flex: 1 }}><Button kind="secondary" title="Позвонить" icon={<Icon name="phone" color={t.text} size={18} />} loading={call.isPending} onPress={() => call.mutate()} /></View>
      </View>
      {call.data ? <T v="small" muted>Номер для звонка заказчику: {call.data.virtualNumber} (до {time(call.data.expiresAt)}).</T> : null}
      {call.error ? <Notice tone="danger">{(call.error as Error).message}</Notice> : null}
    </View>
  );
}

function ReplaceAndRelease({ order: o, onDone }: { order: PartnerOrder; onDone: () => void }) {
  const [mode, setMode] = useState<null | 'replace' | 'release'>(null);
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');
  const units = useQuery({ queryKey: ['order', o.id, 'units'], enabled: mode === 'replace', queryFn: () => api<{ id: string; brand: string; model: string; reg_number: string | null }[]>(`/partner/orders/${o.id}/replacement-units`) });
  const replace = useMutation({ mutationFn: () => post(`/partner/orders/${o.id}/replace-unit`, { unitId: unit }), onSuccess: () => { setMode(null); onDone(); } });
  const release = useMutation({ mutationFn: () => post(`/partner/orders/${o.id}/release`, { reason }), onSuccess: () => { setMode(null); onDone(); router.back(); } });
  if (!mode) {
    return (
      <View style={{ gap: space.xs }}>
        <Button kind="ghost" title="Заменить технику" onPress={() => setMode('replace')} />
        <Button kind="ghost" title="Не можем выполнить" onPress={() => setMode('release')} />
      </View>
    );
  }
  return (
    <Card>
      {mode === 'replace' ? (
        <>
          <T v="h3">Заменить технику</T>
          {units.data && !units.data.length ? <T muted>Нет другой проверенной техники этого вида.</T> : null}
          {units.data?.length ? <Choice value={unit} onChange={setUnit} options={units.data.map((u) => ({ value: u.id, label: `${u.brand} ${u.model}`, hint: u.reg_number ?? undefined }))} /> : null}
          {replace.error ? <Notice tone="danger">{(replace.error as Error).message}</Notice> : null}
          <Button title="Заменить" disabled={!unit} loading={replace.isPending} onPress={() => replace.mutate()} />
        </>
      ) : (
        <>
          <T v="h3">Отказаться от заказа?</T>
          <T muted>Заказ вернётся в поиск, и ваша компания его больше не получит.</T>
          <Field value={reason} onChangeText={setReason} placeholder="Причина (обязательно)" multiline />
          {release.error ? <Notice tone="danger">{(release.error as Error).message}</Notice> : null}
          <Button kind="danger" title="Отказаться" disabled={reason.trim().length < 3} loading={release.isPending} onPress={() => release.mutate()} />
        </>
      )}
      <Button kind="ghost" title="Отмена" onPress={() => setMode(null)} />
    </Card>
  );
}

function RateCustomer({ orderId }: { orderId: string }) {
  const t = useTheme();
  const ratings = useQuery({ queryKey: ['order', orderId, 'ratings'], queryFn: () => api<{ author_side: string; stars: number }[]>(`/partner/orders/${orderId}/ratings`) });
  const [stars, setStars] = useState(0);
  const rate = useMutation({ mutationFn: () => post(`/partner/orders/${orderId}/ratings`, { stars }), onSuccess: () => ratings.refetch() });
  const done = ratings.data?.find((r) => r.author_side === 'partner')?.stars;
  const shown = done ?? stars;
  return (
    <Section title="Оценка заказчика">
      <Card>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} disabled={done !== undefined} onPress={() => setStars(n)} accessibilityLabel={`${n} из 5`} hitSlop={6}>
              <Icon name="star" size={32} color={n <= shown ? t.accent : t.border} fill={n <= shown ? t.accent : 'none'} />
            </Pressable>
          ))}
        </View>
        {done !== undefined ? <T v="small" muted>Оценка отправлена</T> : stars ? <Button small title="Отправить" loading={rate.isPending} onPress={() => rate.mutate()} /> : <T v="small" muted>Оценку ставит один раз любой сотрудник компании</T>}
        {rate.error ? <Notice tone="danger">{(rate.error as Error).message}</Notice> : null}
      </Card>
    </Section>
  );
}
