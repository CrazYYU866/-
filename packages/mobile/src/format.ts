import { formatRub } from '@kovsh/ui';

export const rub = (k: number | null | undefined) => formatRub(k ?? null);

/** Платформа работает по московскому времени (регионы запуска — Москва и МО). */
const TZ = 'Europe/Moscow';
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
export const dateShort = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short', weekday: 'short' });
export const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

export function hoursWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'час';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'часа';
  return 'часов';
}

/** Телефон: оставляем цифры и ведущий +7. */
export function normalizePhone(input: string): string {
  const d = input.replace(/\D/g, '');
  if (d.length === 11 && (d.startsWith('7') || d.startsWith('8'))) return `+7${d.slice(1)}`;
  if (d.length === 10) return `+7${d}`;
  return `+${d}`;
}
export function maskPhone(input: string): string {
  const d = input.replace(/\D/g, '').replace(/^[78]/, '').slice(0, 10);
  const p = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
  let out = '+7';
  if (p[0]) out += ` (${p[0]}`;
  if (p[0]?.length === 3) out += ')';
  if (p[1]) out += ` ${p[1]}`;
  if (p[2]) out += `-${p[2]}`;
  if (p[3]) out += `-${p[3]}`;
  return out;
}
