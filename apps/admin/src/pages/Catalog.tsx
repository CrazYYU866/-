import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Action, Badge, DateTime, ErrorBox, Money, Table } from '../components/ui';

interface Attr { id: string; key: string; label: string; type: string; unit: { label: string } | null; required: boolean; filterable: boolean; inherited: boolean; options: string[] | null }
interface Node { id: string; slug: string; name: string; isLeaf: boolean; archived: boolean; visibleToCustomers: boolean; visibleToPartners: boolean; yearRequired: boolean; attributes: Attr[]; children: Node[] }
const TYPE: Record<string, string> = { number: 'число', integer: 'целое', boolean: 'да/нет', text: 'текст', enum: 'список', multi_enum: 'несколько из списка' };

export function CatalogPage({ role }: { role: string }) {
  const q = useQuery({ queryKey: ['catalog'], queryFn: () => api<Node[]>('/admin/catalog/categories') });
  const [selected, setSelected] = useState<Node | null>(null);
  const can = role === 'superadmin';
  const find = (nodes: Node[] | undefined, id: string): Node | null => {
    for (const n of nodes ?? []) { if (n.id === id) return n; const c = find(n.children, id); if (c) return c; }
    return null;
  };
  const current = selected ? find(q.data, selected.id) : null;
  const render = (nodes: Node[], depth = 0) => nodes.map((n) => (
    <div key={n.id}>
      <div className="row" style={{ paddingLeft: depth * 18, padding: '5px 0 5px ' + depth * 18 + 'px', cursor: 'pointer', opacity: n.archived ? 0.5 : 1, fontWeight: current?.id === n.id ? 700 : 400 }} onClick={() => setSelected(n)}>
        {n.isLeaf ? '•' : '▸'} {n.name} {n.archived && <Badge tone="neutral">архив</Badge>} {!n.visibleToCustomers && !n.archived && <Badge tone="warning">скрыта от заказчиков</Badge>}
      </div>
      {render(n.children, depth + 1)}
    </div>
  ));
  return (
    <>
      <h1>Каталог техники</h1>
      <p className="muted">Каталог единый для приложения заказчика, приложения партнёра и админки. Новые категории и характеристики добавляются здесь, без программиста.</p>
      <div className="grid grid-2">
        <div className="card"><div className="spread"><h2>Категории</h2>{can && <NewCategory parentId={null} />}</div>{q.data ? render(q.data) : 'Загрузка…'}</div>
        <div className="card">
          {!current ? <div className="empty">Выберите категорию слева</div> : (
            <>
              <div className="spread"><h2>{current.name}</h2>
                {can && <span className="row">
                  {current.archived
                    ? <Action label="Вернуть из архива" path={`/admin/catalog/categories/${current.id}/unarchive`} invalidate={[['catalog']]} />
                    : <Action label="В архив" tone="danger" path={`/admin/catalog/categories/${current.id}/archive`} confirm="Скрыть категорию и снять её технику с линии?" invalidate={[['catalog']]} />}
                </span>}
              </div>
              <p className="muted">Код: {current.slug} · {current.isLeaf ? 'конкретный вид техники' : 'группа'} · год выпуска {current.yearRequired ? 'обязателен' : 'необязателен'}</p>
              {can && !current.archived && <NewCategory parentId={current.id} />}
              <h2 style={{ marginTop: 16 }}>Характеристики</h2>
              <Table rows={current.attributes} empty="Характеристик нет" cols={[
                { h: 'Название', c: (a) => <>{a.label}{a.inherited && <span className="muted"> (от группы)</span>}<div className="muted mono">{a.key}</div></> },
                { h: 'Тип', c: (a) => <>{TYPE[a.type]}{a.unit ? `, ${a.unit.label}` : ''}{a.options ? <div className="muted">{a.options.join(', ')}</div> : null}</> },
                { h: 'Обязательная', c: (a) => (a.required ? 'да' : '—') },
                { h: 'Фильтр', c: (a) => (a.filterable ? 'да' : '—') },
              ]} />
              {can && <NewAttribute categoryId={current.id} />}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function NewCategory({ parentId }: { parentId: string | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const m = useMutation({
    mutationFn: () => api('/admin/catalog/categories', { method: 'POST', body: { name, slug, parentId } }),
    onSuccess: () => { setOpen(false); setName(''); setSlug(''); void qc.invalidateQueries({ queryKey: ['catalog'] }); },
  });
  if (!open) return <button onClick={() => setOpen(true)}>{parentId ? '+ Подкатегория' : '+ Группа'}</button>;
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Код (латиница, например drilling_rig)" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <button className="primary" onClick={() => m.mutate()} disabled={m.isPending}>Создать</button>
      <button className="ghost" onClick={() => setOpen(false)}>Отмена</button>
      <ErrorBox error={m.error} />
    </div>
  );
}

function NewAttribute({ categoryId }: { categoryId: string }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ key: '', label: '', type: 'number', unitCode: '', options: '', required: false, filterable: false });
  const units = useQuery({ queryKey: ['units'], queryFn: () => api<{ code: string; label: string }[]>('/admin/catalog/units') });
  const m = useMutation({
    mutationFn: () => api(`/admin/catalog/categories/${categoryId}/attributes`, { method: 'POST', body: {
      key: f.key, label: f.label, type: f.type, unitCode: f.unitCode || null, required: f.required, filterable: f.filterable,
      options: ['enum', 'multi_enum'].includes(f.type) ? f.options.split(',').map((s) => s.trim()).filter(Boolean) : null,
    } }),
    onSuccess: () => { setF({ ...f, key: '', label: '', options: '' }); void qc.invalidateQueries({ queryKey: ['catalog'] }); },
  });
  return (
    <div style={{ marginTop: 12 }}>
      <h2>Новая характеристика</h2>
      <div className="row">
        <input placeholder="Название" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        <input placeholder="Код (латиница)" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={f.unitCode} onChange={(e) => setF({ ...f, unitCode: e.target.value })}><option value="">без единиц</option>{units.data?.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}</select>
        {['enum', 'multi_enum'].includes(f.type) && <input placeholder="Варианты через запятую" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} />}
        <label className="row"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> обязательная</label>
        <label className="row"><input type="checkbox" checked={f.filterable} onChange={(e) => setF({ ...f, filterable: e.target.checked })} /> фильтр для заказчика</label>
        <button className="primary" onClick={() => m.mutate()} disabled={m.isPending}>Добавить</button>
      </div>
      <ErrorBox error={m.error} />
    </div>
  );
}

interface Tariff { id: string; category: string; categoryId: string; region: string; regionId: string; kind: string; priceKopecks: number; validFrom: string; state: string; reason: string | null }
const STATE: Record<string, [string, string]> = { current: ['Действует', 'success'], scheduled: ['Запланирован', 'info'], superseded: ['Устарел', 'neutral'], cancelled: ['Отменён', 'neutral'] };

export function TariffsPage({ role }: { role: string }) {
  const [kind, setKind] = useState('rent_hour');
  const [showOld, setShowOld] = useState(false);
  const q = useQuery({ queryKey: ['tariffs', kind], queryFn: () => api<Tariff[]>(`/admin/tariffs?kind=${kind}`) });
  const rows = q.data?.filter((t) => showOld || t.state === 'current' || t.state === 'scheduled');
  return (
    <>
      <h1>Тарифы</h1>
      <p className="muted">Версии тарифов не изменяются: новая цена — новая версия с датой начала. Уже оформленные заказы сохраняют свою цену.</p>
      <div className="spread">
        <div className="tabs">{[['rent_hour', 'Аренда за час'], ['delivery_km', 'Доставка за км']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k as string)}>{l}</button>)}</div>
        <label className="row"><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> показать историю</label>
      </div>
      {kind === 'delivery_km' && q.data?.length === 0 && <div className="error">Тарифы доставки не заданы — расчёт цены для заказчиков не работает, пока они не появятся.</div>}
      {role === 'superadmin' && <NewTariff kind={kind} />}
      <div className="card" style={{ marginTop: 12 }}>
        <Table rows={rows} empty="Тарифов нет" cols={[
          { h: 'Техника', c: (t) => t.category }, { h: 'Регион', c: (t) => t.region }, { h: 'Цена', c: (t) => <b><Money k={t.priceKopecks} /></b> },
          { h: 'С', c: (t) => <DateTime v={t.validFrom} /> }, { h: 'Состояние', c: (t) => <Badge tone={STATE[t.state]?.[1] ?? 'neutral'}>{STATE[t.state]?.[0] ?? t.state}</Badge> },
          { h: '', c: (t) => (role === 'superadmin' && t.state === 'scheduled' ? <Action label="Отменить" path={`/admin/tariffs/${t.id}/cancel`} confirm="Отменить запланированную версию?" invalidate={[['tariffs']]} /> : null) },
        ]} />
      </div>
    </>
  );
}

