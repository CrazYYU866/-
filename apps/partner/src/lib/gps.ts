import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, getOrgId } from '@kovsh/mobile';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { enqueuePoints, flushQueue, type GpsPoint } from './queue';

/**
 * GPS машиниста (ТЗ §9, П-1, П-2): координаты передаются только в пути — с «Выехал» до «Прибыл».
 * На телефоне работает фоновая задача: трек идёт и при свёрнутом приложении и заблокированном экране
 * (Android — постоянное уведомление, iOS — индикатор геолокации). Без связи точки копятся и уходят пачкой.
 */
const TASK = 'kovsh-operator-gps';
const ACTIVE = 'kovsh.partner.gps.active';
interface Active { orderId: string; orgId: string }

const toPoint = (l: Location.LocationObject): GpsPoint => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  accuracy: l.coords.accuracy ?? undefined,
  speed: l.coords.speed !== null && l.coords.speed >= 0 ? Math.min(l.coords.speed, 100) : undefined,
  heading: l.coords.heading !== null && l.coords.heading >= 0 ? l.coords.heading : undefined,
  recordedAt: new Date(l.timestamp).toISOString(),
});

async function active(): Promise<Active | null> {
  try { return JSON.parse((await AsyncStorage.getItem(ACTIVE)) ?? 'null'); } catch { return null; }
}

if (Platform.OS !== 'web' && !TaskManager.isTaskDefined(TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const a = await active();
    if (!a) return;
    // Приложение могло быть запущено системой только ради задачи — поднимаем сессию из хранилища.
    if (!auth.current) await auth.load();
    await enqueuePoints(a.orderId, a.orgId, data.locations.map(toPoint));
    await flushQueue().catch(() => undefined);
  });
}

let webWatch: Location.LocationSubscription | null = null;

export type StartResult = { ok: true; background: boolean } | { ok: false; reason: 'permission_denied' | 'gps_off' };

/** Нужно ли показать пояснение перед запросом фоновой геолокации (требование Google Play и App Store). */
export async function needsBackgroundDisclosure(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  return (await Location.getBackgroundPermissionsAsync()).status !== 'granted';
}

export async function startTracking(orderId: string, orgId = getOrgId() ?? '', askBackground = true): Promise<StartResult> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'permission_denied' };
  if (Platform.OS !== 'web' && !(await Location.hasServicesEnabledAsync())) return { ok: false, reason: 'gps_off' };
  await AsyncStorage.setItem(ACTIVE, JSON.stringify({ orderId, orgId } satisfies Active));

  if (Platform.OS === 'web') {
    webWatch?.remove();
    webWatch = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 15_000, distanceInterval: 30 }, (l) => {
      enqueuePoints(orderId, orgId, [toPoint(l)]).then(() => flushQueue()).catch(() => undefined);
    });
    return { ok: true, background: false };
  }
  const bg = askBackground ? await Location.requestBackgroundPermissionsAsync() : await Location.getBackgroundPermissionsAsync();
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 15_000,
    distanceInterval: 30,
    deferredUpdatesInterval: 30_000,
    pausesUpdatesAutomatically: false,
    activityType: Location.LocationActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Вы в пути к объекту',
      notificationBody: 'Заказчик видит, где вы. Передача остановится после «Прибыл».',
      notificationColor: '#F5B000',
    },
  });
  return { ok: true, background: bg.status === 'granted' };
}

export async function stopTracking(): Promise<void> {
  await AsyncStorage.removeItem(ACTIVE);
  webWatch?.remove();
  webWatch = null;
  if (Platform.OS !== 'web' && (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false))) {
    await Location.stopLocationUpdatesAsync(TASK);
  }
  await flushQueue().catch(() => undefined);
}

export const trackingOrder = async () => (await active())?.orderId ?? null;

/** Точка для события статуса; если получить нельзя — причина (сервер принимает статус и без координат). */
export async function pointForStatus(): Promise<{ point?: { lat: number; lng: number }; locationUnavailableReason?: 'permission_denied' | 'gps_off' | 'timeout' | 'unknown' }> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== 'granted') return { locationUnavailableReason: 'permission_denied' };
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    const pos = last ?? (await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
    ]));
    if (!pos) return { locationUnavailableReason: 'timeout' };
    return { point: { lat: pos.coords.latitude, lng: pos.coords.longitude } };
  } catch {
    return { locationUnavailableReason: 'unknown' };
  }
}
