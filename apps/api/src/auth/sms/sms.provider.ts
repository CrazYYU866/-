/**
 * Отправка SMS. Реализации подключаются под выбранного провайдера (В-35):
 * SMS.ru или МТС Exolve. Бизнес-логика зависит только от этого интерфейса.
 */
export interface SmsProvider {
  send(phone: string, text: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
