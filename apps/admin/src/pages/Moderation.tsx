import { formatRub } from '@kovsh/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Action, Badge, DateTime, FileLink, Status, Table } from '../components/ui';

interface Doc { id: string; ownerType: string; ownerId: string; fileId: string; status: string; typeTitle: string; createdAt: string }
const OWNER: Record<string, string> = { organization: 'Компания', equipment: 'Техника', operator: 'Машинист' };

export function DocumentsPage() {
  const [status, setStatus] = useState<'uploaded' | 'approved' | 'rejected'>('uploaded');
  const q = useQuery({ queryKey: ['documents', status], queryFn: () => api<Doc[]>(`/admin/documents?status=${status}`) });
  const inv = [['documents'], ['dashboard']];
  return (
    <>
      <h1>Проверка документов</h1>
      <div className="tabs">{([['uploaded', 'Ждут проверки'], ['approved', 'Одобрены'], ['rejected', 'Отклонены']] as const).map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      <div className="card">
        <Table rows={q.data} empty="Очередь пуста" cols={[
          { h: 'Документ', c: (d) => <><b>{d.typeTitle}</b><div className="muted">{OWNER[d.ownerType]}</div></> },
          { h: 'Загружен', c: (d) => <DateTime v={d.createdAt} /> },
          { h: 'Статус', c: (d) => <Status s={d.status} /> },
          { h: '', c: (d) => <span className="row"><FileLink fileId={d.fileId} />
            {d.status === 'uploaded' && <>
              <Action label="Одобрить" tone="primary" path={`/admin/documents/${d.id}/approve`} invalidate={inv} />
              <Action label="Отклонить" path={`/admin/documents/${d.id}/reject`} prompt="Причина отклонения" invalidate={inv} />
            </>}</span> },
        ]} />
      </div>
    </>
  );
}

interface Unit {
  id: string; categoryName: string; brand: string; model: string; year: number | null; regNumber: string | null; verificationStatus: string;
  isOnline: boolean; workRadiusKm: number; allowBeyondRadius: boolean; base: { address: string; lat: number; lng: number }; attributes: Record<string, unknown>;
  photos: { fileId: string }[]; documents?: { code: string; title: string; required: boolean; status: string }[]; rejectionReason: string | null;
  schedule: { weekday: number; start: string; end: string }[];
}

export function EquipmentPage() {
  const [status, setStatus] = useState('pending');
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['equipment', status], queryFn: () => api<Unit[]>(`/admin/equipment?status=${status}`) });
  return (
    <>
      <h1>Проверка техники</h1>
      <div className="tabs">{[['pending', 'На проверке'], ['approved', 'Одобрена'], ['rejected', 'Отклонена'], ['draft', 'Черновики']].map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k as string)}>{l}</button>)}</div>
      <div className="card">
        <Table rows={q.data} onRow={(u) => nav(`/equipment/${u.id}`)} empty="Нет техники" cols={[
          { h: 'Техника', c: (u) => <><b>{u.brand} {u.model}</b><div className="muted">{u.categoryName}</div></> },
          { h: 'Госномер', c: (u) => u.regNumber ?? '—' },
          { h: 'База', c: (u) => <>{u.base.address}<div className="muted">радиус {u.workRadiusKm} км{u.allowBeyondRadius ? ', выезжает дальше' : ''}</div></> },
          { h: 'Статус', c: (u) => <><Status s={u.verificationStatus} /> {u.isOnline && <Badge tone="success">На линии</Badge>}</> },
        ]} />
      </div>
    </>
  );
}

const WD = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export function EquipmentCardPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['unit', id], queryFn: () => api<{ unit: Unit; documentFiles: Doc[] & { typeCode?: string }[] }>(`/admin/equipment/${id}`) });
  const inv = [['unit', id ?? ''], ['equipment'], ['dashboard']];
  if (!q.data) return <div className="empty">Загрузка…</div>;
  const { unit: u, documentFiles } = q.data;
  return (
    <>
      <div className="spread">
        <h1>{u.brand} {u.model} <Status s={u.verificationStatus} /></h1>
        <div className="row">
          {u.verificationStatus === 'pending' && <>
            <Action label="Одобрить" tone="primary" path={`/admin/equipment/${u.id}/approve`} invalidate={inv} />
            <Action label="Отклонить" path={`/admin/equipment/${u.id}/reject`} prompt="Причина отклонения" invalidate={inv} />
          </>}
          {u.isOnline && <Action label="Снять с линии" tone="danger" path={`/admin/equipment/${u.id}/force-offline`} confirm="Снять технику с линии?" invalidate={inv} />}
        </div>
      </div>
      <div className="grid grid-2">
        <div className="card"><h2>Карточка</h2>
          <dl className="kv">
            <dt>Вид</dt><dd>{u.categoryName}</dd><dt>Год</dt><dd>{u.year ?? '—'}</dd><dt>Госномер</dt><dd>{u.regNumber ?? '—'}</dd>
            <dt>База</dt><dd>{u.base.address}</dd><dt>Рабочий радиус</dt><dd>{u.workRadiusKm} км{u.allowBeyondRadius ? ' · выезжает дальше' : ''}</dd>
            {Object.entries(u.attributes).map(([k, v]) => <><dt key={k}>{k}</dt><dd key={`${k}v`}>{String(v)}</dd></>)}
          </dl>
        </div>
        <div className="card"><h2>Документы</h2>
          <Table rows={u.documents} cols={[
            { h: 'Документ', c: (d) => <>{d.title}{d.required ? '' : <span className="muted"> (необязательный)</span>}</> },
            { h: 'Статус', c: (d) => <Status s={d.status} /> },
            { h: '', c: (d) => {
              const f = (documentFiles as unknown as { id: string; typeCode: string; fileId: string; status: string }[]).find((x) => x.typeCode === d.code);
              return f ? <span className="row"><FileLink fileId={f.fileId} />{f.status === 'uploaded' && <Action label="Одобрить" tone="primary" path={`/admin/documents/${f.id}/approve`} invalidate={inv} />}</span> : null;
            } },
          ]} />
          <h2 style={{ marginTop: 16 }}>Фото</h2>
          <div className="row">{u.photos.length ? u.photos.map((p) => <FileLink key={p.fileId} fileId={p.fileId} label="Фото" />) : <span className="muted">Нет фото</span>}</div>
          <h2 style={{ marginTop: 16 }}>Расписание</h2>
          {u.schedule.length ? u.schedule.map((s, i) => <div key={i}>{WD[s.weekday]} {s.start}–{s.end}</div>) : <span className="muted">Не задано — доступна круглосуточно (С-18)</span>}
        </div>
      </div>
      <p className="muted">{formatRub(null) === '—' ? '' : ''}</p>
    </>
  );
}
