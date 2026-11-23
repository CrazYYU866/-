import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AddressPicker, api, Button, Card, Choice, DaysPicker, Divider, Field, hoursWord, Notice, post, radius, Row, rub, Screen, Section, space, T, time, useTheme, type OrderDay, type Place } from '@kovsh/mobile';

interface Attr { key: string; label: string; type: string; unit: { label: string } | null; options: string[] | null; filterable: boolean }
interface Quote {
  id: string; expiresAt: string; urgency: 'urgent' | 'scheduled'; region: { name: string }; totalHours: number;
  hourPriceKopecks: number; kmPriceKopecks: number; deliveryKm: number; rentKopecks: number; deliveryKopecks: number;
  totalKopecks: number; discountKopecks: number; payableKopecks: number; prepaymentKopecks: number; legalFirstPaymentKopecks: number;
}
interface Org { id: string; name: string; inn: string }
type Req = string | boolean | { min: number };

export default function NewOrder() {
  const t = useTheme();
  const qc = useQueryClient();
  const { categoryId, name } = useLocalSearchParams<{ categoryId: string; name?: string }>();
  const attrs = useQuery({ queryKey: ['attrs', categoryId], queryFn: () => api<Attr[]>(`/catalog/categories/${categoryId}/attributes`) });
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api<Org[]>('/client/organizations') });

  const [place, setPlace] = useState<Place | null>(null);
  const [comment, setComment] = useState('');
  const [days, setDays] = useState<OrderDay[]>([]);
  const [req, setReq] = useState<Record<string, Req>>({});
  const [promo, setPromo] = useState('');
  const [payer, setPayer] = useState<string>('individual');
  const [quote, setQuote] = useState<Quote | null>(null);
  const filters = (attrs.data ?? []).filter((a) => a.filterable && ['number', 'integer', 'boolean', 'enum'].includes(a.type));

  const changed = <A,>(fn: (v: A) => void) => (v: A) => { fn(v); setQuote(null); };



  const calc = useMutation({
    mutationFn: () => post<Quote>('/client/quotes', {
      categoryId, site: { lat: place!.lat, lng: place!.lng, address: place!.address }, requirements: req, days,
      promoCode: promo.trim() || undefined,
    }),
    onSuccess: setQuote,
  });
  const create = useMutation({
    mutationFn: () => post<{ id: string }>('/client/orders', {
      quoteId: quote!.id, siteComment: comment.trim() || undefined,
      payer: payer === 'individual' ? { kind: 'individual' } : { kind: 'legal', legalProfileId: payer },
    }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      router.replace({ pathname: '/order/[id]', params: { id: o.id } });
    },
  });

  const ready = place && days.length > 0;
  const legal = payer !== 'individual';

  return (
    <Screen
      footer={
        quote ? (
          <>
            {create.error ? <Notice tone="danger">{(create.error as Error).message}</Notice> : null}
            <Button title={`Заказать за ${rub(quote.payableKopecks)}`} loading={create.isPending} onPress={() => create.mutate()} />
            <T v="small" muted center>Оплата — после того, как исполнитель примет заказ</T>
          </>
        ) : (
          <>
            {calc.error ? <Notice tone="danger">{(calc.error as Error).message}</Notice> : null}
            <Button title="Рассчитать стоимость" disabled={!ready} loading={calc.isPending} onPress={() => calc.mutate()} />
          </>
        )
      }
    >
      <Stack.Screen options={{ title: name ?? 'Новый заказ' }} />

      <Section title="Адрес объекта">
        <AddressPicker value={place} onChange={changed(setPlace)} />
        <Field value={comment} onChangeText={setComment} placeholder="Как подъехать, кому позвонить, где разгрузиться" multiline label="Комментарий для машиниста" />
      </Section>

      <Section title="Когда">
        <DaysPicker days={days} onChange={changed(setDays)} />
      </Section>

      {filters.length ? (
        <Section title="Требования к технике">
          <T v="small" muted>Необязательно. Подберём технику, которая подходит под все условия.</T>
          {filters.map((a) => (
            <Requirement key={a.key} attr={a} value={req[a.key]} onChange={(v) => {
              setQuote(null);
              setReq((cur) => {
                const next = { ...cur };
                if (v === undefined) delete next[a.key];
                else next[a.key] = v;
                return next;
              });
            }} />
          ))}
        </Section>
      ) : null}

      <Section title="Кто платит">
        <Choice
          value={payer}
          onChange={changed(setPayer)}
          options={[
            { value: 'individual', label: 'Я — частное лицо', hint: '100% онлайн после того, как исполнитель примет заказ' },
            ...(orgs.data ?? []).map((o) => ({ value: o.id, label: o.name, hint: `ИНН ${o.inn} · 50% после принятия, 50% после завершения` })),
          ]}
        />
        {!orgs.data?.length ? (
          <Button kind="ghost" small title="Заказать от организации →" onPress={() => router.push('/organizations')} />
        ) : null}
      </Section>

      <Section title="Промокод">
        <Field value={promo} onChangeText={changed(setPromo)} placeholder="Если есть" autoCapitalize="characters" />
      </Section>

      {quote ? (
        <Card accent>
          <T v="h3">Стоимость</T>
          <Row label={`Аренда · ${quote.totalHours} ${hoursWord(quote.totalHours)} × ${rub(quote.hourPriceKopecks)}`} value={rub(quote.rentKopecks)} />
          <Row label={`Доставка · ${quote.deliveryKm} км`} value={rub(quote.deliveryKopecks)} />
          {quote.discountKopecks > 0 ? <Row label="Скидка по промокоду" value={`−${rub(quote.discountKopecks)}`} /> : null}
          <Divider />
          <Row label="Итого" value={rub(quote.payableKopecks)} strong />
          <Row label={legal ? 'Первый платёж (50%)' : 'Оплата после принятия'} value={rub(legal ? quote.legalFirstPaymentKopecks : quote.prepaymentKopecks)} />
          <T v="small" muted>
            {quote.urgency === 'urgent' ? 'Срочный заказ. ' : ''}Регион: {quote.region.name}. Цена действует до {time(quote.expiresAt)}.
          </T>
        </Card>
      ) : null}
    </Screen>
  );
}

