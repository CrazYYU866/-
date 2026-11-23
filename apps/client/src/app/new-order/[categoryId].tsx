import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AddressPicker, type Place } from '../../components/AddressPicker';
import { Stepper } from '../../components/Stepper';
import { Button, Card, Choice, Divider, Field, Notice, Row, Screen, Section, T } from '../../components/ui';
import { api, post } from '../../lib/api';
import { hoursWord, rub, time } from '../../lib/format';
import { radius, space, useTheme } from '../../lib/theme';

interface Attr { key: string; label: string; type: string; unit: { label: string } | null; options: string[] | null; filterable: boolean }
interface Quote {
  id: string; expiresAt: string; urgency: 'urgent' | 'scheduled'; region: { name: string }; totalHours: number;
  hourPriceKopecks: number; kmPriceKopecks: number; deliveryKm: number; rentKopecks: number; deliveryKopecks: number;
  totalKopecks: number; discountKopecks: number; payableKopecks: number; prepaymentKopecks: number; legalFirstPaymentKopecks: number;
}
interface Org { id: string; name: string; inn: string }
interface Day { date: string; startTime: string; hours: number }
type Req = string | boolean | { min: number };

const TZ = 'Europe/Moscow';
const isoDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const pad = (n: number) => String(n).padStart(2, '0');

function nextDays(n: number) {
  const out: { date: string; wd: string; day: string }[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    out.push({
      date: isoDay(d),
      wd: i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : d.toLocaleDateString('ru-RU', { timeZone: TZ, weekday: 'short' }),
      day: d.toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short' }),
    });
  }
  return out;
}

export default function NewOrder() {
  const t = useTheme();
  const qc = useQueryClient();
  const { categoryId, name } = useLocalSearchParams<{ categoryId: string; name?: string }>();
  const attrs = useQuery({ queryKey: ['attrs', categoryId], queryFn: () => api<Attr[]>(`/catalog/categories/${categoryId}/attributes`) });
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api<Org[]>('/client/organizations') });

  const [place, setPlace] = useState<Place | null>(null);
  const [comment, setComment] = useState('');
  const [days, setDays] = useState<Day[]>([]);
  const [req, setReq] = useState<Record<string, Req>>({});
  const [promo, setPromo] = useState('');
  const [payer, setPayer] = useState<string>('individual');
  const [quote, setQuote] = useState<Quote | null>(null);
  const calendar = useMemo(() => nextDays(21), []);
  const filters = (attrs.data ?? []).filter((a) => a.filterable && ['number', 'integer', 'boolean', 'enum'].includes(a.type));

  const changed = <A,>(fn: (v: A) => void) => (v: A) => { fn(v); setQuote(null); };

  function toggleDay(date: string) {
    setQuote(null);
    setDays((cur) => {
      if (cur.some((d) => d.date === date)) return cur.filter((d) => d.date !== date);
      const tpl = cur[cur.length - 1] ?? { startTime: '08:00', hours: 8 };
      return [...cur, { date, startTime: tpl.startTime, hours: tpl.hours }].sort((a, b) => a.date.localeCompare(b.date));
    });
  }
  const patchDay = (date: string, p: Partial<Day>) => { setQuote(null); setDays((cur) => cur.map((d) => (d.date === date ? { ...d, ...p } : d))); };

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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {calendar.map((d) => {
            const on = days.some((x) => x.date === d.date);
            return (
              <Pressable key={d.date} onPress={() => toggleDay(d.date)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                style={[s.day, { backgroundColor: on ? t.accent : t.surface, borderColor: on ? t.accent : t.border }]}>
                <T v="small" style={{ color: on ? t.accentText : t.textMuted }}>{d.wd}</T>
                <T style={{ fontWeight: '700', color: on ? t.accentText : t.text }}>{d.day}</T>
              </Pressable>
            );
          })}
        </ScrollView>
        <T v="small" muted>{days.length ? 'Для каждого дня укажите начало и сколько часов нужна техника.' : 'Выберите один или несколько дней.'}</T>
        {days.map((d) => {
          const [hh, mm] = d.startTime.split(':').map(Number) as [number, number];
          const minutes = hh * 60 + mm;
          return (
            <Card key={d.date} style={{ gap: space.md }}>
              <T style={{ fontWeight: '600' }}>{calendar.find((c) => c.date === d.date)?.day}, {calendar.find((c) => c.date === d.date)?.wd.toLowerCase()}</T>
              <View style={s.rowBetween}>
                <T muted>Начало</T>
                <Stepper label="Начало" value={minutes} min={0} max={23 * 60 + 30} step={30}
                  format={(v) => `${pad(Math.floor(v / 60))}:${pad(v % 60)}`}
                  onChange={(v) => patchDay(d.date, { startTime: `${pad(Math.floor(v / 60))}:${pad(v % 60)}` })} />
              </View>
              <View style={s.rowBetween}>
                <T muted>Часов</T>
                <Stepper label="Часов" value={d.hours} min={1} max={24} format={(v) => `${v} ${hoursWord(v)}`} onChange={(v) => patchDay(d.date, { hours: v })} />
              </View>
            </Card>
          );
        })}
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
