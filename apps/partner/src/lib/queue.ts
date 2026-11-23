import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, ApiError, post } from '@kovsh/mobile';
import * as Crypto from 'expo-crypto';

/**
 * Офлайн-очередь машиниста (Р-18, П-15): статусы и координаты сначала сохраняются на телефоне,
 * затем отправляются пачкой. Каждое событие имеет свой id — повторная отправка не создаёт дублей.
 */
export interface StatusEvent { clientEventId: string; orderId: string; orgId: string; status: 'en_route' | 'arrived' | 'in_progress' | 'finished'; recordedAt: string; point?: { lat: number; lng: number }; locationUnavailableReason?: string }
export interface GpsPoint { lat: number; lng: number; accuracy?: number; speed?: number; heading?: number; recordedAt: string }

const EVENTS = 'kovsh.partner.queue.events';
const POINTS = 'kovsh.partner.queue.points';

async function read<T>(key: string): Promise<T> {
  try { return JSON.parse((await AsyncStorage.getItem(key)) ?? 'null') ?? ([] as T); } catch { return [] as T; }
}
const write = (key: string, v: unknown) => AsyncStorage.setItem(key, JSON.stringify(v));

export async function enqueueStatus(e: Omit<StatusEvent, 'clientEventId' | 'recordedAt'>): Promise<StatusEvent> {
  const ev: StatusEvent = { ...e, clientEventId: Crypto.randomUUID(), recordedAt: new Date().toISOString() };
  await write(EVENTS, [...(await read<StatusEvent[]>(EVENTS)), ev]);
  return ev;
}

export async function enqueuePoints(orderId: string, orgId: string, points: GpsPoint[]) {
  if (!points.length) return;
  const cur = await read<Record<string, { orgId: string; points: GpsPoint[] }>>(POINTS);
  const q = Array.isArray(cur) ? {} : cur;
  const entry = q[orderId] ?? { orgId, points: [] };
  // На случай долгого отсутствия связи храним не больше 2000 последних точек по заказу.
  entry.points = [...entry.points, ...points].slice(-2000);
  q[orderId] = entry;
  await write(POINTS, q);
}

export const pendingStatusCount = async (orderId?: string) => (await read<StatusEvent[]>(EVENTS)).filter((e) => !orderId || e.orderId === orderId).length;

let flushing: Promise<void> | null = null;

/** Отправить накопленное. Ошибка сети — оставить в очереди; отказ сервера по событию — убрать (сервер вернул результат). */
export function flushQueue(): Promise<void> {
  flushing ??= (async () => {
    try {
      const events = await read<StatusEvent[]>(EVENTS);
      const byOrder = new Map<string, StatusEvent[]>();
      for (const e of events) byOrder.set(e.orderId, [...(byOrder.get(e.orderId) ?? []), e]);
      for (const [orderId, list] of byOrder) {
        try {
          await api(`/partner/operator/orders/${orderId}/status-events`, {
            method: 'POST',
            body: { events: list.slice(0, 50).map(({ orderId: _o, orgId: _g, ...rest }) => rest) },
            orgOverride: list[0]!.orgId,
          });
          const sent = new Set(list.slice(0, 50).map((e) => e.clientEventId));
          await write(EVENTS, (await read<StatusEvent[]>(EVENTS)).filter((e) => !sent.has(e.clientEventId)));
        } catch (err) {
          if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) continue;
          // 4xx: сервер отклонил пачку (заказ отменён, нет прав) — повтор не поможет (С-29).
          const drop = new Set(list.map((e) => e.clientEventId));
          await write(EVENTS, (await read<StatusEvent[]>(EVENTS)).filter((e) => !drop.has(e.clientEventId)));
        }
      }
      const points = await read<Record<string, { orgId: string; points: GpsPoint[] }>>(POINTS);
      for (const [orderId, entry] of Object.entries(Array.isArray(points) ? {} : points)) {
        const batch = entry.points.slice(0, 500);
        if (!batch.length) continue;
        try {
          await post('/partner/operator/locations', { orderId, points: batch }, entry.orgId);
          const cur = await read<Record<string, { orgId: string; points: GpsPoint[] }>>(POINTS);
          if (cur[orderId]) cur[orderId].points = cur[orderId].points.slice(batch.length);
          await write(POINTS, cur);
        } catch (err) {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401) {
            const cur = await read<Record<string, { orgId: string; points: GpsPoint[] }>>(POINTS);
            delete cur[orderId];
            await write(POINTS, cur);
          }
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
