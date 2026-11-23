import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Action, DateTime, ErrorBox, Status, Table } from '../components/ui';

export function SettingsPage({ role }: { role: string }) {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<{ key: string; value: unknown; isDefault: boolean; configured: boolean; source: string }[]>('/admin/settings') });
  const qc = useQueryClient();
  const [edit, setEdit] = useState<{ key: string; value: string } | null>(null);
  const m = useMutation({
    mutationFn: (e: { key: string; value: string }) => {
      let value: unknown = e.value;
      try { value = JSON.parse(e.value); } catch { /* строка */ }
      return api(`/admin/settings/${e.key}`, { method: 'PATCH', body: { value } });
    },
    onSuccess: () => { setEdit(null); void qc.invalidateQueries({ queryKey: ['settings'] }); },
  });
  return (
    <>
      <h1>Настройки платформы</h1>
      <p className="muted">Все изменяемые параметры ТЗ §22. Значение по умолчанию задано только там, где оно утверждено; «не задано» — функция не работает, пока значение не укажут.</p>
      <div className="card">
        <Table rows={q.data} cols={[
          { h: 'Параметр', c: (s) => <span className="mono">{s.key}</span> },
          { h: 'Значение', c: (s) => (edit?.key === s.key
            ? <span className="row"><input value={edit.value} onChange={(e) => setEdit({ key: s.key, value: e.target.value })} /><button className="primary" onClick={() => m.mutate(edit)}>OK</button><button className="ghost" onClick={() => setEdit(null)}>×</button></span>
            : s.configured ? <b>{JSON.stringify(s.value)}</b> : <span className="error">не задано</span>) },
          { h: 'Основание', c: (s) => <span className="muted">{s.source}{s.isDefault ? '' : ' · изменено'}</span> },
          { h: '', c: (s) => (role === 'superadmin' && edit?.key !== s.key ? <button onClick={() => setEdit({ key: s.key, value: s.configured ? JSON.stringify(s.value) : '' })}>Изменить</button> : null) },
        ]} />
        <ErrorBox error={m.error} />
      </div>
    </>
  );
}

export function PromoPage({ role }: { role: string }) {
  const q = useQuery({ queryKey: ['promo'], queryFn: () => api<{ id: string; code: string; percent: number; first_order_only: boolean; valid_to: string | null; max_uses: number | null; active: boolean; used: number; reserved: number; description: string | null }[]>('/admin/promo-codes') });
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', percent: '10', validTo: '', maxUses: '', description: '' });
  const m = useMutation({
    mutationFn: () => api('/admin/promo-codes', { method: 'POST', body: { code: f.code, percent: Number(f.percent), ...(f.validTo ? { validTo: new Date(f.validTo).toISOString() } : {}), ...(f.maxUses ? { maxUses: Number(f.maxUses) } : {}), description: f.description || undefined } }),
    onSuccess: () => { setF({ ...f, code: '' }); void qc.invalidateQueries({ queryKey: ['promo'] }); },
  });
  return (
    <>
      <h1>Промокоды</h1>
      <p className="muted">Скидка — за счёт комиссии платформы (Н-15); «первый заказ» — первый успешно завершённый (К-13).</p>
      {role === 'superadmin' && <div className="card"><div className="row">
        <input placeholder="КОД" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        <input placeholder="%" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} style={{ width: 60 }} />
        <label className="row muted">до <input type="datetime-local" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></label>
        <input placeholder="Лимит использований" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} />
        <input placeholder="Описание" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <button className="primary" onClick={() => m.mutate()} disabled={!f.code || m.isPending}>Создать</button>
      </div><ErrorBox error={m.error} /></div>}
      <div className="card" style={{ marginTop: 12 }}>
        <Table rows={q.data} empty="Промокодов нет" cols={[
          { h: 'Код', c: (p) => <b className="mono">{p.code}</b> }, { h: 'Скидка', c: (p) => `${p.percent}%${p.first_order_only ? ', первый заказ' : ''}` },
          { h: 'Действует до', c: (p) => <DateTime v={p.valid_to} /> }, { h: 'Использовано', c: (p) => `${p.used}${p.max_uses ? ` из ${p.max_uses}` : ''} · в работе ${p.reserved}` },
          { h: 'Статус', c: (p) => <Status s={p.active ? 'active' : 'disabled'} /> },
        ]} />
      </div>
    </>
  );
}

export function UsersPage() {
  const [phone, setPhone] = useState('');
  const q = useQuery({ queryKey: ['users', phone], queryFn: () => api<{ id: string; phone: string; fullName: string | null; status: string; createdAt: string }[]>(`/admin/users${phone ? `?phone=${encodeURIComponent(phone)}` : ''}`) });
  return (
    <>
      <div className="spread"><h1>Пользователи</h1><input placeholder="Телефон" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
      <div className="card">
        <Table rows={q.data} cols={[
          { h: 'Телефон', c: (u) => u.phone }, { h: 'Имя', c: (u) => u.fullName ?? '—' }, { h: 'С', c: (u) => <DateTime v={u.createdAt} /> },
          { h: 'Статус', c: (u) => <Status s={u.status === 'blocked' ? 'blocked' : 'active'} /> },
          { h: '', c: (u) => (u.status === 'blocked'
            ? <Action label="Разблокировать" path={`/admin/users/${u.id}/unblock`} invalidate={[['users']]} />
            : <Action label="Заблокировать" tone="danger" path={`/admin/users/${u.id}/block`} prompt="Причина блокировки" invalidate={[['users']]} />) },
        ]} />
      </div>
    </>
  );
}

