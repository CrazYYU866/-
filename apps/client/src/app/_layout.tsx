import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiError, configureApi, Loading, SessionProvider, useSession, useTheme } from '@kovsh/mobile';

configureApi('client');

function RootStack() {
  const { session, ready } = useSession();
  const t = useTheme();
  if (!ready) return <Loading />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: t.bg },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      {/* Заявка по SMS-ссылке — доступна и без входа (Н-30). */}
      <Stack.Screen name="o/[token]" options={{ title: 'Заявка' }} />
      <Stack.Protected guard={!session}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="new-order/[categoryId]" options={{ title: 'Новый заказ' }} />
        <Stack.Screen name="order/[id]/index" options={{ title: 'Заказ' }} />
        <Stack.Screen name="order/[id]/chat" options={{ title: 'Переписка' }} />
        <Stack.Screen name="organizations" options={{ title: 'Организации' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500), staleTime: 10_000 },
        },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <SessionProvider>
          <StatusBar style="auto" />
          <RootStack />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
