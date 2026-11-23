import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';
import { Button, Card, ErrorView, Loading, Pill, T } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime, rub } from '../../lib/format';
import { VISIBLE_UI, whatNow, type OrderListItem } from '../../lib/orders';
import { space, useTheme } from '../../lib/theme';

const ACTION_NEEDED = ['awaiting_customer_confirmation', 'awaiting_prepayment', 'awaiting_completion_confirmation', 'awaiting_final_payment'];

export default function Orders() {
  const t = useTheme();
  const q = useQuery({ queryKey: ['orders'], queryFn: () => api<OrderListItem[]>('/client/orders'), refetchInterval: 30_000 });
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, width: '100%', maxWidth: 640, alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && !q.data.length ? (
        <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }}>
          <T v="h3">Заказов пока нет</T>
          <T muted center>Выберите технику — мы подберём исполнителя рядом с объектом.</T>
          <Button title="Выбрать технику" onPress={() => router.navigate('/')} />
        </View>
      ) : null}
      {q.data?.map((o) => {
        const ui = VISIBLE_UI[o.visibleStatus];
        const action = ACTION_NEEDED.includes(o.status);
        return (
          <Card key={o.id} accent={action} onPress={() => router.push({ pathname: '/order/[id]', params: { id: o.id } })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T v="small" muted>№{o.number}</T>
              <Pill label={ui.label} tone={ui.tone} />
            </View>
            <T v="h3">{o.category}</T>
            <T muted numberOfLines={1}>{o.siteAddress}</T>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <T v="small">{dateTime(o.firstStartAt)}</T>
              <T v="small" style={{ fontWeight: '600' }}>{rub(o.totalKopecks)}</T>
            </View>
            {action ? <T v="small" style={{ color: t.warning, fontWeight: '600' }}>{whatNow(o.status)}</T> : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}
