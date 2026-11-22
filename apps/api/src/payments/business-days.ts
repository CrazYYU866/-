/** Рабочие дни (К-1): сб и вс — выходные, плюс исключения производственного календаря (праздники, переносы). */
export type CalendarExceptions = Map<string, boolean>;

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function isBusinessDay(date: string, ex: CalendarExceptions): boolean {
  const override = ex.get(date);
  if (override !== undefined) return override;
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** Дата через n рабочих дней после `date` (сама `date` не считается). */
export function addBusinessDays(date: string, n: number, ex: CalendarExceptions): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d, ex)) left--;
  }
  return d;
}
