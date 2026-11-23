import { ORDER_STATUS_UI } from '@kovsh/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Action, DateTime, Money, OrderStatus, Status, Table } from '../components/ui';

interface OrderRow { id: string; number: number; status: string; category: string; siteAddress: string; customerPhone: string; partnerName: string | null; agentName: string | null; totalKopecks: number; firstStartAt: string; createdAt: string }

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['orders', status, q], queryFn: () => api<OrderRow[]>(`/admin/orders?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`) });
  return (
    <>
      <div className="spread">
        <h1>Заказы</h1>
        <div className="row">
          <input placeholder="№ заказа, телефон, компания" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
            <option value="">Все статусы</option>
            {Object.entries(ORDER_STATUS_UI).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </div>
      <div className="card">
        <Table rows={list.data} onRow={(o) => nav(`/orders/${o.id}`)} empty="Заказов нет" cols={[
          { h: '№', c: (o) => <b>{o.number}</b> },
          { h: 'Техника и объект', c: (o) => <>{o.category}<div className="muted">{o.siteAddress}</div></> },
          { h: 'Начало', c: (o) => <DateTime v={o.firstStartAt} /> },
          { h: 'Заказчик', c: (o) => <>{o.customerPhone}{o.agentName && <div className="muted">через {o.agentName}</div>}</> },
          { h: 'Исполнитель', c: (o) => o.partnerName ?? <span className="muted">—</span> },
          { h: 'Сумма', c: (o) => <Money k={o.totalKopecks} /> },
          { h: 'Статус', c: (o) => <OrderStatus s={o.status} /> },
        ]} />
      </div>
    </>
  );
}

interface Detail {
  id: string; number: number; status: string; category: string; urgency: string; totalHours: number;
  site: { address: string; comment: string | null; lat: number; lng: number };
  customer: { phone: string; full_name: string | null };
  partner: { name: string } | null; equipment: { brand: string; model: string; regNumber: string | null } | null;
  shifts: { seq: number; start: string; end: string; hours: number; status: string; operator: { fullName: string | null; rating: number | null } | null }[];
  history: { status: string; reason: string | null; actor: string; at: string; deviceRecordedAt: string | null }[];
  price: { rentKopecks: number; deliveryKopecks: number; deliveryKm: number; totalKopecks: number; discountKopecks: number; extraKopecks: number; payableKopecks: number; paidKopecks: number; refundedKopecks: number; payerKind: string | null };
  partnerPrice: { amountKopecks: number | null; deliveryKm: number | null; final: boolean };
  payments: { part: string; amount_kopecks: string; provider: string; status: string; created_at: string; paid_at: string | null }[];
  offers: { org_name: string; status: string; radius_km: number; distance_km: string; score: string; offered_at: string }[];
  cancellationReview: { status: string; decision: string | null } | null;
}
const SHIFT: Record<string, string> = { pending: 'Ожидает', en_route: 'Выехал', arrived: 'Прибыл', in_progress: 'Работает', finished: 'Завершил', cancelled: 'Отменена' };
const ACTOR: Record<string, string> = { customer: 'Заказчик', partner: 'Исполнитель', operator: 'Машинист', system: 'Система', admin: 'Администратор' };
const PART: Record<string, string> = { first: 'Первый платёж', final: 'Вторая часть', extra: 'Доп. часы' };

