import { AddressPicker, api, Button, Card, Choice, DaysPicker, Divider, Field, hoursWord, normalizePhone, Notice, post, Row, rub, Screen, Section, T, type OrderDay, type Place } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';

interface Cat { id: string; name: string; isLeaf: boolean; children: Cat[] }
const leaves = (n: Cat): Cat[] => (n.isLeaf ? [n] : n.children.flatMap(leaves));
interface Quote { id: string; totalHours: number; rentKopecks: number; deliveryKopecks: number; deliveryKm: number; totalKopecks: number; payableKopecks: number }

/**
 * Заявка за заказчика (Н-27, Н-30): диспетчер рассчитывает заказ и указывает телефон заказчика.
 * Заказчик получает SMS со ссылкой, сам выбирает плательщика, подтверждает и платит. Поиск исполнителя — после подтверждения.
 */
export default function NewAgentOrder() {
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ['catalog-customer'], queryFn: () => api<Cat[]>('/catalog/categories?audience=customer') });
  const [group, setGroup] = useState('');
  const [cat, setCat] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [comment, setComment] = useState('');
  const [days, setDays] = useState<OrderDay[]>([]);
  const [phone, setPhone] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const reset = <A,>(fn: (v: A) => void) => (v: A) => { fn(v); setQuote(null); };
  const groupNode = tree.data?.find((g) => g.id === group);
  const calc = useMutation({
    mutationFn: () => post<Quote>('/partner/agent/quotes', { categoryId: cat, site: { lat: place!.lat, lng: place!.lng, address: place!.address }, requirements: {}, days, customerPhone: normalizePhone(phone) }),
    onSuccess: setQuote,
  });
  const create = useMutation({
    mutationFn: () => post('/partner/agent/orders', { quoteId: quote!.id, siteComment: comment.trim() || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agent-orders'] }); router.back(); },
  });
  const ready = cat && place && days.length && phone.replace(/\D/g, '').length >= 10;
  return (
    <Screen footer={quote ? (
      <>
        {create.error ? <Notice tone="danger">{(create.error as Error).message}</Notice> : null}
        <Button title="Отправить заказчику на подтверждение" loading={create.isPending} onPress={() => create.mutate()} />
      </>
    ) : (
      <>
        {calc.error ? <Notice tone="danger">{(calc.error as Error).message}</Notice> : null}
        <Button title="Рассчитать" disabled={!ready} loading={calc.isPending} onPress={() => calc.mutate()} />
      </>
    )}>
      <Section title="Заказчик">
        <Field label="Телефон заказчика" value={phone} onChangeText={reset(setPhone)} keyboardType="phone-pad" placeholder="+7 900 000-00-00" hint="Заказчик получит SMS со ссылкой на заявку" />
      </Section>
      <Section title="Техника">
        <Choice value={group} onChange={(v) => { setGroup(v); setCat(''); setQuote(null); }} options={(tree.data ?? []).map((g) => ({ value: g.id, label: g.name }))} />
        {groupNode ? <Choice value={cat} onChange={reset(setCat)} options={leaves(groupNode).map((c) => ({ value: c.id, label: c.name }))} /> : null}
      </Section>
      <Section title="Адрес объекта">
        <AddressPicker value={place} onChange={reset(setPlace)} />
        <Field value={comment} onChangeText={setComment} placeholder="Как подъехать, кому позвонить" multiline label="Комментарий для машиниста" />
      </Section>
      <Section title="Когда">
        <DaysPicker days={days} onChange={reset(setDays)} />
      </Section>
      {quote ? (
        <Card accent>
          <T v="h3">Расчёт для заказчика</T>
          <Row label={`Аренда · ${quote.totalHours} ${hoursWord(quote.totalHours)}`} value={rub(quote.rentKopecks)} />
          <Row label={`Доставка · ${quote.deliveryKm} км`} value={rub(quote.deliveryKopecks)} />
          <Divider />
          <Row label="Итого для заказчика" value={rub(quote.payableKopecks)} strong />
          <T v="small" muted>Ваше вознаграждение начисляется после завершения заказа.</T>
        </Card>
      ) : null}
    </Screen>
  );
}
