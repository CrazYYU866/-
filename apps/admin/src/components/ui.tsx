import { formatRub, ORDER_STATUS_UI } from '@kovsh/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';

export const Money = ({ k }: { k: number | string | null | undefined }) => <span style={{ whiteSpace: 'nowrap' }}>{formatRub(k === null || k === undefined ? null : Number(k))}</span>;

export const DateTime = ({ v }: { v: string | Date | null | undefined }) =>
  // Платформа работает по московскому времени (регионы запуска — Москва и МО); не зависит от часового пояса компьютера.
  v ? <span style={{ whiteSpace: 'nowrap' }}>{new Date(v).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> : <span className="muted">—</span>;

export const Badge = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`badge tone-${tone}`}>{children}</span>;

export const OrderStatus = ({ s }: { s: string }) => {
  const ui = ORDER_STATUS_UI[s] ?? { label: s, tone: 'neutral' };
  return <Badge tone={ui.tone}>{ui.label}</Badge>;
};

const GENERIC: Record<string, [string, string]> = {
  draft: ['Черновик', 'neutral'], pending_review: ['На проверке', 'warning'], verified: ['Подтверждена', 'success'], rejected: ['Отклонена', 'danger'],
  blocked: ['Заблокирована', 'danger'], uploaded: ['На проверке', 'warning'], approved: ['Одобрен', 'success'], pending: ['Ожидает', 'warning'],
  decided: ['Решено', 'success'], awaiting_approval: ['Ждёт подтверждения', 'warning'], paid: ['Оплачено', 'success'], issued: ['Выставлен', 'info'],
  expired: ['Просрочен', 'danger'], open: ['Открыт', 'warning'], processing: ['В обработке', 'info'], missing: ['Нет', 'neutral'], active: ['Активен', 'success'],
  disabled: ['Отключён', 'neutral'], cancelled: ['Отменён', 'neutral'], succeeded: ['Успешно', 'success'], failed: ['Ошибка', 'danger'], resolved: ['Решено', 'success'],
};
export const Status = ({ s }: { s: string }) => {
  const [label, tone] = GENERIC[s] ?? [s, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
};

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error">{error instanceof ApiError || error instanceof Error ? error.message : 'Ошибка'}</div>;
}

/** Кнопка действия: запрос к API, ошибка рядом, обновление указанных данных. */
export function Action(props: { label: string; path: string; body?: unknown; tone?: 'primary' | 'danger' | 'ghost'; invalidate: unknown[][]; confirm?: string; prompt?: string; promptField?: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>(null);
  const m = useMutation({
    mutationFn: async () => {
      let body = props.body ?? {};
      if (props.prompt) {
        const value = window.prompt(props.prompt);
        if (!value) throw new Error('Отменено');
        body = { ...(body as object), [props.promptField ?? 'reason']: value };
      } else if (props.confirm && !window.confirm(props.confirm)) {
        throw new Error('Отменено');
      }
      return api(props.path, { method: 'POST', body });
    },
    onSuccess: () => {
      setErr(null);
      props.invalidate.forEach((k) => void qc.invalidateQueries({ queryKey: k }));
    },
    onError: (e) => setErr(e instanceof Error && e.message === 'Отменено' ? null : e),
  });
  return (
    <span className="row">
      <button className={props.tone ?? ''} disabled={m.isPending || props.disabled} onClick={() => m.mutate()}>{m.isPending ? '…' : props.label}</button>
      {err ? <ErrorBox error={err} /> : null}
    </span>
  );
}

/** Открыть приватный файл (документ) — загрузка с токеном и показ во вкладке. */
export function FileLink({ fileId, label }: { fileId: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="ghost" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const blob = await api<Blob>(`/admin/files/${fileId}/content`, { raw: true });
        window.open(URL.createObjectURL(blob), '_blank', 'noopener');
      } finally {
        setBusy(false);
      }
    }}>{label ?? 'Открыть файл'}</button>
  );
}

export function Table<T>({ rows, cols, onRow, empty }: { rows: T[] | undefined; cols: { h: string; c: (r: T) => ReactNode }[]; onRow?: (r: T) => void; empty?: string }) {
  if (!rows) return <div className="empty">Загрузка…</div>;
  if (rows.length === 0) return <div className="empty">{empty ?? 'Пусто'}</div>;
  return (
    <table>
      <thead><tr>{cols.map((c) => <th key={c.h}>{c.h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className={onRow ? 'click' : ''} onClick={() => onRow?.(r)}>{cols.map((c) => <td key={c.h}>{c.c(r)}</td>)}</tr>)}</tbody>
    </table>
  );
}
