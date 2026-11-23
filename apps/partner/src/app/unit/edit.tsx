import { AddressPicker, api, Button, Card, Choice, Field, Notice, Screen, Section, T, type Place } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { AttrInput } from '../../components/AttrInput';
import type { Attr, Unit } from '../../lib/units';

/**
 * Изменение карточки техники. По С-10 смена марки, модели, года или госномера снимает технику с линии и
 * отправляет на повторную проверку; характеристики, стоянка и радиус меняются без проверки.
 */
export default function EditUnit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['unit', id], queryFn: () => api<Unit>(`/partner/equipment/${id}`) });
  const u = q.data;
  const attrs = useQuery({ queryKey: ['attrs', u?.categoryId], enabled: Boolean(u), queryFn: () => api<Attr[]>(`/catalog/categories/${u!.categoryId}/attributes`) });
  const [f, setF] = useState({ brand: '', model: '', year: '', regNumber: '' });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [base, setBase] = useState<Place | null>(null);
  const [beyond, setBeyond] = useState<'no' | 'yes'>('no');
  useEffect(() => {
    if (!u) return;
    setF({ brand: u.brand, model: u.model, year: u.year ? String(u.year) : '', regNumber: u.regNumber ?? '' });
    setValues(u.attributes);
    setBase({ ...u.base });
    setBeyond(u.allowBeyondRadius ? 'yes' : 'no');
  }, [u]);
  const identityChanged = Boolean(u) && (f.brand.trim() !== u!.brand || f.model.trim() !== u!.model || (f.year || null) !== (u!.year ? String(u!.year) : null) || (f.regNumber.trim() || null) !== (u!.regNumber ?? null));
  const save = useMutation({
    mutationFn: () => api(`/partner/equipment/${id}`, {
      method: 'PATCH',
      body: {
        // Основные данные — только если изменены: иначе сохранение характеристик не должно запускать повторную проверку.
        ...(f.brand.trim() !== u!.brand ? { brand: f.brand.trim() } : {}),
        ...(f.model.trim() !== u!.model ? { model: f.model.trim() } : {}),
        ...((f.year || null) !== (u!.year ? String(u!.year) : null) ? { year: f.year ? Number(f.year) : null } : {}),
        ...((f.regNumber.trim() || null) !== (u!.regNumber ?? null) ? { regNumber: f.regNumber.trim() || null } : {}),
        attributes: values, allowBeyondRadius: beyond === 'yes',
        ...(base ? { base: { lat: base.lat, lng: base.lng, address: base.address } } : {}),
      },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['unit', id] }); qc.invalidateQueries({ queryKey: ['units'] }); router.back(); },
  });
  if (!u) return null;
  return (
    <Screen footer={<>
      {identityChanged && u.verificationStatus === 'approved' ? <Notice tone="warning">Марка, модель, год или госномер изменены: техника будет снята с линии и отправлена на повторную проверку.</Notice> : null}
      {save.error ? <Notice tone="danger">{(save.error as Error).message}</Notice> : null}
      <Button title="Сохранить" disabled={!f.brand.trim() || !f.model.trim() || !base} loading={save.isPending} onPress={() => save.mutate()} />
    </>}>
      <Section title="Машина">
        <Card><T muted>{u.categoryName} — вид техники не меняется; для другого вида добавьте новую карточку.</T></Card>
        <Field label="Марка" value={f.brand} onChangeText={(v) => setF({ ...f, brand: v })} />
        <Field label="Модель" value={f.model} onChangeText={(v) => setF({ ...f, model: v })} />
        <Field label="Год выпуска" value={f.year} onChangeText={(v) => setF({ ...f, year: v.replace(/\D/g, '').slice(0, 4) })} keyboardType="number-pad" />
        <Field label="Госномер" value={f.regNumber} onChangeText={(v) => setF({ ...f, regNumber: v.toUpperCase() })} autoCapitalize="characters" />
      </Section>
      {attrs.data?.length ? (
        <Section title="Характеристики">
          {attrs.data.map((a) => <AttrInput key={a.key} attr={a} value={values[a.key]} onChange={(v) => setValues((cur) => { const n = { ...cur }; if (v === undefined) delete n[a.key]; else n[a.key] = v; return n; })} />)}
        </Section>
      ) : null}
      <Section title="Стоянка">
        <AddressPicker value={base} onChange={setBase} />
        <Choice value={beyond} onChange={setBeyond} options={[
          { value: 'no', label: 'Только в радиусе' },
          { value: 'yes', label: 'Готов ехать и дальше радиуса', hint: 'Заказы могут предлагаться за пределами радиуса, когда поиск расширяется' },
        ]} />
      </Section>
    </Screen>
  );
}