export function OrderPage({ role }: { role: string }) {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<Detail>(`/admin/orders/${id}`) });
  const [tab, setTab] = useState<'history' | 'offers' | 'chat' | 'gps' | 'ledger'>('history');
  if (!q.data) return <div className="empty">Загрузка…</div>;
  const o = q.data;
  return (
    <>
      <div className="spread">
        <h1>Заказ №{o.number} <OrderStatus s={o.status} /></h1>
        {o.cancellationReview && <Link to="/cancellations">Отмена: <Status s={o.cancellationReview.status} /></Link>}
      </div>
      {o.status === 'disputed' && ['superadmin', 'support'].includes(role) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Открыт спор</h3>
          <p className="muted">
            {o.history.filter((h) => h.status === 'disputed').at(-1)?.reason ?? 'Причина не указана'}. «Работа принята» — обычное завершение: начисления исполнителю,
            для юрлица — вторая часть оплаты. «Отменить» — заказ отменяется, сумму возврата решаете в разделе «Отмены и возвраты».
          </p>
          <div className="row">
            <Action label="Работа принята" path={`/admin/orders/${o.id}/dispute/resolve`} body={{ outcome: 'accept_work' }} prompt="Комментарий к решению (увидят в истории заказа)" invalidate={[['order', id]]} />
            <Action label="Отменить заказ" tone="danger" path={`/admin/orders/${o.id}/dispute/resolve`} body={{ outcome: 'cancel' }} prompt="Причина отмены" invalidate={[['order', id]]} />
          </div>
        </div>
      )}
      <div className="grid grid-2">
        <div className="card"><h2>Заказ</h2>
          <dl className="kv">
            <dt>Техника</dt><dd>{o.category}</dd>
            <dt>Объект</dt><dd>{o.site.address}{o.site.comment && <div className="muted">{o.site.comment}</div>}</dd>
            <dt>Тип</dt><dd>{o.urgency === 'urgent' ? 'Срочный' : 'Предварительный'} · {o.totalHours} ч</dd>
            <dt>Заказчик</dt><dd>{o.customer.full_name ?? '—'} · {o.customer.phone} · {o.price.payerKind === 'legal' ? 'юрлицо' : o.price.payerKind === 'individual' ? 'физлицо' : 'не выбран'}</dd>
            <dt>Исполнитель</dt><dd>{o.partner?.name ?? '—'}</dd>
            <dt>Техника исполнителя</dt><dd>{o.equipment ? `${o.equipment.brand} ${o.equipment.model} ${o.equipment.regNumber ?? ''}` : '—'}</dd>
          </dl>
          <h2 style={{ marginTop: 16 }}>Смены</h2>
          <Table rows={o.shifts} cols={[
            { h: '#', c: (s) => s.seq },
            { h: 'Время', c: (s) => <><DateTime v={s.start} /> · {s.hours} ч</> },
            { h: 'Машинист', c: (s) => s.operator ? <>{s.operator.fullName}{s.operator.rating ? ` ★ ${s.operator.rating}` : ''}</> : <span className="muted">не назначен</span> },
            { h: 'Статус', c: (s) => SHIFT[s.status] ?? s.status },
          ]} />
        </div>
        <div className="card"><h2>Деньги</h2>
          <dl className="kv">
            <dt>Аренда</dt><dd><Money k={o.price.rentKopecks} /></dd>
            <dt>Доставка заказчику</dt><dd><Money k={o.price.deliveryKopecks} /> · {o.price.deliveryKm} км</dd>
            <dt>Полная стоимость</dt><dd><b><Money k={o.price.totalKopecks} /></b></dd>
            {o.price.discountKopecks > 0 && <><dt>Скидка</dt><dd>−<Money k={o.price.discountKopecks} /></dd></>}
            {o.price.extraKopecks > 0 && <><dt>Доп. часы</dt><dd><Money k={o.price.extraKopecks} /></dd></>}
            <dt>К оплате</dt><dd><Money k={o.price.payableKopecks} /></dd>
            <dt>Оплачено / возвращено</dt><dd><Money k={o.price.paidKopecks} /> / <Money k={o.price.refundedKopecks} /></dd>
            <dt>Исполнителю</dt><dd><Money k={o.partnerPrice.amountKopecks} />{!o.partnerPrice.final && <span className="muted"> (предварительно)</span>}{o.partnerPrice.deliveryKm !== null && <div className="muted">фактическая доставка {o.partnerPrice.deliveryKm} км</div>}</dd>
          </dl>
          <h2 style={{ marginTop: 16 }}>Платежи</h2>
          <Table rows={o.payments} empty="Платежей нет" cols={[
            { h: 'Часть', c: (p) => PART[p.part] ?? p.part },
            { h: 'Сумма', c: (p) => <Money k={p.amount_kopecks} /> },
            { h: 'Способ', c: (p) => (p.provider === 'bank_transfer' ? 'По счёту' : p.provider === 'dev' ? 'Онлайн (тест)' : p.provider) },
            { h: 'Статус', c: (p) => <Status s={p.status} /> },
          ]} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="tabs">
          {([['history', 'История'], ['offers', 'Подбор'], ['chat', 'Переписка'], ['gps', 'GPS'], ['ledger', 'Проводки']] as const)
            .filter(([k]) => (k === 'ledger' ? ['superadmin', 'finance'].includes(role) : k === 'chat' || k === 'gps' ? ['superadmin', 'support'].includes(role) : true))
            .map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'history' && <ul className="timeline">{o.history.map((h, i) => (
          <li key={i}>{h.status.startsWith('shift:') ? <b>Машинист: {(SHIFT[h.status.slice(6)] ?? h.status.slice(6)).toLowerCase()}</b> : <OrderStatus s={h.status} />} <span className="muted">{ACTOR[h.actor]} · <DateTime v={h.at} />{h.deviceRecordedAt && <> · на телефоне <DateTime v={h.deviceRecordedAt} /></>}</span>
            {h.reason && <div>{h.reason}</div>}</li>))}</ul>}
        {tab === 'offers' && <Table rows={o.offers} empty="Предложений не было" cols={[
          { h: 'Компания', c: (f) => f.org_name }, { h: 'Радиус', c: (f) => `${f.radius_km} км` }, { h: 'Расстояние', c: (f) => `${f.distance_km} км` },
          { h: 'Балл', c: (f) => Number(f.score).toFixed(3) }, { h: 'Результат', c: (f) => f.status }, { h: 'Когда', c: (f) => <DateTime v={f.offered_at} /> },
        ]} />}
        {tab === 'chat' && <OrderChat id={o.id} />}
        {tab === 'gps' && <OrderGps id={o.id} />}
        {tab === 'ledger' && <OrderLedger id={o.id} />}
      </div>
    </>
  );
}

