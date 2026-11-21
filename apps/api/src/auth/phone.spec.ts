import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['8 916 123-45-67', '+79161234567'],
    ['+7 (916) 123 45 67', '+79161234567'],
    ['9161234567', '+79161234567'],
    ['+79161234567', '+79161234567'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['123', 'abc', '+7 495 123-45-67', ''])('отклоняет %s', (input) => {
    expect(() => normalizePhone(input)).toThrow();
  });
});
