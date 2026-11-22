import { addBusinessDays, isBusinessDay } from './business-days';

describe('рабочие дни', () => {
  const none = new Map<string, boolean>();
  it('выходные пропускаются', () => {
    expect(addBusinessDays('2026-12-04', 1, none)).toBe('2026-12-07'); // пт → пн
    expect(addBusinessDays('2026-11-30', 3, none)).toBe('2026-12-03'); // пн + 3 → чт
  });
  it('праздники и переносы из календаря', () => {
    const ex = new Map([['2026-12-31', false], ['2027-01-09', true]]);
    expect(isBusinessDay('2026-12-31', ex)).toBe(false);
    expect(isBusinessDay('2027-01-09', ex)).toBe(true); // рабочая суббота
    expect(addBusinessDays('2026-12-30', 1, ex)).toBe('2027-01-01');
  });
});
