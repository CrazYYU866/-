import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { hoursWord } from './format';
import { Stepper } from './Stepper';
import { radius, space, useTheme } from './theme';
import { Card, T } from './ui';

export interface OrderDay { date: string; startTime: string; hours: number }

const TZ = 'Europe/Moscow';
const isoDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const pad = (n: number) => String(n).padStart(2, '0');

function nextDays(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    return {
      date: isoDay(d),
      wd: i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : d.toLocaleDateString('ru-RU', { timeZone: TZ, weekday: 'short' }),
      day: d.toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short' }),
    };
  });
}

/** Дни заказа: заказчик сам выбирает дни и часы каждого дня (Л-1). Время — московское. */
export function DaysPicker({ days, onChange }: { days: OrderDay[]; onChange: (d: OrderDay[]) => void }) {
  const t = useTheme();
  const calendar = useMemo(() => nextDays(21), []);
  const toggle = (date: string) => {
    if (days.some((d) => d.date === date)) return onChange(days.filter((d) => d.date !== date));
    const tpl = days[days.length - 1] ?? { startTime: '08:00', hours: 8 };
    onChange([...days, { date, startTime: tpl.startTime, hours: tpl.hours }].sort((a, b) => a.date.localeCompare(b.date)));
  };
  const patch = (date: string, p: Partial<OrderDay>) => onChange(days.map((d) => (d.date === date ? { ...d, ...p } : d)));
  return (
    <View style={{ gap: space.sm }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
        {calendar.map((d) => {
          const on = days.some((x) => x.date === d.date);
          return (
            <Pressable key={d.date} onPress={() => toggle(d.date)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
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
        const c = calendar.find((x) => x.date === d.date);
        return (
          <Card key={d.date} style={{ gap: space.md }}>
            <T style={{ fontWeight: '600' }}>{c?.day}, {c?.wd.toLowerCase()}</T>
            <View style={s.row}>
              <T muted>Начало</T>
              <Stepper label="Начало" value={hh * 60 + mm} min={0} max={23 * 60 + 30} step={30}
                format={(v) => `${pad(Math.floor(v / 60))}:${pad(v % 60)}`}
                onChange={(v) => patch(d.date, { startTime: `${pad(Math.floor(v / 60))}:${pad(v % 60)}` })} />
            </View>
            <View style={s.row}>
              <T muted>Часов</T>
              <Stepper label="Часов" value={d.hours} min={1} max={24} format={(v) => `${v} ${hoursWord(v)}`} onChange={(v) => patch(d.date, { hours: v })} />
            </View>
          </Card>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  day: { width: 72, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
