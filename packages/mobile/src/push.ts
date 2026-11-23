import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { api, post } from './api';
import { storage } from './storage';

/**
 * Push-уведомления (ТЗ §16). Провайдер отправки на сервере ещё не выбран (Expo Push / FCM+APNs / RuStore),
 * поэтому токен регистрируется так, чтобы подошёл любой вариант:
 *  - если у сборки есть projectId EAS — Expo-токен («ExponentPushToken[…]», работает через Expo Push);
 *  - иначе — системный токен устройства (FCM на Android, APNs на iOS).
 * Сервер различает их по виду строки; смена провайдера не требует изменений в приложениях.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const SENT_KEY = 'kovsh.push.registered';

async function obtainToken(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null; // на эмуляторе и в браузере push недоступны
  if (Platform.OS === 'android') {
    // Отдельный канал с высоким приоритетом: предложение заказа живёт 40 секунд.
    await Notifications.setNotificationChannelAsync('orders', {
      name: 'Заказы',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 300, 200, 300],
      lightColor: '#F5B000',
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const status = current.status === 'granted' ? current.status : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (projectId) return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  return String((await Notifications.getDevicePushTokenAsync()).data);
}

/** Зарегистрировать устройство после входа. Повторно — только если токен изменился. */
export function usePushRegistration(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await obtainToken();
        if (!token || cancelled) return;
        const key = `${userId}:${token}`;
        if ((await storage.get(SENT_KEY)) === key) return;
        await post('/me/push-devices', { platform: Platform.OS === 'ios' ? 'ios' : 'android', token });
        await storage.set(SENT_KEY, key);
      } catch {
        // Нет разрешения или сети — приложение работает без push, повторим при следующем запуске.
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);
}

/** При выходе: убрать устройство с сервера, чтобы уведомления не приходили следующему пользователю телефона. */
export async function unregisterPush(): Promise<void> {
  const saved = await storage.get(SENT_KEY);
  if (!saved) return;
  const token = saved.slice(saved.indexOf(':') + 1);
  await api(`/me/push-devices/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => undefined);
  await storage.set(SENT_KEY, null);
}

/** Нажатие на уведомление открывает связанный экран (данные уведомления: type, orderId). */
export function usePushNavigation(open: (data: { type?: string; orderId?: string }) => void) {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.getLastNotificationResponseAsync().then((r) => { if (r) open(r.notification.request.content.data as never); }).catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data as never));
    return () => sub.remove();
  }, [open]);
}
