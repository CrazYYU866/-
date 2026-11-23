import { api, AuthImage, Button, Card, ErrorView, Loading, Notice, Pill, post, Row, Section, space, Stepper, T, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { DocList, type DocReq } from '../../components/DocList';
import { FileButton } from '../../components/FileButton';
import { UNIT_STATUS, type Attr, type Unit } from '../../lib/units';

export default function UnitScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['unit', id], queryFn: () => api<Unit>(`/partner/equipment/${id}`) });
  const docs = useQuery({ queryKey: ['unit', id, 'docs'], queryFn: () => api<{ requirements: DocReq[] }>(`/partner/equipment/${id}/documents`) });
  const attrs = useQuery({ queryKey: ['attrs', q.data?.categoryId], enabled: Boolean(q.data), queryFn: () => api<Attr[]>(`/catalog/categories/${q.data!.categoryId}/attributes`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['unit', id] }); qc.invalidateQueries({ queryKey: ['units'] }); };
  const submit = useMutation({ mutationFn: () => post(`/partner/equipment/${id}/submit`), onSuccess: refresh });
  const online = useMutation({ mutationFn: (on: boolean) => post(`/partner/equipment/${id}/${on ? 'online' : 'offline'}`), onSuccess: refresh });
  const [radius, setRadius] = useState<number | null>(null);
  const saveRadius = useMutation({ mutationFn: () => api(`/partner/equipment/${id}`, { method: 'PATCH', body: { workRadiusKm: radius } }), onSuccess: () => { setRadius(null); refresh(); } });
  const delPhoto = useMutation({ mutationFn: (photoId: string) => api(`/partner/equipment/${id}/photos/${photoId}`, { method: 'DELETE' }), onSuccess: refresh });

  if (q.isLoading) return <Loading />;
  const u = q.data;
  if (!u) return <View style={{ padding: space.lg }}><ErrorView error={q.error} onRetry={() => q.refetch()} /></View>;
  const st = UNIT_STATUS[u.verificationStatus];
  const missingRequired = (docs.data?.requirements ?? []).filter((d) => d.required && d.status === 'missing');

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={s.body}>
      <Stack.Screen options={{ title: `${u.brand} ${u.model}` }} />
      <View style={{ gap: 4 }}>
        <Pill label={st.label} tone={st.tone} />
        <T v="h2">{u.brand} {u.model}</T>
        <T muted>{u.categoryName}{u.year ? `, ${u.year} г.` : ''}{u.regNumber ? ` · ${u.regNumber}` : ''}</T>
      </View>
      {u.verificationStatus === 'rejected' && u.rejectionReason ? <Notice tone="danger">{`Проверка не пройдена: ${u.rejectionReason}`}</Notice> : null}
      {u.verificationStatus === 'pending' ? <Notice tone="info">Техника на проверке у модератора. После проверки её можно вывести на линию.</Notice> : null}

      {u.verificationStatus === 'approved' ? (
        <Card accent={u.isOnline}>
          <T v="h3">{u.isOnline ? 'На линии' : 'Не на линии'}</T>
          <T muted>{u.isOnline ? 'Техника получает предложения заказов рядом со стоянкой.' : 'Выведите технику на линию, чтобы получать заказы.'}</T>
          <Button kind={u.isOnline ? 'secondary' : 'primary'} title={u.isOnline ? 'Снять с линии' : 'Выйти на линию'} loading={online.isPending} onPress={() => online.mutate(!u.isOnline)} />
          {online.error ? <Notice tone="danger">{(online.error as Error).message}</Notice> : null}
        </Card>
      ) : null}
      {u.verificationStatus === 'draft' || u.verificationStatus === 'rejected' ? (
        <Card>
          <T muted>{missingRequired.length ? `Загрузите обязательные документы (${missingRequired.length}) и отправьте технику на проверку.` : 'Документы загружены — отправьте технику на проверку.'}</T>
          <Button title="Отправить на проверку" disabled={missingRequired.length > 0} loading={submit.isPending} onPress={() => submit.mutate()} />
          {submit.error ? <Notice tone="danger">{(submit.error as Error).message}</Notice> : null}
        </Card>
      ) : null}

      <Section title="Фото">
        <View style={s.photos}>
          {u.photos.map((p) => (
            <View key={p.id}>
              <AuthImage fileId={p.fileId} style={s.photo} />
              <Pressable accessibilityLabel="Удалить фото" onPress={() => delPhoto.mutate(p.id)} style={[s.del, { backgroundColor: t.surface }]}><T v="small">✕</T></Pressable>
            </View>
          ))}
        </View>
        <FileButton images title="Добавить фото" onUploaded={async (fileId) => { await post(`/partner/equipment/${id}/photos`, { fileId }); refresh(); }} />
      </Section>

      <Section title="Документы">
        <DocList items={docs.data?.requirements ?? []} onUpload={async (code, fileId) => { await post(`/partner/equipment/${id}/documents`, { documentTypeCode: code, fileId }); docs.refetch(); }} />
      </Section>

      <Section title="Стоянка и радиус">
        <Card>
          <T>{u.base.address}</T>
          <Row label="Радиус работы" value={`${radius ?? u.workRadiusKm} км`} />
          <Stepper label="Радиус" value={radius ?? u.workRadiusKm} min={5} max={300} step={5} format={(v) => `${v} км`} onChange={setRadius} />
          {radius !== null ? <Button small title="Сохранить радиус" loading={saveRadius.isPending} onPress={() => saveRadius.mutate()} /> : null}
          <T v="small" muted>{u.allowBeyondRadius ? 'Готов ехать дальше радиуса при расширении поиска.' : 'Заказы — только в пределах радиуса.'}</T>
        </Card>
      </Section>

      {Object.keys(u.attributes).length ? (
        <Section title="Характеристики">
          <Card>
            {Object.entries(u.attributes).map(([k, v]) => { const a = attrs.data?.find((x) => x.key === k); return <Row key={k} label={a ? `${a.label}${a.unit ? `, ${a.unit.label}` : ''}` : k} value={typeof v === 'boolean' ? (v ? 'да' : 'нет') : Array.isArray(v) ? v.join(', ') : String(v)} />; })}
          </Card>
        </Section>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 20, paddingBottom: 64, width: '100%', maxWidth: 640, alignSelf: 'center' },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: { width: 104, height: 104, borderRadius: 10 },
  del: { position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
