import { Tabs } from 'expo-router/js-tabs';
import { Icon } from '@kovsh/mobile';
import { useTheme } from '@kovsh/mobile';

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        tabBarActiveTintColor: t.text,
        tabBarInactiveTintColor: t.textMuted,
        tabBarLabelStyle: { fontWeight: '600' },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Заказать технику', tabBarLabel: 'Техника', tabBarIcon: ({ color }) => <Icon name="excavator" color={String(color)} /> }} />
      <Tabs.Screen name="orders" options={{ title: 'Мои заказы', tabBarLabel: 'Заказы', tabBarIcon: ({ color }) => <Icon name="list" color={String(color)} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Профиль', tabBarIcon: ({ color }) => <Icon name="user" color={String(color)} /> }} />
    </Tabs>
  );
}