function OrderChat({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['order-chat', id], queryFn: () => api<{ channel: string; sender_role: string; sender_name: string | null; body: string; created_at: string }[]>(`/admin/orders/${id}/chat`) });
  return <>
    <p className="muted">Просмотр переписки записывается в журнал действий (В-27).</p>
    {q.data?.length ? q.data.map((m, i) => <div key={i} className="chat-msg"><b>{m.sender_name ?? m.sender_role}</b> <span className="muted">· {m.channel === 'internal' ? 'внутренний' : 'заказ'} · <DateTime v={m.created_at} /></span><div>{m.body}</div></div>) : <div className="empty">Сообщений нет</div>}
  </>;
}

function OrderGps({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['order-gps', id], queryFn: () => api<{ current: { mode: string }; track: { lat: number; lng: number; phase: string; recorded_at: string; accuracy_m: number | null }[] }>(`/admin/orders/${id}/tracking`) });
  if (!q.data) return <div className="empty">Загрузка…</div>;
  return <>
    <p>Режим для заказчика: <b>{q.data.current.mode}</b>. Точек трека: {q.data.track.length} (хранятся 48 часов после завершения).</p>
    <Table rows={q.data.track.slice(-50)} empty="Координат нет" cols={[
      { h: 'Время', c: (p) => <DateTime v={p.recorded_at} /> }, { h: 'Точка', c: (p) => `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}` },
      { h: 'Точность', c: (p) => (p.accuracy_m ? `${Math.round(p.accuracy_m)} м` : '—') }, { h: 'Фаза', c: (p) => (p.phase === 'en_route' ? 'в пути' : 'на объекте') },
    ]} />
  </>;
}

function OrderLedger({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['order-ledger', id], queryFn: () => api<{ kind: string; account: string; amount_kopecks: string; created_at: string }[]>(`/admin/orders/${id}/ledger`) });
  return <Table rows={q.data} empty="Проводок нет" cols={[
    { h: 'Операция', c: (e) => e.kind }, { h: 'Счёт', c: (e) => <span className="mono">{e.account}</span> },
    { h: 'Дебет', c: (e) => (Number(e.amount_kopecks) > 0 ? <Money k={e.amount_kopecks} /> : '') },
    { h: 'Кредит', c: (e) => (Number(e.amount_kopecks) < 0 ? <Money k={-Number(e.amount_kopecks)} /> : '') },
    { h: 'Когда', c: (e) => <DateTime v={e.created_at} /> },
  ]} />;
}
