import { Platform } from 'react-native';
import { storage } from './storage';

/**
 * Адрес сервера. В сборке задаётся EXPO_PUBLIC_API_URL; в браузерном просмотре — тот же адрес, что у страницы.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? '' : 'http://localhost:3000')).replace(/\/$/, '');
const BASE = `${API_URL}/api/v1`;

export type AppKind = 'client' | 'partner';
let APP: AppKind = 'client';
let orgId: string | null = null;

/** Вызывается один раз при старте приложения: от этого зависят ключ хранения сессии и вход по SMS. */
export function configureApi(app: AppKind) {
  APP = app;
}
export const currentApp = () => APP;
const KEY = () => `kovsh.${APP}.session`;

/** Компания, от имени которой работает пользователь приложения партнёра (Р-13: права — по роли в этой компании). */
export function setOrgId(id: string | null) {
  orgId = id;
}
export const getOrgId = () => orgId;

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
    const raw = await storage.get(KEY());
    session = raw ? (JSON.parse(raw) as Session) : null;
    return session;
  },
  get current() {
    return session;
  },
  async set(s: Session | null) {
    session = s;
    await storage.set(KEY(), s ? JSON.stringify(s) : null);
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

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; retry?: boolean; noOrg?: boolean; orgOverride?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  const org = init.orgOverride ?? orgId;
  if (org && !init.noOrg) headers['X-Org-Id'] = org;
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

export const post = <T = unknown>(path: string, body: unknown = {}, orgOverride?: string) => api<T>(path, { method: 'POST', body, orgOverride });

/** Загрузка файла (документ, фото): multipart, поле `file`. */
export async function uploadFile(file: { uri: string; name: string; mimeType: string; webFile?: Blob }): Promise<{ id: string }> {
  const form = new FormData();
  if (file.webFile) form.append('file', file.webFile, file.name);
  else form.append('file', { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  const send = () =>
    fetch(`${BASE}/files`, { method: 'POST', body: form, headers: session ? { Authorization: `Bearer ${session.accessToken}` } : {} });
  let res = await send().catch(() => null);
  if (res?.status === 401 && (await refresh())) res = await send().catch(() => null);
  if (!res) throw new ApiError(0, 'NETWORK', 'Нет связи с сервером');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.code ?? 'ERROR', data.message ?? 'Не удалось загрузить файл');
  return data as { id: string };
}
