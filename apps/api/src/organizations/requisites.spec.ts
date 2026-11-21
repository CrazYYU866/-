import { isValidInn, isValidOgrn } from './requisites';

describe('ИНН и ОГРН', () => {
  it('принимает корректные номера', () => {
    expect(isValidInn('7707083893')).toBe(true); // ПАО Сбербанк
    expect(isValidOgrn('1027700132195')).toBe(true);
    expect(isValidInn('500100732259')).toBe(true);
  });
  it('отклоняет ошибки в контрольных числах и длине', () => {
    expect(isValidInn('7707083894')).toBe(false);
    expect(isValidInn('500100732258')).toBe(false);
    expect(isValidOgrn('1027700132196')).toBe(false);
    expect(isValidInn('123')).toBe(false);
    expect(isValidOgrn('12345678901234')).toBe(false);
  });
});
