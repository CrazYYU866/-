import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { ErrorView, Loading, Screen, T } from '../../components/ui';
import { api } from '../../lib/api';
import { rub } from '../../lib/format';
import { radius, space, useTheme } from '../../lib/theme';

export interface CatNode { id: string; name: string; description: string | null; isLeaf: boolean; children: CatNode[]; hourPriceKopecks?: number | null }
interface Region { id: string; code: string; name: string }

const leaves = (n: CatNode): CatNode[] => (n.isLeaf ? [n] : n.children.flatMap(leaves));

export default function Catalog() {
  const t = useTheme();
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => api<Region[]>('/catalog/regions') });
  const [regionId, setRegionId] = useState<string | null>(null);
  const region = regionId ?? regions.data?.[0]?.id ?? null;
  const tree = useQuery({
    queryKey: ['catalog', region],
    enabled: Boolean(region),
    queryFn: () => api<CatNode[]>(`/catalog/categories?audience=customer&regionId=${region}`),
  });

  return (
    <Screen>
      <View style={{ gap: space.xs }}>
        <T v="h2">Какая техника нужна?</T>
        <T muted>Цена за час работы с машинистом. Доставка считается по адресу объекта.</T>
      </View>
      {regions.data && regions.data.length > 1 ? (
        <View style={s.chips}>
          {regions.data.map((r) => {
            const on = r.id === region;
            return (
              <Pressable key={r.id} onPress={() => setRegionId(r.id)} accessibilityRole="tab" accessibilityState={{ selected: on }}
                style={[s.chip, { backgroundColor: on ? t.text : t.surface, borderColor: on ? t.text : t.border }]}>
                <T v="small" style={{ color: on ? t.surface : t.text, fontWeight: '600' }}>{r.name}</T>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {tree.isLoading || regions.isLoading ? <Loading /> : null}
      {tree.error || regions.error ? <ErrorView error={tree.error ?? regions.error} onRetry={() => { regions.refetch(); tree.refetch(); }} /> : null}
      {tree.data?.map((group) => {
        const items = leaves(group);
        if (!items.length) return null;
        return (
          <View key={group.id} style={{ gap: space.sm }}>
            <T v="label" muted style={s.groupTitle}>{group.name.toUpperCase()}</T>
            <View style={[s.list, { backgroundColor: t.surface, borderColor: t.border }]}>
              {items.map((c, i) => (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/new-order/[categoryId]', params: { categoryId: c.id, name: c.name } })}
                  style={({ pressed }) => [s.item, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }, pressed && { backgroundColor: t.surfaceAlt }]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <T style={{ fontWeight: '600' }}>{c.name}</T>
                    <T v="small" muted>{c.hourPriceKopecks ? `${rub(c.hourPriceKopecks)} / час` : 'Цена появится после настройки тарифа'}</T>
                  </View>
                  <Icon name="chevron" color={t.textMuted} size={20} />
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm },
  groupTitle: { letterSpacing: 0.6, marginLeft: space.xs },
  list: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 64, gap: space.md },
});
