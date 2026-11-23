/** Клиент API админки: токены администратора, автоматическое обновление и единый формат ошибок. */
const BASE = '/api/v1';
const KEY = 'kovsh-admin-session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; fullName: string; role: 'superadmin' | 'support' | 'finance' | 'moderator'; totpEnabled: boolean };
  mustEnrollTotp: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* хранилище недоступно — сессия живёт до перезагрузки */
  }
  listeners.forEach((l) => l(s));
}

const listeners = new Set<(s: Session | null) => void>();
export const onSession = (l: (s: Session | null) => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

async function refresh(s: Session): Promise<Session | null> {
  const res = await fetch(`${BASE}/admin/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
  if (!res.ok) return null;
  const body = (await res.json()) as Session;
  const next = { ...s, ...body };
  saveSession(next);
  return next;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  let session = loadSession();
  const doFetch = (s: Session | null) =>
    fetch(`${BASE}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  let res = await doFetch(session);
  if (res.status === 401 && session && !path.startsWith('/admin/auth/login')) {
    session = await refresh(session);
    if (!session) {
      saveSession(null);
      throw new ApiError(401, 'UNAUTHORIZED', 'Сессия истекла, войдите снова');
    }
    res = await doFetch(session);
  }
  if (init.raw) {
    if (!res.ok) throw new ApiError(res.status, 'ERROR', 'Не удалось загрузить файл');
    return (await res.blob()) as T;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? 'Ошибка запроса', data?.details);
  return data as T;
}
