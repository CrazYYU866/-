import { api, Button, Card, Choice, Notice, radius, Screen, space, Stepper, T, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Unit } from '../../lib/units';

const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const pad = (n: number) => String(n).padStart(2, '0');
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number) as [number, number]; return h * 60 + m; };
const fmt = (m: number) => (m >= 1440 ? '24:00' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
type Day = { on: boolean; start: number; end: number };

/** Расписание доступности техники. Пустое расписание — техника доступна в любое время (С-18). */
export default function Schedule() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['unit', id], queryFn: () => api<Unit>(`/partner/equipment/${id}`) });
  const [mode, setMode] = useState<'any' | 'schedule'>('any');
  const [days, setDays] = useState<Day[]>(DAYS.map((_, i) => ({ on: i < 5, start: 8 * 60, end: 20 * 60 })));
  useEffect(() => {
    const sch = q.data?.schedule;
    if (!sch) return;
    setMode(sch.length ? 'schedule' : 'any');
    if (sch.length) setDays(DAYS.map((_, i) => {
      const r = sch.find((x) => x.weekday === i + 1);
      return r ? { on: true, start: toMin(r.start), end: toMin(r.end) } : { on: false, start: 8 * 60, end: 20 * 60 };
    }));
  }, [q.data?.schedule]);
  const save = useMutation({
    mutationFn: () => api(`/partner/equipment/${id}/schedule`, {
      method: 'PUT',
      body: { intervals: mode === 'any' ? [] : days.flatMap((d, i) => (d.on ? [{ weekday: i + 1, start: fmt(d.start), end: fmt(d.end) }] : [])) },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['unit', id] }); router.back(); },
  });
  const patch = (i: number, p: Partial<Day>) => setDays((cur) => cur.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const invalid = mode === 'schedule' && (days.every((d) => !d.on) || days.some((d) => d.on && d.end <= d.start));

  return (
    <Screen footer={<>
      {save.error ? <Notice tone="danger">{(save.error as Error).message}</Notice> : null}
      {invalid ? <T v="small" muted center>Отметьте хотя бы один день; конец позже начала.</T> : null}
      <Button title="Сохранить" disabled={invalid} loading={save.isPending} onPress={() => save.mutate()} />
    </>}>
      <Choice value={mode} onChange={setMode} options={[
        { value: 'any', label: 'Доступна в любое время', hint: 'Заказы предлагаются на любые дни и часы' },
        { value: 'schedule', label: 'По расписанию', hint: 'Заказы — только в отмеченные дни и часы' },
      ]} />
      {mode === 'schedule' ? days.map((d, i) => (
        <Card key={DAYS[i]} style={{ gap: space.sm }}>
          <Pressable onPress={() => patch(i, { on: !d.on })} accessibilityRole="checkbox" accessibilityState={{ checked: d.on }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, borderColor: d.on ? t.accent : t.border, backgroundColor: d.on ? t.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {d.on ? <T style={{ color: t.accentText, fontWeight: '800' }}>✓</T> : null}
            </View>
            <T style={{ fontWeight: '600', flex: 1 }}>{DAYS[i]}</T>
            {!d.on ? <T muted>выходной</T> : null}
          </Pressable>
          {d.on ? (
            <View style={{ gap: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T muted>с</T>
                <Stepper label="С" value={d.start} min={0} max={23 * 60 + 30} step={30} format={fmt} onChange={(v) => patch(i, { start: v })} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T muted>до</T>
                <Stepper label="До" value={d.end} min={30} max={24 * 60} step={30} format={fmt} onChange={(v) => patch(i, { end: v })} />
              </View>
            </View>
          ) : null}
        </Card>
      )) : null}
    </Screen>
  );
}
