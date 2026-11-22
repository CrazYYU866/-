import { completionSplit, firstPaymentKopecks, retentionSplit } from './split';

const rub = (r: number) => r * 100;

describe('распределение денег', () => {
  it('пример заказчика (Ф-1): заказ диспетчера 30 000 ₽, фактическая доставка 7 000 вместо 6 000', () => {
    const s = completionSplit({
      totalKopecks: rub(30_000), commissionPercent: 12, agentPercent: 7, hasAgent: true,
      customerDeliveryKopecks: rub(6_000), partnerDeliveryKopecks: rub(7_000),
    });
    expect(s).toEqual({ commission: rub(3_600), agent: rub(2_100), platform: rub(1_500), deliverySubsidy: rub(1_000), partner: rub(27_400) });
    // Чистый остаток платформы после компенсации доставки — 500 ₽.
    expect(s.platform - s.deliverySubsidy).toBe(rub(500));
  });

  it('без диспетчера платформа получает все 12% (Ф-2); экономия на доставке остаётся платформе (П-3)', () => {
    const s = completionSplit({
      totalKopecks: rub(30_000), commissionPercent: 12, agentPercent: 7, hasAgent: false,
      customerDeliveryKopecks: rub(6_000), partnerDeliveryKopecks: rub(5_000),
    });
    expect(s).toEqual({ commission: rub(3_600), agent: 0, platform: rub(3_600), deliverySubsidy: rub(-1_000), partner: rub(25_400) });
  });

  it('удержание при отмене (Ф-3): от фактически удержанной суммы', () => {
    expect(retentionSplit(rub(10_000), 12, 7, false)).toEqual({ partner: rub(8_800), agent: 0, platform: rub(1_200) });
    expect(retentionSplit(rub(10_000), 12, 7, true)).toEqual({ partner: rub(8_800), agent: rub(700), platform: rub(500) });
    // Копейки не теряются при округлении.
    const odd = retentionSplit(12_345, 12, 7, true);
    expect(odd.partner + odd.agent + odd.platform).toBe(12_345);
  });

  it('первый платёж: физлицо 100%, юрлицо 50% до рубля', () => {
    expect(firstPaymentKopecks(rub(30_001), 'individual', 50)).toBe(rub(30_001));
    expect(firstPaymentKopecks(rub(30_001), 'legal', 50)).toBe(rub(15_001));
  });
});
