import { api, Card, dateShort, ErrorView, Loading, Notice, Pill, space, T, time, useTheme } from '@kovsh/mobile';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useOrg } from '../../lib/org';
import { SHIFT_LABEL } from '../../lib/types';

interface MyShift { orderId: string; number: number; shiftSeq: number; start: string; end: string; shiftStatus: string; siteAddress: string; category: string }

export default function Shifts() {
  const t = useTheme();
  const { current } = useOrg();
  const q = useQuery({ queryKey: ['my-shifts', current?.orgId], queryFn: () => api<MyShift[]>('/partner/operator/orders'), refetchInterval: 30_000 });
  const upcoming = (q.data ?? []).filter((s) => s.shiftStatus !== 'finished' && s.shiftStatus !== 'cancelled');
  const past = (q.data ?? []).filter((s) => s.shiftStatus === 'finished').slice(-5).reverse();
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, width: '100%', maxWidth: 640, alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && !upcoming.length ? <Notice tone="info">Назначенных смен нет. Когда диспетчер назначит вас на заказ, он появится здесь.</Notice> : null}
      {upcoming.map((s, i) => <ShiftItem key={`${s.orderId}-${s.shiftSeq}`} s={s} highlight={i === 0} />)}
      {past.length ? <T v="label" muted style={{ marginTop: space.md }}>ЗАВЕРШЁННЫЕ</T> : null}
      {past.map((s) => <ShiftItem key={`${s.orderId}-${s.shiftSeq}`} s={s} />)}
    </ScrollView>
  );
}

function ShiftItem({ s, highlight }: { s: MyShift; highlight?: boolean }) {
  return (
    <Card accent={highlight} onPress={() => router.push({ pathname: '/shift/[id]', params: { id: s.orderId } })}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T style={{ fontWeight: '700' }}>{dateShort(s.start)}, {time(s.start)}–{time(s.end)}</T>
        <Pill label={SHIFT_LABEL[s.shiftStatus] ?? s.shiftStatus} tone={s.shiftStatus === 'pending' ? 'neutral' : s.shiftStatus === 'finished' ? 'success' : 'accent'} />
      </View>
      <T v="h3">{s.category}</T>
      <T muted>{s.siteAddress}</T>
      <T v="small" muted>Заказ №{s.number}</T>
    </Card>
  );
}
