import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';

const STATS: { key: string; label: string; to: string; alert?: boolean }[] = [
  { key: 'orders_active', label: 'Заказы в работе', to: '/orders' },
  { key: 'orders_searching', label: 'Идёт поиск исполнителя', to: '/orders?status=searching' },
  { key: 'orders_today', label: 'Заказов за сутки', to: '/orders' },
  { key: 'units_online', label: 'Техники на линии', to: '/equipment' },
  { key: 'orgs_pending', label: 'Компании на проверке', to: '/organizations', alert: true },
  { key: 'documents_pending', label: 'Документы на проверке', to: '/documents', alert: true },
  { key: 'equipment_pending', label: 'Техника на проверке', to: '/equipment', alert: true },
  { key: 'cancellations_pending', label: 'Отмены ждут решения', to: '/cancellations', alert: true },
  { key: 'refunds_awaiting_approval', label: 'Возвраты ждут подтверждения', to: '/cancellations', alert: true },
  { key: 'disputes_open', label: 'Открытые споры', to: '/orders?status=disputed', alert: true },
  { key: 'debts_open', label: 'Открытые долги', to: '/finance', alert: true },
  { key: 'rating_complaints_open', label: 'Жалобы на оценки', to: '/ratings', alert: true },
];

export function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Record<string, number>>('/admin/dashboard') });
  return (
    <>
      <h1>Сводка</h1>
      <div className="grid grid-4">
        {STATS.map((s) => {
          const v = q.data?.[s.key] ?? 0;
          return (
            <Link key={s.key} to={s.to} className={`card stat ${s.alert && v > 0 ? 'alert' : ''}`} style={{ textDecoration: 'none' }}>
              <div className="value">{q.data ? v : '…'}</div>
              <div className="label">{s.label}</div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
