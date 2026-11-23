import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Action, DateTime, ErrorBox, Money, Status, Table } from '../components/ui';

interface Review { order_id: string; number: string; status: string; initiated_by: string; reason: string | null; paid_kopecks: string; decision: string | null; retained_kopecks: string | null; refund_kopecks: string | null; decision_reason: string | null; via_agent: boolean; created_at: string }
const BY: Record<string, string> = { customer: 'Заказчик', partner: 'Исполнитель', system: 'Система', admin: 'Администратор' };

/** Отмены после оплаты — решение поддержки (07): полный, частичный возврат или полное удержание; крупный возврат подтверждает финансист (К-14). */
export function CancellationsPage({ role }: { role: string }) {
  const [status, setStatus] = useState('pending');
  const q = useQuery({ queryKey: ['reviews', status], queryFn: () => api<Review[]>(`/admin/cancellation-reviews?status=${status}`) });
  return (
    <>
      <h1>Отмены и возвраты</h1>
      <div className="tabs">{[['pending', 'Ждут решения'], ['awaiting_approval', 'Ждут подтверждения'], ['decided', 'Решены']].map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k as string)}>{l}</button>)}</div>
      <FailedRefunds />
      <div className="grid">{q.data?.length === 0 && <div className="card empty">Пусто</div>}
        {q.data?.map((r) => <ReviewCard key={r.order_id} r={r} role={role} />)}</div>
    </>
  );
}

