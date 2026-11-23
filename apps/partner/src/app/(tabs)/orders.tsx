import { api, Card, dateTime, ErrorView, Loading, Pill, rub, space, T, useTheme } from '@kovsh/mobile';
import { ORDER_STATUS_UI } from '@kovsh/ui';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useOrg } from '../../lib/org';
import type { PartnerOrder } from '../../lib/types';

const NEEDS_ACTION = ['awaiting_assignment'];

export default function Orders() {
  const t = useTheme();
  const { current } = useOrg();
  const q = useQuery({ queryKey: ['orders', current?.orgId], queryFn: () => api<PartnerOrder[]>('/partner/orders'), refetchInterval: 30_000 });
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, width: '100%', maxWidth: 640, alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && !q.data.length ? <T muted center>Принятые заказы появятся здесь.</T> : null}
      {q.data?.map((o) => {
        const ui = ORDER_STATUS_UI[o.status] ?? { label: o.status, tone: 'neutral' as const };
        const noOperator = o.shifts.some((s) => !s.operator && s.status === 'pending');
        const action = NEEDS_ACTION.includes(o.status) || (noOperator && !['completed', 'cancelled', 'awaiting_final_payment'].includes(o.status));
        return (
          <Card key={o.id} accent={action} onPress={() => router.push({ pathname: '/order/[id]', params: { id: o.id } })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T v="small" muted>№{o.number}</T>
              <Pill label={ui.label} tone={ui.tone} />
            </View>
            <T v="h3">{o.category}</T>
            <T muted numberOfLines={1}>{o.site.address}</T>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <T v="small">{dateTime(o.shifts[0]?.start ?? '')}</T>
              {o.partnerPrice?.amountKopecks != null ? <T v="small" style={{ fontWeight: '600' }}>{rub(o.partnerPrice.amountKopecks)}</T> : null}
            </View>
            {action ? <T v="small" style={{ color: t.warning, fontWeight: '600' }}>Назначьте машиниста</T> : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}