function NewTariff({ kind }: { kind: string }) {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['catalog'], queryFn: () => api<Node[]>('/admin/catalog/categories') });
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => api<{ id: string; name: string }[]>('/admin/regions') });
  const [f, setF] = useState({ categoryId: '', regionId: '', price: '', validFrom: '', reason: '' });
  const flat = (ns: Node[] | undefined, d = 0): { id: string; name: string }[] => (ns ?? []).flatMap((n) => [{ id: n.id, name: `${'— '.repeat(d)}${n.name}` }, ...flat(n.children, d + 1)]);
  const m = useMutation({
    mutationFn: () => api('/admin/tariffs', { method: 'POST', body: {
      categoryId: f.categoryId, regionId: f.regionId, kind, priceKopecks: Math.round(Number(f.price.replace(',', '.')) * 100),
      ...(f.validFrom ? { validFrom: new Date(f.validFrom).toISOString() } : {}), ...(f.reason ? { reason: f.reason } : {}),
    } }),
    onSuccess: () => { setF({ ...f, price: '', reason: '' }); void qc.invalidateQueries({ queryKey: ['tariffs'] }); },
  });
  return (
    <div className="card"><h2>Новая версия тарифа</h2>
      <div className="row">
        <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Категория…</option>{flat(cats.data).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value })}><option value="">Регион…</option>{regions.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <input placeholder={kind === 'rent_hour' ? '₽ за час' : '₽ за км'} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" />
        <label className="row muted">с <input type="datetime-local" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></label>
        <input placeholder="Причина" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <button className="primary" disabled={!f.categoryId || !f.regionId || !f.price || m.isPending} onClick={() => m.mutate()}>Сохранить</button>
      </div>
      <ErrorBox error={m.error} />
    </div>
  );
}

