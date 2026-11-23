import { Platform } from 'react-native';
import { storage } from './storage';

/**
 * Адрес сервера. В сборке задаётся EXPO_PUBLIC_API_URL; в браузерном просмотре — тот же адрес, что у страницы.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? '' : 'http://localhost:3000')).replace(/\/$/, '');
const BASE = `${API_URL}/api/v1`;
const KEY = 'kovsh.client.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; fullName: string | null };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

let session: Session | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(s: Session | null) => void>();

export const auth = {
  async load(): Promise<Session | null> {
    const raw = await storage.get(KEY);
    session = raw ? (JSON.parse(raw) as Session) : null;
    return session;
  },
  get current() {
    return session;
  },
  async set(s: Session | null) {
    session = s;
    await storage.set(KEY, s ? JSON.stringify(s) : null);
    listeners.forEach((l) => l(s));
  },
  subscribe(l: (s: Session | null) => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

async function refresh(): Promise<boolean> {
  if (!session) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session!.refreshToken }),
      });
      if (!res.ok) {
        await auth.set(null);
        return false;
      }
      const body = (await res.json()) as Session;
      await auth.set({ ...session!, ...body });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
  }
  if (res.status === 401 && init.retry !== false && session && (await refresh())) return api<T>(path, { ...init, retry: false });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = data?.error ?? data ?? {};
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? 'Что-то пошло не так', err.details);
  }
  return data as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
