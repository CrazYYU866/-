import { haversineMeters, type LatLng, type RouteResult, type RoutingProvider } from './routing.provider';

/**
 * ТЕСТОВЫЙ провайдер для разработки и демонстрации, пока нет ключа Яндекс Маршрутизации.
 * Расстояние = прямая × 1,3 (поправка на дороги), скорость 40 км/ч. В production запрещён конфигурацией.
 */
export class DevRoutingProvider implements RoutingProvider {
  static readonly ROAD_FACTOR = 1.3;
  static readonly SPEED_KMH = 40;

  async route(from: LatLng, to: LatLng): Promise<RouteResult> {
    const distanceMeters = Math.round(haversineMeters(from, to) * DevRoutingProvider.ROAD_FACTOR);
    return {
      distanceMeters,
      durationSeconds: Math.round((distanceMeters / 1000 / DevRoutingProvider.SPEED_KMH) * 3600),
      provider: 'dev',
    };
  }
}
