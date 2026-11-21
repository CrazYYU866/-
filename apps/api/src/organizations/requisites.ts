/** Проверка контрольных чисел ИНН и ОГРН/ОГРНИП (алгоритмы ФНС). */

const weighted = (digits: number[], weights: number[]): number =>
  (weights.reduce((sum, w, i) => sum + w * (digits[i] ?? 0), 0) % 11) % 10;

export function isValidInn(inn: string): boolean {
  if (!/^(\d{10}|\d{12})$/.test(inn)) return false;
  const d = [...inn].map(Number);
  if (d.length === 10) return weighted(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return (
    weighted(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] &&
    weighted(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11]
  );
}

export function isValidOgrn(ogrn: string): boolean {
  if (!/^(\d{13}|\d{15})$/.test(ogrn)) return false;
  const body = BigInt(ogrn.slice(0, -1));
  const check = Number(ogrn.slice(-1));
  const mod = ogrn.length === 13 ? 11n : 13n;
  return Number((body % mod) % 10n) === check;
}