export function AdminsPage() {
  const q = useQuery({ queryKey: ['admins'], queryFn: () => api<{ id: string; email: string; fullName: string; role: string; status: string; totpEnabled: boolean; lastLoginAt: string | null }[]>('/admin/admins') });
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', fullName: '', role: 'support', password: '' });
  const m = useMutation({ mutationFn: () => api('/admin/admins', { method: 'POST', body: f }), onSuccess: () => { setF({ ...f, email: '', fullName: '', password: '' }); void qc.invalidateQueries({ queryKey: ['admins'] }); } });
  return (
    <>
      <h1>Администраторы</h1>
      <div className="card"><div className="row">
        <input placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input placeholder="ФИО" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="superadmin">Суперадминистратор</option><option value="support">Поддержка</option><option value="finance">Финансист</option><option value="moderator">Модератор</option></select>
        <input type="password" placeholder="Временный пароль (от 12 символов)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <button className="primary" onClick={() => m.mutate()} disabled={m.isPending}>Добавить</button>
      </div><ErrorBox error={m.error} /></div>
      <div className="card" style={{ marginTop: 12 }}>
        <Table rows={q.data} cols={[
          { h: 'Администратор', c: (a) => <>{a.fullName}<div className="muted">{a.email}</div></> }, { h: 'Роль', c: (a) => a.role },
          { h: '2FA', c: (a) => (a.totpEnabled ? 'подключена' : 'ждёт подключения') }, { h: 'Последний вход', c: (a) => <DateTime v={a.lastLoginAt} /> },
          { h: 'Статус', c: (a) => <Status s={a.status} /> },
        ]} />
      </div>
    </>
  );
}

export function AuditPage() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<{ id: number; action: string; entity: string; entity_id: string | null; reason: string | null; created_at: string; admin_id: string | null }[]>('/admin/audit-log') });
  return (
    <>
      <h1>Журнал действий</h1>
      <div className="card"><Table rows={q.data} cols={[
        { h: 'Когда', c: (e) => <DateTime v={e.created_at} /> }, { h: 'Действие', c: (e) => <span className="mono">{e.action}</span> },
        { h: 'Объект', c: (e) => <span className="mono">{e.entity}{e.entity_id ? ` · ${e.entity_id.slice(0, 8)}` : ''}</span> }, { h: 'Причина', c: (e) => e.reason ?? '' },
      ]} /></div>
    </>
  );
}

export function RatingComplaintsPage() {
  const q = useQuery({ queryKey: ['complaints'], queryFn: () => api<{ id: string; rating_id: string; reason: string; stars: number; text: string | null; rating_status: string; created_at: string }[]>('/admin/rating-complaints') });
  return (
    <>
      <h1>Жалобы на оценки</h1>
      <div className="card"><Table rows={q.data} empty="Жалоб нет" cols={[
        { h: 'Оценка', c: (c) => <>{'★'.repeat(c.stars)}<div className="muted">{c.text ?? 'без текста'}</div></> }, { h: 'Жалоба', c: (c) => c.reason },
        { h: 'Когда', c: (c) => <DateTime v={c.created_at} /> },
        { h: '', c: (c) => <span className="row">
          <Action label="Скрыть оценку" tone="danger" path={`/admin/ratings/${c.rating_id}/hide`} prompt="Причина скрытия" invalidate={[['complaints'], ['dashboard']]} />
          <Action label="Оставить" path={`/admin/ratings/${c.rating_id}/show`} invalidate={[['complaints'], ['dashboard']]} /></span> },
      ]} /></div>
    </>
  );
}

export function BroadcastPage() {
  const [f, setF] = useState({ audience: 'all_customers', title: '', body: '' });
  const m = useMutation({ mutationFn: () => api<{ recipients: number }>('/admin/broadcasts', { method: 'POST', body: f }) });
  return (
    <>
      <h1>Рассылка уведомлений</h1>
      <div className="card" style={{ maxWidth: 640, display: 'grid', gap: 10 }}>
        <label className="field">Кому<select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="all_customers">Всем заказчикам</option><option value="all_partners">Всем партнёрам</option></select></label>
        <label className="field">Заголовок<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field">Текст<textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <button className="primary" disabled={!f.title || !f.body || m.isPending} onClick={() => { if (window.confirm('Отправить рассылку?')) m.mutate(); }}>Отправить</button>
        {m.data && <div className="ok">Отправлено получателям: {m.data.recipients}</div>}
        <ErrorBox error={m.error} />
      </div>
    </>
  );
}
