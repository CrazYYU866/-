import * as Location from 'expo-location';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { api } from '../lib/api';
import { radius, space, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, Field, Notice, T } from './ui';

export interface Place { lat: number; lng: number; address: string; hint?: string }

/** Адрес объекта: подсказки через сервер (ключ провайдера не хранится в приложении) или текущее местоположение. */
export function AddressPicker({ value, onChange }: { value: Place | null; onChange: (p: Place | null) => void }) {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  const suggest = useQuery({
    queryKey: ['suggest', debounced],
    enabled: debounced.length >= 2 && !value,
    queryFn: () => api<{ provider: string; items: Place[] }>(`/geo/suggest?q=${encodeURIComponent(debounced)}`),
  });

  async function locate() {
    setLocating(true);
    setLocError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') throw new Error('Нет доступа к геолокации. Введите адрес вручную.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const r = await api<{ item: Place | null }>(`/geo/reverse?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`);
      onChange(r.item ?? { lat: pos.coords.latitude, lng: pos.coords.longitude, address: 'Текущее местоположение' });
    } catch (e) {
      setLocError(e instanceof Error ? e.message : 'Не удалось определить местоположение');
    } finally {
      setLocating(false);
    }
  }

  if (value) {
    return (
      <View style={[s.selected, { borderColor: t.accent, backgroundColor: t.accentSoft }]}>
        <Icon name="pin" color={t.text} />
        <View style={{ flex: 1 }}>
          <T style={{ fontWeight: '600' }}>{value.address}</T>
          {value.hint ? <T v="small" muted>{value.hint}</T> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Изменить адрес" onPress={() => { onChange(null); setQ(''); }} hitSlop={12}>
          <Icon name="close" color={t.textMuted} size={20} />
        </Pressable>
      </View>
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      <Field value={q} onChangeText={setQ} placeholder="Улица, дом или координаты" autoCorrect={false} />
      {suggest.data?.items.length ? (
        <View style={[s.list, { borderColor: t.border, backgroundColor: t.surface }]}>
          {suggest.data.items.map((p, i) => (
            <Pressable key={`${p.lat},${p.lng}`} onPress={() => onChange(p)} accessibilityRole="button"
              style={({ pressed }) => [s.item, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }, pressed && { backgroundColor: t.surfaceAlt }]}>
              <T>{p.address}</T>
              {p.hint ? <T v="small" muted>{p.hint}</T> : null}
            </Pressable>
          ))}
        </View>
      ) : debounced.length >= 2 && suggest.isSuccess ? <T v="small" muted>Ничего не нашли. Уточните адрес.</T> : null}
      {suggest.data?.provider === 'dev' ? <Notice tone="warning">Тестовый режим: подсказки из короткого списка адресов. Реальный поиск подключится с ключом Яндекса.</Notice> : null}
      <Button kind="secondary" small title="Я на объекте — определить местоположение" icon={<Icon name="locate" color={t.text} size={18} />} loading={locating} onPress={locate} />
      {locError ? <Notice tone="danger">{locError}</Notice> : null}
    </View>
  );
}

const s = StyleSheet.create({
  selected: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md },
  list: { borderWidth: 1, borderRadius: radius.md, overflow: 'hidden' },
  item: { paddingHorizontal: space.md, paddingVertical: space.md, gap: 2 },
});
