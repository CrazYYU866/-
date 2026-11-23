import { api, Button, Card, ErrorView, Loading, Notice, Pill, post, space, T, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useOrg } from '../../lib/org';
import { UNIT_STATUS, type Unit } from '../../lib/units';

/** Автопарк: техника на линии получает предложения заказов (ТЗ §5). */
export default function Fleet() {
  const t = useTheme();
  const { current } = useOrg();
  const q = useQuery({ queryKey: ['units', current?.orgId], queryFn: () => api<Unit[]>('/partner/equipment') });
  const units = (q.data ?? []).filter((u) => !u.archived);
  const online = units.filter((u) => u.isOnline).length;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={s.body} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data ? <T muted>На линии {online} из {units.length}. Заказы предлагаются только технике на линии.</T> : null}
      {units.map((u) => <UnitRow key={u.id} unit={u} />)}
      <Button title="Добавить технику" onPress={() => router.push('/unit/new')} />
    </ScrollView>
  );
}

function UnitRow({ unit: u }: { unit: Unit }) {
  const t = useTheme();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => post(`/partner/equipment/${u.id}/${u.isOnline ? 'offline' : 'online'}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['units'] }),
  });
  const st = UNIT_STATUS[u.verificationStatus];
  return (
    <Card onPress={() => router.push({ pathname: '/unit/[id]', params: { id: u.id } })}>
      <View style={s.row}>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="h3">{u.brand} {u.model}</T>
          <T muted>{u.categoryName}{u.regNumber ? ` · ${u.regNumber}` : ''}</T>
        </View>
        {u.verificationStatus === 'approved' ? (
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: u.isOnline, busy: toggle.isPending }} accessibilityLabel="На линии" onPress={() => toggle.mutate()} hitSlop={8}
            style={[s.switch, { backgroundColor: u.isOnline ? t.success : t.border }]}>
            <View style={[s.knob, { backgroundColor: t.surface, alignSelf: u.isOnline ? 'flex-end' : 'flex-start' }]} />
          </Pressable>
        ) : <Pill label={st.label} tone={st.tone} />}
      </View>
      {u.verificationStatus === 'approved' ? <T v="small" style={{ color: u.isOnline ? t.success : t.textMuted, fontWeight: '600' }}>{u.isOnline ? 'На линии — получает заказы' : 'Не на линии'}</T> : null}
      {toggle.error ? <Notice tone="danger">{(toggle.error as Error).message}</Notice> : null}
    </Card>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 12, width: '100%', maxWidth: 640, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  switch: { width: 56, height: 32, borderRadius: 16, padding: 3, justifyContent: 'center' },
  knob: { width: 26, height: 26, borderRadius: 13 },
});
