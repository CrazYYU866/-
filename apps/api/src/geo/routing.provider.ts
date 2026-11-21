export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResult {
  distanceMeters: number;
  /** Время в пути с учётом пробок (секунды). */
  durationSeconds: number;
  provider: string;
}

/**
 * Маршрутизация по автодорогам (ТЗ §13: расстояние по маршруту, не по прямой; П-19: Яндекс Маршрутизация).
 * Бизнес-логика зависит только от интерфейса; провайдер подключается конфигурацией.
 */
export interface RoutingProvider {
  route(from: LatLng, to: LatLng, departAt?: Date): Promise<RouteResult>;
}
export const ROUTING = Symbol('ROUTING');

/** Расстояние по прямой (м). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
