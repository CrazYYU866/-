import { api, Button, Card, dateShort, hoursWord, Notice, Pill, post, rub, space, T, time, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useOrg } from '../../lib/org';

export interface Offer {
  offerId: string; orderId: string; number: number; expiresAt: string; serverTime: string; distanceKm: number;
  unit: { id: string; brand: string; model: string; regNumber: string | null };
  category: string; siteAddress: string; siteComment: string | null; firstStartAt: string; totalHours: number; urgency: 'urgent' | 'scheduled';
  shifts: { start: string; end: string; hours: number }[];
  estimate: { amountKopecks: number; deliveryKm: number };
}

/** Предложения заказов (П-8): видят все диспетчеры и руководители, принимает первый. На ответ — 40 секунд. */
export default function Offers() {
  const t = useTheme();
  const { current } = useOrg();
  const q = useQuery({ queryKey: ['offers', current?.orgId], queryFn: () => api<Offer[]>('/partner/offers'), refetchInterval: 5_000 });
  // Разница часов телефона и сервера: таймер считается по серверному времени (план §6, п. 6).
  const skew = useRef(0);
  if (q.data?.[0]) skew.current = new Date(q.data[0].serverTime).getTime() - q.dataUpdatedAt;

  if (current?.status !== 'verified') {
    return (
      <ScrollView contentContainerStyle={s.body}>
        <Notice tone="warning">Предложения заказов приходят после того, как компания пройдёт проверку. Загрузите документы во вкладке «Компания».</Notice>
      </ScrollView>
    );
  }
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={s.body} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      {q.data && !q.data.length ? (
        <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xxl }}>
          <T v="h3">Новых предложений нет</T>
          <T muted center>Держите технику на линии — заказы рядом с её стоянкой появятся здесь.</T>
          <Button kind="secondary" title="Открыть автопарк" onPress={() => router.navigate('/fleet')} />
        </View>
      ) : null}
      {q.error ? <Notice tone="danger">{(q.error as Error).message}</Notice> : null}
      {q.data?.map((o) => <OfferCard key={o.offerId} offer={o} skew={skew.current} />)}
    </ScrollView>
  );
}

function OfferCard({ offer: o, skew }: { offer: Offer; skew: number }) {
  const t = useTheme();
  const qc = useQueryClient();
  const left = useCountdown(o.expiresAt, skew);
  const done = () => qc.invalidateQueries({ queryKey: ['offers'] });
  const accept = useMutation({
    mutationFn: () => post(`/partner/offers/${o.offerId}/accept`),
    onSuccess: () => { done(); qc.invalidateQueries({ queryKey: ['orders'] }); router.push({ pathname: '/order/[id]', params: { id: o.orderId } }); },
    onError: done,
  });
  const skip = useMutation({ mutationFn: () => post(`/partner/offers/${o.offerId}/skip`), onSuccess: done, onError: done });
  const expired = left <= 0;
  const days = o.shifts.length;
  return (
    <Card accent>
      <View style={s.head}>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <T v="small" muted>№{o.number}</T>
          {o.urgency === 'urgent' ? <Pill label="Срочно" tone="danger" /> : null}
        </View>
        <View style={[s.timer, { backgroundColor: left <= 10 ? t.dangerSoft : t.accentSoft }]}>
          <T style={{ fontWeight: '800', color: left <= 10 ? t.danger : t.text, fontVariant: ['tabular-nums'] }}>{expired ? '—' : `0:${String(left).padStart(2, '0')}`}</T>
        </View>
      </View>
      <T v="h3">{o.category}</T>
      <T muted>{o.unit.brand} {o.unit.model}{o.unit.regNumber ? ` · ${o.unit.regNumber}` : ''}</T>
      <View style={{ gap: 2 }}>
        <T>{o.siteAddress}</T>
        <T v="small" muted>~{o.estimate.deliveryKm} км от стоянки техники</T>
      </View>
      <View style={{ gap: 2 }}>
        {o.shifts.slice(0, 3).map((sh) => (
          <T key={sh.start} v="small">{dateShort(sh.start)}, {time(sh.start)}–{time(sh.end)} · {sh.hours} {hoursWord(sh.hours)}</T>
        ))}
        {days > 3 ? <T v="small" muted>и ещё {days - 3} дн.</T> : null}
      </View>
      <View style={[s.amount, { backgroundColor: t.surfaceAlt }]}>
        <T v="small" muted>Вы получите (после комиссии)</T>
        <T v="h2">≈ {rub(o.estimate.amountKopecks)}</T>
        <T v="small" muted>{o.totalHours} {hoursWord(o.totalHours)} работы, доставка учтена</T>
      </View>
      {accept.error ? <Notice tone="danger">{(accept.error as Error).message}</Notice> : null}
      <Button title={expired ? 'Время вышло' : 'Принять заказ'} disabled={expired} loading={accept.isPending} onPress={() => accept.mutate()} />
      {!expired ? <Button kind="ghost" title="Пропустить" loading={skip.isPending} onPress={() => skip.mutate()} /> : null}
    </Card>
  );
}

function useCountdown(expiresAt: string, skew: number) {
  const calc = () => Math.max(0, Math.ceil((new Date(expiresAt).getTime() - (Date.now() + skew)) / 1000));
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setLeft(calc()), 250);
    return () => clearInterval(id);
  });
  return left;
}

const s = StyleSheet.create({
  body: { padding: space.lg, gap: space.md, width: '100%', maxWidth: 640, alignSelf: 'center' },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timer: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, minWidth: 64, alignItems: 'center' },
  amount: { borderRadius: 12, padding: space.md, gap: 2 },
});
