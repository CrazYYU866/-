/** Распределение денег по заказу. Все суммы — целые копейки. */

const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);

export interface CompletionSplit {
  commission: number;
  agent: number;
  platform: number;
  /** Компенсация доставки платформой (>0 — платформа доплачивает исполнителю, <0 — экономия остаётся платформе). */
  deliverySubsidy: number;
  partner: number;
}

/**
 * Завершённый заказ (Ф-1, Ф-2, П-3, Н-2, Н-21):
 * комиссия — % от полной суммы заказа; диспетчеру — свой % от суммы (если заказ его), остальное комиссии — платформе;
 * исполнитель получает сумму заказа − комиссия + разница фактической и расчётной доставки.
 */
export function completionSplit(input: {
  totalKopecks: number;
  commissionPercent: number;
  agentPercent: number;
  hasAgent: boolean;
  customerDeliveryKopecks: number;
  partnerDeliveryKopecks: number;
}): CompletionSplit {
  const commission = pct(input.totalKopecks, input.commissionPercent);
  const agent = input.hasAgent ? pct(input.totalKopecks, input.agentPercent) : 0;
  const deliverySubsidy = input.partnerDeliveryKopecks - input.customerDeliveryKopecks;
  return {
    commission,
    agent,
    platform: commission - agent,
    deliverySubsidy,
    partner: input.totalKopecks - commission + deliverySubsidy,
  };
}

export interface RetentionSplit {
  partner: number;
  agent: number;
  platform: number;
}

/**
 * Удержанная по решению поддержки сумма (Ф-3): исполнителю (100 − комиссия)%, диспетчеру его %, платформе остаток.
 * Проценты — от фактически удержанной суммы.
 */
export function retentionSplit(retainedKopecks: number, commissionPercent: number, agentPercent: number, hasAgent: boolean): RetentionSplit {
  const partner = pct(retainedKopecks, 100 - commissionPercent);
  const agent = hasAgent ? pct(retainedKopecks, agentPercent) : 0;
  return { partner, agent, platform: retainedKopecks - partner - agent };
}

/** Первый платёж: физлицо — 100%, юрлицо — 50% с округлением до рубля (решения 07, Н-6). */
export function firstPaymentKopecks(totalKopecks: number, payer: 'individual' | 'legal', legalFirstPercent: number): number {
  if (payer === 'individual') return totalKopecks;
  return Math.round((totalKopecks * legalFirstPercent) / 100 / 100) * 100;
}
