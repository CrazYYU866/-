import type { LatLng } from './routing.provider';

export interface GeocodeResult extends LatLng {
  address: string;
  /** Подсказка о точности/источнике для интерфейса. */
  hint?: string;
}

/**
 * Поиск адреса и обратное геокодирование (ТЗ §4: адрес объекта; П-19: сервисы Яндекса).
 * Реальный провайдер (Яндекс Геосаджест/Геокодер) подключается после получения ключа.
 */
export interface GeocoderProvider {
  readonly name: string;
  suggest(query: string, near?: LatLng): Promise<GeocodeResult[]>;
  reverse(point: LatLng): Promise<GeocodeResult | null>;
}
export const GEOCODER = Symbol('GEOCODER');
