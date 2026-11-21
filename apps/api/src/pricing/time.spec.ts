import { splitIntoShifts } from './pricing.service';
import { fitsSchedule, localParts } from './time';

const msk = (iso: string) => new Date(`${iso}+03:00`);

describe('время и смены', () => {
  it('местный день недели и минуты', () => {
    expect(localParts(msk('2026-12-07T08:30:00'), 'Europe/Moscow')).toEqual({ weekday: 1, minutes: 510 });
  });

  it('интервал в расписании, вне его и через полночь', () => {
    const sch = [
      { weekday: 1, start: '08:00', end: '20:00' },
      { weekday: 5, start: '18:00', end: '24:00' },
      { weekday: 6, start: '00:00', end: '06:00' },
    ];
    expect(fitsSchedule(msk('2026-12-07T09:00:00'), msk('2026-12-07T17:00:00'), sch, 'Europe/Moscow')).toBe(true);
    expect(fitsSchedule(msk('2026-12-07T07:00:00'), msk('2026-12-07T12:00:00'), sch, 'Europe/Moscow')).toBe(false);
    expect(fitsSchedule(msk('2026-12-11T22:00:00'), msk('2026-12-12T02:00:00'), sch, 'Europe/Moscow')).toBe(true);
    expect(fitsSchedule(msk('2026-12-11T22:00:00'), msk('2026-12-12T07:00:00'), sch, 'Europe/Moscow')).toBe(false);
    expect(fitsSchedule(msk('2026-12-08T03:00:00'), msk('2026-12-08T05:00:00'), [], 'Europe/Moscow')).toBe(true);
  });

  it('день длиннее 11 часов делится на смены (К-3)', () => {
    const shifts = splitIntoShifts([{ start: msk('2026-12-07T06:00:00'), end: msk('2026-12-07T21:00:00') }], 11);
    expect(shifts.map((s) => s.hours)).toEqual([11, 4]);
    expect(shifts[1]?.start).toBe(msk('2026-12-07T17:00:00').toISOString());
  });
});
