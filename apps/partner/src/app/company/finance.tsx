import { api, Card, dateTime, Divider, Loading, Row, rub, Screen, Section, T } from '@kovsh/mobile';
import { useQuery } from '@tanstack/react-query';
import { useOrg } from '../../lib/org';

interface Summary { accruedKopecks: number; paidOutKopecks: number; balanceKopecks: number }
interface Accrual { kind: string; order_id: string; number: string; amount_kopecks: string; created_at: string }
interface Payout { id: string; payout_date: string; amount_kopecks: string; status: string }
const PAYOUT = { processing: 'В обработке', paid: 'Выплачено', failed: 'Ошибка', blocked: 'Приостановлена' } as Record<string, string>;
const KIND = { order_settled: 'Заказ', cancellation_retained: 'Отмена (удержание)' } as Record<string, string>;

/** Финансы компании видят только руководители (Н-22). */
export default function Finance() {
  const { current } = useOrg();
  const sum = useQuery({ queryKey: ['fin', current?.orgId], queryFn: () => api<Summary>('/partner/finance/summary') });
  const acc = useQuery({ queryKey: ['fin', current?.orgId, 'acc'], queryFn: () => api<Accrual[]>('/partner/finance/accruals') });
  const pay = useQuery({ queryKey: ['fin', current?.orgId, 'pay'], queryFn: () => api<Payout[]>('/partner/finance/payouts') });
  if (sum.isLoading) return <Loading />;
  return (
    <Screen>
      {sum.data ? (
        <Card accent>
          <T v="small" muted>К выплате</T>
          <T v="title">{rub(sum.data.balanceKopecks)}</T>
          <Divider />
          <Row label="Начислено всего" value={rub(sum.data.accruedKopecks)} />
          <Row label="Выплачено" value={rub(sum.data.paidOutKopecks)} />
          <T v="small" muted>Выплата — на следующий день после завершения заказа, на счёт из «Реквизитов для выплат».</T>
        </Card>
      ) : null}
      <Section title="Выплаты">
        <Card>
          {pay.data?.length ? pay.data.map((p) => <Row key={p.id} label={`${new Date(p.payout_date).toLocaleDateString('ru-RU')} · ${PAYOUT[p.status] ?? p.status}`} value={rub(Number(p.amount_kopecks))} />) : <T muted>Выплат пока не было</T>}
        </Card>
      </Section>
      <Section title="Начисления">
        <Card>
          {acc.data?.length ? acc.data.map((a, i) => <Row key={i} label={`${KIND[a.kind] ?? a.kind} №${a.number} · ${dateTime(a.created_at)}`} value={rub(Number(a.amount_kopecks))} />) : <T muted>Начислений пока нет</T>}
        </Card>
      </Section>
    </Screen>
  );
}
