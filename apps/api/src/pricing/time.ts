/** Местное время в часовом поясе: день недели (1 = пн … 7 = вс) и минуты от полуночи. */
export function localParts(at: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { weekday, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export interface ScheduleInterval {
  weekday: number;
  start: string; // HH:MM
  end: string; // HH:MM, допускается 24:00
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Укладывается ли интервал [start, end) в рабочее расписание техники (В-12).
 * Интервал, переходящий через полночь, проверяется по частям для каждого местного дня.
 * Пустое расписание = техника доступна в любое время (С-18).
 */
export function fitsSchedule(start: Date, end: Date, schedule: ScheduleInterval[], timeZone: string): boolean {
  if (schedule.length === 0) return true;
  let cursor = start.getTime();
  const finish = end.getTime();
  while (cursor < finish) {
    const { weekday, minutes } = localParts(new Date(cursor), timeZone);
    const len = Math.min((finish - cursor) / 60_000, 1440 - minutes);
    const segEnd = minutes + len;
    const ok = schedule.some((s) => s.weekday === weekday && toMin(s.start) <= minutes && segEnd <= toMin(s.end));
    if (!ok) return false;
    cursor += len * 60_000;
  }
  return true;
}
