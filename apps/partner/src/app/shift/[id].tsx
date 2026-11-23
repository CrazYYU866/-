import { api, auth, Button, Card, Choice, dateShort, ErrorView, Field, hoursWord, Icon, Loading, Notice, Pill, post, Section, space, Stepper, T, time, useOrderRealtime, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { needsBackgroundDisclosure, pointForStatus, startTracking, stopTracking } from '../../lib/gps';
import { useOrg } from '../../lib/org';
import { enqueueStatus, flushQueue, pendingStatusCount } from '../../lib/queue';
import { SHIFT_LABEL, type PartnerOrder } from '../../lib/types';

type Step = 'en_route' | 'arrived' | 'in_progress' | 'finished';
const NEXT: Record<string, { step: Step; label: string; hint: string } | undefined> = {
  pending: { step: 'en_route', label: 'Выехал', hint: 'Заказчик начнёт видеть, где вы. Передача координат — только в пути.' },
  en_route: { step: 'arrived', label: 'Прибыл на объект', hint: 'Передача координат остановится.' },
  arrived: { step: 'in_progress', label: 'Начал работу', hint: 'С этого момента идёт время работы.' },
  in_progress: { step: 'finished', label: 'Завершил работу', hint: 'Заказчик подтвердит завершение.' },
};
const WORKING = ['arrived', 'in_progress'];

/** Экран смены машиниста (ТЗ §4, Р-17, Р-18): один крупный следующий шаг, работает и без связи. */
export default function ShiftScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  const { current } = useOrg();
  useOrderRealtime(id);
  const me = auth.current?.user.id;
  const q = useQuery({ queryKey: ['op-order', id], queryFn: () => api<PartnerOrder>(`/partner/operator/orders/${id}`), refetchInterval: 20_000 });
  // Статус, нажатый без связи, показываем сразу; на сервер он уйдёт из очереди (Р-18).
  const [local, setLocal] = useState<Step | null>(null);
  const [pending, setPending] = useState(0);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const refreshPending = () => pendingStatusCount(id).then(setPending);
  useEffect(() => { refreshPending(); const t2 = setInterval(refreshPending, 5_000); return () => clearInterval(t2); }, [id]);

  const o = q.data;
  const mine = o?.shifts.filter((s) => s.operator?.userId === me) ?? [];
  const shift = mine.find((s) => s.status !== 'finished' && s.status !== 'cancelled') ?? mine[mine.length - 1];
  const serverStatus = shift?.status ?? 'pending';
  const order = ['pending', 'en_route', 'arrived', 'in_progress', 'finished'];
  const status = local && order.indexOf(local) > order.indexOf(serverStatus) ? local : serverStatus;
  const next = NEXT[status];
  const cancelled = o && ['cancelled', 'cancelled_unpaid', 'refund_pending', 'search_failed'].includes(o.status);

  const [disclosure, setDisclosure] = useState(false);
  const press = useMutation({
    mutationFn: async ({ step, background = true }: { step: Step; background?: boolean }) => {
      setGpsNote(null);
      if (step === 'en_route') {
        const r = await startTracking(id, current!.orgId, background);
        if (!r.ok) setGpsNote(r.reason === 'permission_denied' ? 'Нет доступа к геолокации — заказчик не увидит, где вы. Разрешите доступ в настройках телефона.' : 'Геолокация выключена. Включите её, чтобы заказчик видел, где вы.');
        else if (!r.background && Platform.OS !== 'web') setGpsNote('Разрешите доступ к геолокации «Всегда», иначе при свёрнутом приложении координаты не передаются.');
      }
      if (step === 'arrived') await stopTracking();
      const where = await pointForStatus();
      await enqueueStatus({ orderId: id, orgId: current!.orgId, status: step, ...where });
      setLocal(step);
      await flushQueue();
      await refreshPending();
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['op-order', id] }); qc.invalidateQueries({ queryKey: ['my-shifts'] }); },
  });

  if (q.isLoading) return <Loading />;
  if (!o) return <View style={{ padding: space.lg }}><ErrorView error={q.error} onRetry={() => q.refetch()} /></View>;

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={st.body} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      <Stack.Screen options={{ title: `Заказ №${o.number}` }} />
      {shift ? (
        <View style={{ gap: 4 }}>
          <Pill label={SHIFT_LABEL[status] ?? status} tone={status === 'finished' ? 'success' : status === 'pending' ? 'neutral' : 'accent'} />
          <T v="h2">{dateShort(shift.start)}, {time(shift.start)}–{time(shift.end)}</T>
          <T muted>{o.category} · {shift.hours} {hoursWord(shift.hours)}</T>
        </View>
      ) : null}

      {cancelled ? <Notice tone="danger">Заказ отменён. Выполнять его не нужно.</Notice> : null}
      {pending > 0 ? <Notice tone="warning">{`Нет связи: ${pending} отметк${pending === 1 ? 'а' : 'и'} сохранен${pending === 1 ? 'а' : 'ы'} на телефоне и отправ${pending === 1 ? 'ится' : 'ятся'} автоматически.`}</Notice> : null}
      {gpsNote ? <Notice tone="warning">{gpsNote}</Notice> : status === 'en_route' ? <Notice tone="success">Заказчик видит, где вы. Координаты передаются до нажатия «Прибыл».</Notice> : null}

      {!cancelled && next && o.status !== 'awaiting_prepayment' ? (
        <View style={{ gap: space.sm }}>
          <Button title={next.label} loading={press.isPending} onPress={async () => {
            if (next.step === 'en_route' && (await needsBackgroundDisclosure())) setDisclosure(true);
            else press.mutate({ step: next.step });
          }} />
          <T v="small" muted center>{next.hint}</T>
          {press.error ? <Notice tone="danger">{(press.error as Error).message}</Notice> : null}
        </View>
      ) : null}
      {disclosure ? (
        <Card accent>
          <T v="h3">Геолокация в пути</T>
          <T>Пока вы едете к объекту, приложение передаёт ваше местоположение заказчику и диспетчеру — в том числе когда приложение свёрнуто или экран заблокирован.</T>
          <T>Передача начинается после «Выехал» и прекращается после «Прибыл». В другое время местоположение не собирается. Трек хранится 48 часов после завершения заказа.</T>
          <T v="small" muted>Далее телефон спросит разрешение — выберите «Разрешить всегда» (Android) или «Всегда» (iPhone).</T>
          <Button title="Продолжить" onPress={() => { setDisclosure(false); press.mutate({ step: 'en_route' }); }} />
          <Button kind="ghost" title="Только пока приложение открыто" onPress={() => { setDisclosure(false); press.mutate({ step: 'en_route', background: false }); }} />
        </Card>
      ) : null}
      {status === 'finished' ? <Notice tone="success">Смена завершена. Спасибо!</Notice> : null}

      <Section title="Объект">
        <Card>
          <T style={{ fontWeight: '600' }}>{o.site.address}</T>
          {o.site.comment ? <T muted>{o.site.comment}</T> : null}
          <Button kind="secondary" title="Маршрут в Яндекс Навигаторе" icon={<Icon name="nav" color={t.text} size={18} />}
            onPress={() => Linking.openURL(`https://yandex.ru/maps/?rtext=~${o.site.lat},${o.site.lng}&rtt=auto`)} />
        </Card>
      </Section>

      {!cancelled ? <ContactRow orderId={o.id} /> : null}
      {!cancelled && WORKING.includes(status) ? <Extension orderId={o.id} /> : null}
      {!cancelled && status !== 'finished' ? <Incident orderId={o.id} /> : null}
      {!cancelled && status === 'pending' ? <Decline orderId={o.id} /> : null}
    </ScrollView>
  );
}