function ReviewCard({ r, role }: { r: Review; role: string }) {
  const qc = useQueryClient();
  const paid = Number(r.paid_kopecks);
  const [retain, setRetain] = useState('0');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/admin/cancellation-reviews/${r.order_id}/decide`, { method: 'POST', body: { retainedKopecks: Math.round(Number(retain.replace(',', '.')) * 100), reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reviews'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); },
  });
  const inv = [['reviews'], ['dashboard']];
  return (
    <div className="card">
      <div className="spread"><h2><Link to={`/orders/${r.order_id}`}>Заказ №{r.number}</Link> <Status s={r.status} /></h2><span className="muted"><DateTime v={r.created_at} /></span></div>
      <dl className="kv">
        <dt>Кто отменил</dt><dd>{BY[r.initiated_by]}{r.reason ? ` — ${r.reason}` : ''}</dd>
        <dt>Оплачено</dt><dd><Money k={paid} /></dd>
        <dt>Распределение удержанного</dt><dd>исполнителю 88%, {r.via_agent ? 'диспетчеру 7%, платформе 5%' : 'платформе 12%'} (Ф-3)</dd>
        {r.decision && <><dt>Решение</dt><dd>удержать <Money k={r.retained_kopecks} />, вернуть <Money k={r.refund_kopecks} />{r.decision_reason ? ` — ${r.decision_reason}` : ''}</dd></>}
      </dl>
      {r.status === 'pending' && ['superadmin', 'support'].includes(role) && (
        <div className="row" style={{ marginTop: 12 }}>
          <label className="field">Удержать, ₽<input value={retain} onChange={(e) => setRetain(e.target.value)} inputMode="decimal" /></label>
          <button onClick={() => setRetain('0')}>Полный возврат</button>
          <button onClick={() => setRetain(String(paid / 100))}>Удержать всё</button>
          <label className="field" style={{ flex: 1 }}>Причина решения<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="primary" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>Принять решение</button>
          <ErrorBox error={m.error} />
        </div>
      )}
      {r.status === 'awaiting_approval' && ['superadmin', 'finance'].includes(role) && (
        <div className="row" style={{ marginTop: 12 }}>
          <Action label="Подтвердить возврат" tone="primary" path={`/admin/cancellation-reviews/${r.order_id}/approve`} invalidate={inv} />
          <Action label="Вернуть на пересмотр" path={`/admin/cancellation-reviews/${r.order_id}/reject`} prompt="Почему не подтверждаете?" invalidate={inv} />
        </div>
      )}
    </div>
  );
}

export function FinancePage({ role }: { role: string }) {
  const [tab, setTab] = useState<'summary' | 'payouts' | 'invoices' | 'debts' | 'payments'>(role === 'support' ? 'debts' : 'summary');
  const tabs = ([['summary', 'Сводка'], ['payouts', 'Выплаты'], ['invoices', 'Счета'], ['debts', 'Долги'], ['payments', 'Платежи']] as const)
    .filter(([k]) => role !== 'support' || k === 'debts' || k === 'payments');
  return (
    <>
      <h1>Финансы</h1>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="card">
        {tab === 'summary' && <Summary />}
        {tab === 'payouts' && <Payouts />}
        {tab === 'invoices' && <Invoices />}
        {tab === 'debts' && <Debts />}
        {tab === 'payments' && <Payments />}
      </div>
    </>
  );
}

const ACCOUNT: Record<string, string> = {
  'platform:commission': 'Комиссия платформы', 'platform:delivery_subsidy': 'Компенсация доставки (расход)', 'platform:delivery_savings': 'Экономия на доставке',
  'platform:promo': 'Скидки по промокодам (расход)', customer: 'Расчёты с заказчиками', partner: 'Долг перед исполнителями', agent: 'Долг перед диспетчерами',
  'cash:dev': 'Деньги: онлайн (тест)', 'cash:bank_transfer': 'Деньги: по счетам',
};
function Summary() {
  const q = useQuery({ queryKey: ['fin-summary'], queryFn: () => api<{ account: string; balanceKopecks: number }[]>('/admin/finance/summary') });
  return <>
    <p className="muted">Остатки по счетам журнала двойной записи. Дебет — плюс, кредит — минус; сумма по всем счетам всегда равна нулю.</p>
    <Table rows={q.data} empty="Операций ещё не было" cols={[{ h: 'Счёт', c: (r) => ACCOUNT[r.account] ?? r.account }, { h: 'Остаток', c: (r) => <Money k={r.balanceKopecks} /> }]} />
  </>;
}
function Payouts() {
  const q = useQuery({ queryKey: ['payouts'], queryFn: () => api<{ id: string; org_name: string; kind: string; payout_date: string; amount_kopecks: string; status: string; status_reason: string | null; paid_at: string | null }[]>('/admin/payouts') });
  return <>
    <div className="spread"><p className="muted">Выплаты — на следующий день после завершения заказа (Н-10), по каждому заказу один раз.</p>
      <Action label="Запустить выплаты сейчас" path="/admin/payouts/run" confirm="Запустить выплаты по созревшим начислениям?" invalidate={[['payouts'], ['fin-summary']]} /></div>
    <Table rows={q.data} empty="Выплат ещё не было" cols={[
      { h: 'Получатель', c: (p) => <>{p.org_name}<div className="muted">{p.kind === 'agent' ? 'Независимый диспетчер' : 'Исполнитель'}</div></> },
      { h: 'Дата', c: (p) => p.payout_date?.slice(0, 10) }, { h: 'Сумма', c: (p) => <Money k={p.amount_kopecks} /> }, { h: 'Статус', c: (p) => <><Status s={p.status} />{p.status_reason ? <div className="muted">{p.status_reason}</div> : null}</> },
      { h: '', c: (p) => (p.status === 'failed' ? <Action label="Повторить" path={`/admin/payouts/${p.id}/retry`} confirm="Повторить выплату по текущим реквизитам компании?" invalidate={[['payouts'], ['fin-summary']]} /> : null) },
    ]} />
  </>;
}
function Invoices() {
  const q = useQuery({ queryKey: ['invoices'], queryFn: () => api<{ id: string; number: string; part: string; amount_kopecks: string; status: string; due_at: string; buyer: { name: string; inn: string } }[]>('/admin/invoices') });
  return <Table rows={q.data} empty="Счетов нет" cols={[
    { h: '№', c: (i) => i.number }, { h: 'Плательщик', c: (i) => <>{i.buyer?.name}<div className="muted">ИНН {i.buyer?.inn}</div></> },
    { h: 'Часть', c: (i) => (i.part === 'first' ? 'Первая' : 'Вторая') }, { h: 'Сумма', c: (i) => <Money k={i.amount_kopecks} /> },
    { h: 'Срок', c: (i) => <DateTime v={i.due_at} /> }, { h: 'Статус', c: (i) => <Status s={i.status} /> },
    { h: '', c: (i) => (i.status === 'issued' ? <Action label="Деньги поступили" tone="primary" path={`/admin/invoices/${i.id}/mark-paid`} confirm={`Отметить счёт №${i.number} оплаченным?`} invalidate={[['invoices']]} /> : null) },
  ]} />;
}
function Debts() {
  const q = useQuery({ queryKey: ['debts'], queryFn: () => api<{ order_id: string; amount_kopecks: string; status: string; inn: string | null; created_at: string }[]>('/admin/debts') });
  return <Table rows={q.data} empty="Долгов нет" cols={[
    { h: 'Заказ', c: (d) => <Link to={`/orders/${d.order_id}`}>открыть</Link> }, { h: 'Сумма', c: (d) => <Money k={d.amount_kopecks} /> },
    { h: 'ИНН', c: (d) => d.inn ?? 'физлицо' }, { h: 'Возник', c: (d) => <DateTime v={d.created_at} /> }, { h: 'Статус', c: (d) => <Status s={d.status} /> },
  ]} />;
}
function Payments() {
  const q = useQuery({ queryKey: ['payments'], queryFn: () => api<{ order_id: string; part: string; amount_kopecks: string; provider: string; status: string; created_at: string }[]>('/admin/payments') });
  return <Table rows={q.data} empty="Платежей нет" cols={[
    { h: 'Заказ', c: (p) => <Link to={`/orders/${p.order_id}`}>открыть</Link> }, { h: 'Часть', c: (p) => p.part }, { h: 'Сумма', c: (p) => <Money k={p.amount_kopecks} /> },
    { h: 'Способ', c: (p) => p.provider }, { h: 'Статус', c: (p) => <Status s={p.status} /> }, { h: 'Создан', c: (p) => <DateTime v={p.created_at} /> },
  ]} />;
}

/** Возвраты, которые платёжный провайдер отклонил: деньги заказчику не ушли, нужен повтор. */
function FailedRefunds() {
  const q = useQuery({ queryKey: ['refunds-failed'], queryFn: () => api<{ id: string; number: string; amount_kopecks: string; reason: string | null; created_at: string }[]>('/admin/refunds/failed') });
  if (!q.data?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger)' }}>
      <h3>Возвраты не прошли у платёжного провайдера</h3>
      <Table rows={q.data} cols={[
        { h: 'Заказ', c: (r) => <>№{r.number}</> }, { h: 'Сумма', c: (r) => <Money k={r.amount_kopecks} /> }, { h: 'Основание', c: (r) => r.reason ?? '' },
        { h: '', c: (r) => <Action label="Повторить возврат" path={`/admin/refunds/${r.id}/retry`} confirm="Отправить возврат провайдеру повторно?" invalidate={[['refunds-failed'], ['reviews']]} /> },
      ]} />
    </div>
  );
}