function Requirement({ attr, value, onChange }: { attr: Attr; value: Req | undefined; onChange: (v: Req | undefined) => void }) {
  const t = useTheme();
  const unit = attr.unit?.label ? `, ${attr.unit.label}` : '';
  if (attr.type === 'boolean' || attr.type === 'enum') {
    const opts: { label: string; v: Req | undefined }[] = attr.type === 'boolean'
      ? [{ label: 'Неважно', v: undefined }, { label: 'Нужно', v: true }]
      : [{ label: 'Любой', v: undefined }, ...(attr.options ?? []).map((o) => ({ label: o, v: o }))];
    return (
      <View style={{ gap: 6 }}>
        <T v="label" muted>{attr.label}</T>
        <View style={s.chips}>
          {opts.map((o) => {
            const on = value === o.v;
            return (
              <Pressable key={o.label} onPress={() => onChange(o.v)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                style={[s.chip, { backgroundColor: on ? t.text : t.surface, borderColor: on ? t.text : t.border }]}>
                <T v="small" style={{ color: on ? t.surface : t.text, fontWeight: '600' }}>{o.label}</T>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }
  return <MinField label={`${attr.label}, не менее${unit}`} onChange={onChange} />;
}

function MinField({ label, onChange }: { label: string; onChange: (v: Req | undefined) => void }) {
  const [text, setText] = useState('');
  return (
    <Field label={label} value={text} keyboardType="decimal-pad" placeholder="Неважно"
      onChangeText={(v) => {
        const clean = v.replace(/[^\d.,]/g, '');
        setText(clean);
        const n = Number(clean.replace(',', '.'));
        onChange(clean.trim() === '' || Number.isNaN(n) ? undefined : { min: n });
      }} />
  );
}

const s = StyleSheet.create({
  day: { width: 72, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', gap: 2 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm },
});