function ContactRow({ orderId }: { orderId: string }) {
  const t = useTheme();
  const call = useMutation({
    mutationFn: () => post<{ virtualNumber: string }>(`/partner/operator/orders/${orderId}/call`),
    onSuccess: (r) => Linking.openURL(`tel:${r.virtualNumber}`).catch(() => undefined),
  });
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}><Button kind="secondary" title="Написать" icon={<Icon name="chat" color={t.text} size={18} />} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: orderId, as: 'operator' } })} /></View>
        <View style={{ flex: 1 }}><Button kind="secondary" title="Позвонить" icon={<Icon name="phone" color={t.text} size={18} />} loading={call.isPending} onPress={() => call.mutate()} /></View>
      </View>
      {call.data ? <T v="small" muted>Номер для звонка: {call.data.virtualNumber}. Ваш личный номер заказчику не показывается.</T> : null}
      {call.error ? <Notice tone="danger">{(call.error as Error).message}</Notice> : null}
    </View>
  );
}

function Extension({ orderId }: { orderId: string }) {
  const [hours, setHours] = useState(1);
  const [open, setOpen] = useState(false);
  const req = useMutation({ mutationFn: () => post(`/partner/operator/orders/${orderId}/extensions`, { hours }), onSuccess: () => setOpen(false) });
  if (!open) return <Button kind="ghost" title={req.isSuccess ? 'Запрос на продление отправлен заказчику' : 'Нужно больше времени'} disabled={req.isSuccess} onPress={() => setOpen(true)} />;
  return (
    <Card>
      <T v="h3">Продлить работу</T>
      <T muted>Заказчик получит запрос. После подтверждения работа продолжается сразу.</T>
      <View style={{ alignItems: 'center' }}><Stepper label="Часов" value={hours} min={1} max={12} format={(v) => `${v} ${hoursWord(v)}`} onChange={setHours} /></View>
      {req.error ? <Notice tone="danger">{(req.error as Error).message}</Notice> : null}
      <Button title="Отправить запрос" loading={req.isPending} onPress={() => req.mutate()} />
      <Button kind="ghost" title="Отмена" onPress={() => setOpen(false)} />
    </Card>
  );
}

