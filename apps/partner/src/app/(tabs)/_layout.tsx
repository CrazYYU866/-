import { Icon, useTheme } from '@kovsh/mobile';
import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router/js-tabs';
import { api } from '@kovsh/mobile';
import { can, useOrg } from '../../lib/org';

/** Вкладки зависят от роли в выбранной компании (Р-2, Р-17): диспетчерская часть, режим машиниста, заявки диспетчера-агента. */
export default function TabsLayout() {
  const t = useTheme();
  const { current } = useOrg();
  const c = can(current);
  const verified = current?.status === 'verified';
  const offers = useQuery({
    queryKey: ['offers', current?.orgId], enabled: c.dispatch && verified, refetchInterval: 5_000,
    queryFn: () => api<unknown[]>('/partner/offers'),
  });
  const icon = (name: string) => ({ color }: { color: unknown }) => <Icon name={name} color={String(color)} />;
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, headerTitleStyle: { fontWeight: '700' },
      tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border }, tabBarActiveTintColor: t.text, tabBarInactiveTintColor: t.textMuted,
      tabBarLabelStyle: { fontWeight: '600' }, sceneStyle: { backgroundColor: t.bg },
    }}>
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="offers" options={{ title: 'Новые заказы', tabBarLabel: 'Предложения', href: c.dispatch ? undefined : null, tabBarIcon: icon('bell'), tabBarBadge: offers.data?.length ? offers.data.length : undefined, tabBarBadgeStyle: { backgroundColor: t.accent, color: t.accentText } }} />
      <Tabs.Screen name="orders" options={{ title: 'Заказы компании', tabBarLabel: 'Заказы', href: c.dispatch ? undefined : null, tabBarIcon: icon('list') }} />
      <Tabs.Screen name="shifts" options={{ title: 'Мои смены', tabBarLabel: 'Смены', href: c.operate ? undefined : null, tabBarIcon: icon('clock') }} />
      <Tabs.Screen name="agent" options={{ title: 'Мои заявки', tabBarLabel: 'Заявки', href: c.agent ? undefined : null, tabBarIcon: icon('list') }} />
      <Tabs.Screen name="fleet" options={{ title: 'Автопарк', tabBarLabel: 'Техника', href: c.dispatch ? undefined : null, tabBarIcon: icon('excavator') }} />
      <Tabs.Screen name="company" options={{ title: current?.name ?? 'Компания', tabBarLabel: 'Компания', tabBarIcon: icon('user') }} />
    </Tabs>
  );
}
