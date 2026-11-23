import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Field, Notice, Row, Screen, Section, T } from '@kovsh/mobile';
import { api, auth, post } from '@kovsh/mobile';
import { maskPhone, rub } from '@kovsh/mobile';
import { space } from '@kovsh/mobile';

interface Me { id: string; phone: string; fullName: string | null }
interface Debt { id: string; order_id: string; amount_kopecks: string; status: string }
interface Org { id: string; name: string; inn: string; role: string }

export default function Profile() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const debts = useQuery({ queryKey: ['debts'], queryFn: () => api<Debt[]>('/client/debts') });
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api<Org[]>('/client/organizations') });
  const [name, setName] = useState('');
  useEffect(() => setName(me.data?.fullName ?? ''), [me.data?.fullName]);
  const save = useMutation({
    mutationFn: () => api('/me', { method: 'PATCH', body: { fullName: name.trim() } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const openDebts = (debts.data ?? []).filter((d) => d.status === 'open');

  async function logout() {
    try { await post('/auth/logout'); } catch { /* сессию всё равно забываем на устройстве */ }
    qc.clear();
    await auth.set(null);
  }

  return (
    <Screen>
      {openDebts.length ? (
        <Notice tone="danger">
          {`Есть неоплаченная задолженность: ${rub(openDebts.reduce((a, d) => a + Number(d.amount_kopecks), 0))}. Пока она не погашена, новые заказы недоступны.`}
        </Notice>
      ) : null}
      <Card>
        <T v="label" muted>Телефон</T>
        <T v="h3">{me.data ? maskPhone(me.data.phone) : '…'}</T>
        <Field label="Имя" value={name} onChangeText={setName} placeholder="Как к вам обращаться" autoComplete="name" />
        {save.error ? <Notice tone="danger">{(save.error as Error).message}</Notice> : null}
        <Button kind="secondary" title={save.isSuccess && name === me.data?.fullName ? 'Сохранено' : 'Сохранить'} disabled={name.trim().length < 2 || name === me.data?.fullName} loading={save.isPending} onPress={() => save.mutate()} />
      </Card>

      <Section title="Организации">
        <Card onPress={() => router.push('/organizations')}>
          <T muted>
            {orgs.data?.length
              ? orgs.data.map((o) => o.name).join(', ')
              : 'Добавьте организацию, чтобы заказывать технику от юрлица: оплата 50% после принятия заказа и 50% после завершения.'}
          </T>
          <T style={{ fontWeight: '600' }}>Управлять организациями →</T>
        </Card>
      </Section>

      {debts.data?.length ? (
        <Section title="Задолженности">
          <Card>
            {debts.data.map((d) => (
              <Row key={d.id} label={d.status === 'open' ? 'Не оплачено' : d.status === 'paid' ? 'Погашено' : 'Списано'} value={rub(Number(d.amount_kopecks))} />
            ))}
          </Card>
        </Section>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Button kind="danger" title="Выйти" onPress={logout} />
        <T v="small" muted center>Поддержка: напишите в переписке по заказу или через раздел заказа.</T>
      </View>
    </Screen>
  );
}
