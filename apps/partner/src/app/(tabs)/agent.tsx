import { api, Button, Card, dateTime, ErrorView, Loading, Notice, Pill, rub, space, T, useTheme } from '@kovsh/mobile';
import { ORDER_STATUS_UI } from '@kovsh/ui';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useOrg } from '../../lib/org';

interface AgentOrder { id: string; number: number; status: string; customerPhone: string; totalKopecks: number; rewardKopecks: number; rewardFinal: boolean; siteAddress: string; firstStartAt: string; category: string }

/** Заявки независимого диспетчера (Н-27, Н-30): видит статус и своё вознаграждение 7%, но не оплату заказчика. */
export default function AgentOrders() {
  const t = useTheme();
  const { current } = useOrg();
  const q = useQuery({ queryKey: ['agent-orders', current?.orgId], queryFn: () => api<AgentOrder[]>('/partner/agent/orders'), refetchInterval: 30_000 });
  const verified = current?.status === 'verified';
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, width: '100%', maxWidth: 640, alignSelf: 'center' }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      {!verified ? <Notice tone="warning">Оформлять заявки можно после проверки документов во вкладке «Компания».</Notice> : null}
      <Button title="Новая заявка за заказчика" disabled={!verified} onPress={() => router.push('/agent/new')} />
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && !q.data.length ? <T muted center>Заявок пока нет.</T> : null}
      {q.data?.map((o) => {
        const ui = ORDER_STATUS_UI[o.status] ?? { label: o.status, tone: 'neutral' as const };
        return (
          <Card key={o.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T v="small" muted>№{o.number} · {o.customerPhone}</T>
              <Pill label={ui.label} tone={ui.tone} />
            </View>
            <T v="h3">{o.category}</T>
            <T muted numberOfLines={1}>{o.siteAddress}</T>
            <T v="small">{dateTime(o.firstStartAt)} · заказ {rub(o.totalKopecks)}</T>
            <T v="small" style={{ fontWeight: '600' }}>Ваше вознаграждение: {o.rewardFinal ? rub(o.rewardKopecks) : `≈ ${rub(o.rewardKopecks)} после завершения`}</T>
          </Card>
        );
      })}
    </ScrollView>
  );
}
