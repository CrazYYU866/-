import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Action, DateTime, FileLink, Status, Table } from '../components/ui';

interface Org { id: string; name: string; inn: string; ogrn: string; kind: string; legalForm: string; status: string; createdAt: string; submittedAt: string | null }
const TABS: [string, string][] = [['pending_review', 'На проверке'], ['verified', 'Подтверждены'], ['rejected', 'Отклонены'], ['blocked', 'Заблокированы'], ['draft', 'Черновики'], ['', 'Все']];
const FORM: Record<string, string> = { ip: 'ИП', llc: 'ООО', jsc: 'АО', other_legal_entity: 'Юрлицо' };

export function OrganizationsPage() {
  const [status, setStatus] = useState('pending_review');
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const list = useQuery({
    queryKey: ['orgs', status, q],
    queryFn: () => api<Org[]>(`/admin/organizations?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`),
  });
  return (
    <>
      <div className="spread"><h1>Компании и ИП</h1><input placeholder="Название или ИНН" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      <div className="card">
        <Table rows={list.data} onRow={(o) => nav(`/organizations/${o.id}`)} empty="Нет компаний" cols={[
          { h: 'Название', c: (o) => <><b>{o.name}</b><div className="muted">{FORM[o.legalForm]} · {o.kind === 'agent' ? 'Независимый диспетчер' : 'Исполнитель'}</div></> },
          { h: 'ИНН / ОГРН', c: (o) => <>{o.inn}<div className="muted">{o.ogrn}</div></> },
          { h: 'Статус', c: (o) => <Status s={o.status} /> },
          { h: 'Отправлена', c: (o) => <DateTime v={o.submittedAt} /> },
        ]} />
      </div>
    </>
  );
}

interface Card {
  organization: Org & { representativeName: string; legalAddress: string; email: string; contactPhone: string; rejectionReason: string | null; blockedReason: string | null; kpp: string | null };
  members: { id: string; fullName: string | null; phone: string; role: string; status: string; canOperate: boolean; operatorVerification: string }[];
  documents: { code: string; title: string; required: boolean; status: string }[];
  documentFiles: { id: string; typeCode: string; typeTitle: string; fileId: string; status: string; reviewComment: string | null }[];
  history: { toStatus: string; reason: string | null; createdAt: string }[];
}
const ROLE: Record<string, string> = { owner: 'Главный владелец', manager: 'Руководитель', dispatcher: 'Диспетчер', operator: 'Машинист' };

export function OrganizationPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['org', id], queryFn: () => api<Card>(`/admin/organizations/${id}`) });
  const inv = [['org', id ?? ''], ['orgs'], ['dashboard']];
  if (!q.data) return <div className="empty">Загрузка…</div>;
  const { organization: o, members, documents, documentFiles, history } = q.data;
  return (
    <>
      <div className="spread">
        <h1>{o.name} <Status s={o.status} /></h1>
        <div className="row">
          {o.status === 'pending_review' && <>
            <Action label="Подтвердить" tone="primary" path={`/admin/organizations/${o.id}/approve`} invalidate={inv} />
            <Action label="Отклонить" path={`/admin/organizations/${o.id}/reject`} prompt="Причина отклонения (её увидит компания)" invalidate={inv} />
          </>}
          {o.status !== 'blocked'
            ? <Action label="Заблокировать" tone="danger" path={`/admin/organizations/${o.id}/block`} prompt="Причина блокировки" invalidate={inv} />
            : <Action label="Разблокировать" path={`/admin/organizations/${o.id}/unblock`} invalidate={inv} />}
        </div>
      </div>
      {o.rejectionReason && <div className="error">Причина отклонения: {o.rejectionReason}</div>}
      <div className="grid grid-2" style={{ marginTop: 12 }}>
        <div className="card"><h2>Реквизиты</h2>
          <dl className="kv">
            <dt>Форма</dt><dd>{FORM[o.legalForm]}</dd><dt>ИНН</dt><dd>{o.inn}</dd><dt>ОГРН / ОГРНИП</dt><dd>{o.ogrn}</dd><dt>КПП</dt><dd>{o.kpp ?? '—'}</dd>
            <dt>Представитель</dt><dd>{o.representativeName}</dd><dt>Адрес</dt><dd>{o.legalAddress}</dd><dt>Email</dt><dd>{o.email}</dd><dt>Телефон</dt><dd>{o.contactPhone}</dd>
          </dl>
        </div>
        <div className="card"><h2>Документы</h2>
          <Table rows={documents} cols={[
            { h: 'Документ', c: (d) => <>{d.title}{d.required ? '' : <span className="muted"> (необязательный)</span>}</> },
            { h: 'Статус', c: (d) => <Status s={d.status} /> },
            { h: '', c: (d) => {
              const f = documentFiles.find((x) => x.typeCode === d.code);
              if (!f) return null;
              return <span className="row"><FileLink fileId={f.fileId} />
                {f.status === 'uploaded' && <>
                  <Action label="Одобрить" tone="primary" path={`/admin/documents/${f.id}/approve`} invalidate={inv} />
                  <Action label="Отклонить" path={`/admin/documents/${f.id}/reject`} prompt="Причина" invalidate={inv} />
                </>}</span>;
            } },
          ]} />
        </div>
        <div className="card"><h2>Сотрудники</h2>
          <Table rows={members} cols={[
            { h: 'Сотрудник', c: (m) => <>{m.fullName ?? '—'}<div className="muted">{m.phone}</div></> },
            { h: 'Роль', c: (m) => <>{ROLE[m.role]}{m.canOperate && m.role !== 'operator' ? ' · машинист' : ''}</> },
            { h: 'Проверка машиниста', c: (m) => (m.canOperate ? <Status s={m.operatorVerification === 'not_submitted' ? 'missing' : m.operatorVerification} /> : '—') },
          ]} />
        </div>
        <div className="card"><h2>История статусов</h2>
          <ul className="timeline">{history.map((h, i) => <li key={i}><Status s={h.toStatus} /> <DateTime v={h.createdAt} />{h.reason && <div className="muted">{h.reason}</div>}</li>)}</ul>
        </div>
      </div>
    </>
  );
}