export function RegionsPage({ role }: { role: string }) {
  const q = useQuery({ queryKey: ['regions'], queryFn: () => api<{ id: string; name: string; code: string; timezone: string; active: boolean; zonesCount: number }[]>('/admin/regions') });
  const [regionId, setRegionId] = useState('');
  const [name, setName] = useState('');
  const [geojson, setGeojson] = useState('');
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api(`/admin/regions/${regionId}/zones`, { method: 'POST', body: { name, geojson: JSON.parse(geojson) } }),
    onSuccess: () => { setGeojson(''); void qc.invalidateQueries({ queryKey: ['regions'] }); },
  });
  return (
    <>
      <h1>Регионы</h1>
      <div className="card">
        <Table rows={q.data} cols={[
          { h: 'Регион', c: (r) => r.name }, { h: 'Часовой пояс', c: (r) => r.timezone },
          { h: 'Границы', c: (r) => (r.zonesCount ? `${r.zonesCount} зон(ы)` : <Badge tone="danger">не загружены</Badge>) },
          { h: 'Активен', c: (r) => (r.active ? 'да' : 'нет') },
        ]} />
      </div>
      {role === 'superadmin' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Загрузить границы (GeoJSON)</h2>
          <p className="muted">По границам определяется регион объекта и тариф (К-15). Принимается Polygon, MultiPolygon, Feature или FeatureCollection.</p>
          <div className="row">
            <select value={regionId} onChange={(e) => setRegionId(e.target.value)}><option value="">Регион…</option>{q.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <input placeholder="Название зоны" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <textarea placeholder='{"type":"Polygon","coordinates":[...]}' value={geojson} onChange={(e) => setGeojson(e.target.value)} style={{ marginTop: 8 }} />
          <button className="primary" disabled={!regionId || !name || !geojson || m.isPending} onClick={() => m.mutate()}>Загрузить</button>
          <ErrorBox error={m.error} />
        </div>
      )}
    </>
  );
}
