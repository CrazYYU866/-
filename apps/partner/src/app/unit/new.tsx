import { AddressPicker, api, Button, Choice, Field, Notice, post, Screen, Section, Stepper, T, type Place } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { AttrInput } from '../../components/AttrInput';
import type { Attr } from '../../lib/units';

interface Cat { id: string; name: string; isLeaf: boolean; yearRequired: boolean; children: Cat[] }
const leaves = (n: Cat): Cat[] => (n.isLeaf ? [n] : n.children.flatMap(leaves));

/** Новая техника: вид из каталога, марка/модель, характеристики, стоянка и радиус работы. Затем документы и проверка. */
export default function NewUnit() {
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ['catalog-partner'], queryFn: () => api<Cat[]>('/catalog/categories?audience=partner') });
  const [group, setGroup] = useState('');
  const [cat, setCat] = useState('');
  const attrs = useQuery({ queryKey: ['attrs', cat], enabled: Boolean(cat), queryFn: () => api<Attr[]>(`/catalog/categories/${cat}/attributes`) });
  const [f, setF] = useState({ brand: '', model: '', year: '', regNumber: '' });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [base, setBase] = useState<Place | null>(null);
  const [radius, setRadius] = useState(50);
  const [beyond, setBeyond] = useState<'no' | 'yes'>('no');
  const groupNode = tree.data?.find((g) => g.id === group);
  const category = groupNode ? leaves(groupNode).find((c) => c.id === cat) : undefined;
  const missing = (attrs.data ?? []).filter((a) => a.required && (values[a.key] === undefined || values[a.key] === ''));

  const create = useMutation({
    mutationFn: () => post<{ id: string }>('/partner/equipment', {
      categoryId: cat, brand: f.brand.trim(), model: f.model.trim(), year: f.year ? Number(f.year) : null, regNumber: f.regNumber.trim() || null,
      attributes: values, base: { lat: base!.lat, lng: base!.lng, address: base!.address }, workRadiusKm: radius, allowBeyondRadius: beyond === 'yes',
    }),
    onSuccess: (u) => { qc.invalidateQueries({ queryKey: ['units'] }); router.replace({ pathname: '/unit/[id]', params: { id: u.id } }); },
  });
  const ready = cat && f.brand.trim() && f.model.trim() && base && !missing.length && (!category?.yearRequired || f.year.length === 4);

  return (
    <Screen footer={<>
      {create.error ? <Notice tone="danger">{(create.error as Error).message}</Notice> : null}
      <Button title="Сохранить" disabled={!ready} loading={create.isPending} onPress={() => create.mutate()} />
    </>}>
      <Section title="Вид техники">
        <Choice value={group} onChange={(v) => { setGroup(v); setCat(''); setValues({}); }} options={(tree.data ?? []).map((g) => ({ value: g.id, label: g.name }))} />
        {groupNode ? <Choice value={cat} onChange={(v) => { setCat(v); setValues({}); }} options={leaves(groupNode).map((c) => ({ value: c.id, label: c.name }))} /> : null}
      </Section>
      {cat ? (
        <>
          <Section title="Машина">
            <Field label="Марка *" value={f.brand} onChangeText={(v) => setF({ ...f, brand: v })} placeholder="JCB" />
            <Field label="Модель *" value={f.model} onChangeText={(v) => setF({ ...f, model: v })} placeholder="3CX" />
            <Field label={`Год выпуска${category?.yearRequired ? ' *' : ''}`} value={f.year} onChangeText={(v) => setF({ ...f, year: v.replace(/\D/g, '').slice(0, 4) })} keyboardType="number-pad" />
            <Field label="Госномер" value={f.regNumber} onChangeText={(v) => setF({ ...f, regNumber: v.toUpperCase() })} autoCapitalize="characters" />
          </Section>
          {attrs.data?.length ? (
            <Section title="Характеристики">
              {attrs.data.map((a) => <AttrInput key={a.key} attr={a} value={values[a.key]} onChange={(v) => setValues((cur) => { const n = { ...cur }; if (v === undefined) delete n[a.key]; else n[a.key] = v; return n; })} />)}
              <T v="small" muted>* — обязательные. Заказчики подбирают технику по характеристикам.</T>
            </Section>
          ) : null}
          <Section title="Где стоит техника">
            <AddressPicker value={base} onChange={setBase} />
            <T v="label" muted>Радиус работы</T>
            <Stepper label="Радиус" value={radius} min={5} max={300} step={5} format={(v) => `${v} км`} onChange={setRadius} />
            <Choice value={beyond} onChange={setBeyond} options={[
              { value: 'no', label: 'Только в радиусе' },
              { value: 'yes', label: 'Готов ехать и дальше радиуса', hint: 'Заказы могут предлагаться за пределами радиуса, когда поиск расширяется' },
            ]} />
          </Section>
        </>
      ) : null}
    </Screen>
  );
}
