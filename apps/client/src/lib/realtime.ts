import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, auth } from './api';

let socket: Socket | null = null;
let socketToken: string | null = null;

/** Одно соединение на приложение; при смене токена — переподключение. */
function getSocket(): Socket | null {
  const token = auth.current?.accessToken ?? null;
  if (!token) return null;
  if (socket && socketToken === token) return socket;
  socket?.disconnect();
  socketToken = token;
  socket = io(`${API_URL}/ws`, { auth: { token }, transports: ['websocket'], reconnection: true });
  return socket;
}

/** События по заказу (статус, чат, координаты) — обновляем экран сразу, без ожидания опроса. */
export function useOrderRealtime(orderId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    const s = orderId ? getSocket() : null;
    if (!s || !orderId) return;
    const join = () => s.emit('subscribe_order', { orderId });
    join();
    s.on('connect', join);
    const onEvent = () => {
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    };
    const onChat = () => qc.invalidateQueries({ queryKey: ['chat', orderId] });
    const onTrack = () => qc.invalidateQueries({ queryKey: ['tracking', orderId] });
    s.on('order.event', onEvent);
    s.on('chat.message', onChat);
    s.on('tracking.update', onTrack);
    return () => {
      s.off('connect', join);
      s.off('order.event', onEvent);
      s.off('chat.message', onChat);
      s.off('tracking.update', onTrack);
    };
  }, [orderId, qc]);
}