function Incident({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'breakdown' | 'other'>('breakdown');
  const [comment, setComment] = useState('');
  const send = useMutation({ mutationFn: () => post(`/partner/operator/orders/${orderId}/incidents`, { type, comment: comment.trim() || undefined }), onSuccess: () => setOpen(false) });
  if (!open) return <Button kind="ghost" title={send.isSuccess ? 'Сообщение о проблеме отправлено диспетчеру' : 'Сообщить о проблеме'} disabled={send.isSuccess} onPress={() => setOpen(true)} />;
  return (
    <Card>
      <T v="h3">Что случилось?</T>
      <Choice value={type} onChange={setType} options={[{ value: 'breakdown', label: 'Поломка техники' }, { value: 'other', label: 'Другое' }]} />
      <Field value={comment} onChangeText={setComment} placeholder="Подробности" multiline />
      {send.error ? <Notice tone="danger">{(send.error as Error).message}</Notice> : null}
      <Button kind="danger" title="Отправить диспетчеру" loading={send.isPending} onPress={() => send.mutate()} />
      <Button kind="ghost" title="Отмена" onPress={() => setOpen(false)} />
    </Card>
  );
}

function Decline({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const send = useMutation({ mutationFn: () => post(`/partner/operator/orders/${orderId}/decline`, { reason }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-shifts'] }); router.back(); } });
  if (!open) return <Button kind="ghost" title="Не смогу выйти на смену" onPress={() => setOpen(true)} />;
  return (
    <Card>
      <T v="h3">Отказаться от смены?</T>
      <T muted>Диспетчер получит уведомление и назначит другого машиниста.</T>
      <Field value={reason} onChangeText={setReason} placeholder="Причина" multiline />
      {send.error ? <Notice tone="danger">{(send.error as Error).message}</Notice> : null}
      <Button kind="danger" title="Отказаться" disabled={reason.trim().length < 3} loading={send.isPending} onPress={() => send.mutate()} />
      <Button kind="ghost" title="Отмена" onPress={() => setOpen(false)} />
    </Card>
  );
}

const st = StyleSheet.create({ body: { padding: space.lg, gap: space.lg, paddingBottom: 64, width: '100%', maxWidth: 640, alignSelf: 'center' } });
