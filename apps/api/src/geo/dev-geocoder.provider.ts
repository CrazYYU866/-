import { Logger } from '@nestjs/common';
import type { LatLng } from './routing.provider';
import type { GeocodeResult, GeocoderProvider } from './geocoder.provider';

/**
 * ТЕСТОВЫЙ геокодер — только для разработки и показа (запрещён в production, см. env.ts).
 * Ищет по короткому встроенному списку адресов и понимает ввод координат «55.75, 37.62».
 * Это не справочник адресов: реальные подсказки появятся с ключом Яндекса.
 */
const DEMO_ADDRESSES: GeocodeResult[] = [
  { address: 'Москва, ул. Варварка, 14', lat: 55.7516, lng: 37.6303 },
  { address: 'Москва, Ленинский пр-т, 30', lat: 55.7069, lng: 37.5856 },
  { address: 'Москва, ул. Профсоюзная, 65', lat: 55.6596, lng: 37.5497 },
  { address: 'Москва, Варшавское ш., 118', lat: 55.6175, lng: 37.6066 },
  { address: 'Москва, ул. Вилиса Лациса, 2', lat: 55.8457, lng: 37.4282 },
  { address: 'Москва, Щёлковское ш., 75', lat: 55.8104, lng: 37.7988 },
  { address: 'Москва, Рязанский пр-т, 86', lat: 55.7172, lng: 37.7926 },
  { address: 'Москва, ул. Мосфильмовская, 70', lat: 55.7128, lng: 37.4987 },
  { address: 'МО, Химки, Ленинградское ш., 25', lat: 55.8889, lng: 37.4447 },
  { address: 'МО, Красногорск, ул. Ленина, 4', lat: 55.8204, lng: 37.3302 },
  { address: 'МО, Мытищи, Олимпийский пр-т, 13', lat: 55.9116, lng: 37.7336 },
  { address: 'МО, Балашиха, ш. Энтузиастов, 1', lat: 55.7963, lng: 37.9382 },
  { address: 'МО, Подольск, ул. Кирова, 50', lat: 55.4312, lng: 37.5443 },
  { address: 'МО, Одинцово, ул. Маршала Жукова, 10', lat: 55.6781, lng: 37.2778 },
  { address: 'МО, Люберцы, Октябрьский пр-т, 190', lat: 55.6766, lng: 37.8933 },
];

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export class DevGeocoderProvider implements GeocoderProvider {
  readonly name = 'dev';
  private readonly logger = new Logger('DevGeocoder');

  constructor() {
    this.logger.warn('Тестовый геокодер: встроенный список адресов. Не использовать для реальных заказов.');
  }

  async suggest(query: string): Promise<GeocodeResult[]> {
    const m = COORDS.exec(query);
    if (m) {
      const point = { lat: Number(m[1]), lng: Number(m[2]) };
      return [{ ...point, address: `Точка ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`, hint: 'координаты' }];
    }
    const words = query.toLowerCase().replace(/ё/g, 'е').split(/[\s,.]+/).filter((w) => w.length >= 2);
    if (!words.length) return [];
    const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
    return DEMO_ADDRESSES.filter((a) => words.every((w) => norm(a.address).includes(w)))
      .slice(0, 8)
      .map((a) => ({ ...a, hint: 'тестовый адрес' }));
  }

  async reverse(point: LatLng): Promise<GeocodeResult | null> {
    return { ...point, address: `Точка ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`, hint: 'адрес уточните в комментарии' };
  }
}
