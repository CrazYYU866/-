import '../lib/gps';
import { ApiError, configureApi, Loading, SessionProvider, useSession, useTheme } from '@kovsh/mobile';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OrgProvider, useOrg } from '../lib/org';
import { flushQueue } from '../lib/queue';

configureApi('partner');

function RootStack() {
  const { session, ready } = useSession();
  const org = useOrg();
  const t = useTheme();
  // Накопленные без связи статусы и координаты отправляются при возврате в приложение и периодически.
  useEffect(() => {
    if (!session) return;
    flushQueue().catch(() => undefined);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && flushQueue().catch(() => undefined));
    const id = setInterval(() => flushQueue().catch(() => undefined), 30_000);
    return () => { sub.remove(); clearInterval(id); };
  }, [session]);
  if (!ready || !org.ready) return <Loading />;
  const hasOrg = Boolean(org.current);
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, headerTitleStyle: { fontWeight: '600' }, contentStyle: { backgroundColor: t.bg }, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!session && !hasOrg}>
        <Stack.Screen name="welcome" options={{ title: 'Ковш на Час Партнёр' }} />
      </Stack.Protected>
      <Stack.Protected guard={!!session && hasOrg}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="order/[id]" options={{ title: 'Заказ' }} />
        <Stack.Screen name="shift/[id]" options={{ title: 'Смена' }} />
        <Stack.Screen name="unit/[id]" options={{ title: 'Техника' }} />
        <Stack.Screen name="unit/new" options={{ title: 'Новая техника' }} />
        <Stack.Screen name="unit/schedule" options={{ title: 'Расписание' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Переписка' }} />
        <Stack.Screen name="agent/new" options={{ title: 'Заявка за заказчика' }} />
        <Stack.Screen name="company/documents" options={{ title: 'Документы компании' }} />
        <Stack.Screen name="company/members" options={{ title: 'Сотрудники' }} />
        <Stack.Screen name="company/bank" options={{ title: 'Реквизиты для выплат' }} />
        <Stack.Screen name="company/finance" options={{ title: 'Финансы' }} />
        <Stack.Screen name="company/my-documents" options={{ title: 'Мои документы' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500), staleTime: 10_000 } },
  }));
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <SessionProvider>
          <OrgProvider>
            <StatusBar style="auto" />
            <RootStack />
          </OrgProvider>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
