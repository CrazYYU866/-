import { randomInt, randomUUID } from 'node:crypto';

/**
 * Подменные номера (ТЗ §10, В-35: Mango Office / МТС Exolve, провайдер не выбран). Реальные номера сторон не раскрываются.
 */
export interface TelephonyProvider {
  readonly name: string;
  allocate(input: { callerPhone: string; calleePhone: string; ttlSec: number; record: boolean }): Promise<{ virtualNumber: string; sessionId: string }>;
}
export const TELEPHONY_PROVIDER = Symbol('TELEPHONY_PROVIDER');

/** ТЕСТОВЫЙ провайдер: выдаёт условный номер, звонок не совершается. В production запрещён конфигурацией. */
export class DevTelephonyProvider implements TelephonyProvider {
  readonly name = 'dev';
  async allocate(): Promise<{ virtualNumber: string; sessionId: string }> {
    return { virtualNumber: `+7900${String(randomInt(0, 10_000_000)).padStart(7, '0')}`, sessionId: `devcall_${randomUUID()}` };
  }
}
