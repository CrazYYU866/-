import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api, loadSession, onSession, saveSession, type Session } from './api';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { OrganizationPage, OrganizationsPage } from './pages/Organizations';
import { DocumentsPage, EquipmentCardPage, EquipmentPage } from './pages/Moderation';
import { OrderPage, OrdersPage } from './pages/Orders';
import { CancellationsPage, FinancePage } from './pages/Finance';
import { CatalogPage, RegionsPage, TariffsPage } from './pages/Catalog';
import { AdminsPage, AuditPage, BroadcastPage, PromoPage, RatingComplaintsPage, SettingsPage, UsersPage } from './pages/System';
import './styles.css';

type Role = Session['admin']['role'];
const NAV: { group: string; items: { to: string; label: string; roles?: Role[]; count?: string }[] }[] = [
  { group: 'Работа', items: [
    { to: '/', label: 'Сводка' },
    { to: '/orders', label: 'Заказы' },
    { to: '/cancellations', label: 'Отмены и возвраты', roles: ['superadmin', 'support', 'finance'], count: 'cancellations_pending' },
  ] },
  { group: 'Проверка', items: [
    { to: '/organizations', label: 'Компании', count: 'orgs_pending' },
    { to: '/documents', label: 'Документы', roles: ['superadmin', 'moderator'], count: 'documents_pending' },
    { to: '/equipment', label: 'Техника', count: 'equipment_pending' },
    { to: '/ratings', label: 'Жалобы на оценки', roles: ['superadmin', 'support', 'moderator'], count: 'rating_complaints_open' },
  ] },
  { group: 'Деньги', items: [{ to: '/finance', label: 'Финансы', roles: ['superadmin', 'finance', 'support'] }] },
  { group: 'Справочники', items: [
    { to: '/catalog', label: 'Каталог техники' },
    { to: '/tariffs', label: 'Тарифы' },
    { to: '/regions', label: 'Регионы' },
    { to: '/promo', label: 'Промокоды' },
  ] },
  { group: 'Система', items: [
    { to: '/users', label: 'Пользователи', roles: ['superadmin', 'support'] },
    { to: '/broadcast', label: 'Рассылка', roles: ['superadmin', 'support'] },
    { to: '/settings', label: 'Настройки', roles: ['superadmin', 'finance'] },
    { to: '/admins', label: 'Администраторы', roles: ['superadmin'] },
    { to: '/audit', label: 'Журнал действий', roles: ['superadmin'] },
  ] },
];

const ROLE_LABEL: Record<Role, string> = { superadmin: 'Суперадминистратор', support: 'Поддержка', finance: 'Финансист', moderator: 'Модератор' };

function Shell({ session, children }: { session: Session; children: ReactNode }) {
  const counts = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Record<string, number>>('/admin/dashboard'), refetchInterval: 30_000 });
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">К</span>Ковш на Час</div>
        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.roles || i.roles.includes(session.admin.role));
            if (!items.length) return null;
            return (
              <div key={g.group}>
                <div className="nav-group">{g.group}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'}>
                    <span>{i.label}</span>
                    {i.count && counts.data?.[i.count] ? <span className="count">{counts.data[i.count]}</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        <div className="topbar">
          <span>{ROLE_LABEL[session.admin.role]}</span>
          <span className="row">{session.admin.fullName}
            <button className="ghost" onClick={() => { void api('/admin/auth/logout', { method: 'POST' }).catch(() => undefined); saveSession(null); }}>Выйти</button>
          </span>
        </div>
        {children}
      </main>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  useEffect(() => { const off = onSession(setSession); return () => { off(); }; }, []);
  if (!session || session.mustEnrollTotp) return <LoginPage />;
  return (
    <Shell session={session}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/orders/:id" element={<OrderPage role={session.admin.role} />} />
        <Route path="/cancellations" element={<CancellationsPage role={session.admin.role} />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
        <Route path="/organizations/:id" element={<OrganizationPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/equipment" element={<EquipmentPage />} />
        <Route path="/equipment/:id" element={<EquipmentCardPage />} />
        <Route path="/ratings" element={<RatingComplaintsPage />} />
        <Route path="/finance" element={<FinancePage role={session.admin.role} />} />
        <Route path="/catalog" element={<CatalogPage role={session.admin.role} />} />
        <Route path="/tariffs" element={<TariffsPage role={session.admin.role} />} />
        <Route path="/regions" element={<RegionsPage role={session.admin.role} />} />
        <Route path="/promo" element={<PromoPage role={session.admin.role} />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/broadcast" element={<BroadcastPage />} />
        <Route path="/settings" element={<SettingsPage role={session.admin.role} />} />
        <Route path="/admins" element={<AdminsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Shell>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
