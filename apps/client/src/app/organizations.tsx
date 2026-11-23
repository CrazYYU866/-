import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Field, Notice, Pill, Screen, Section, T } from '@kovsh/mobile';
import { api, post } from '@kovsh/mobile';
import { normalizePhone } from '@kovsh/mobile';
import { space } from '@kovsh/mobile';

interface Org { id: string; name: string; inn: string; kpp: string | null; legal_address: string; email: string; role: 'owner' | 'employee' }
interface Invitation { id: string; name: string; inn: string }
interface Member { id: string; phone: string; full_name: string | null; role: string; status: string }

const EMPTY = { inn: '', kpp: '', name: '', legalAddress: '', email: '' };

export default function Organizations() {
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api<Org[]>('/client/organizations') });
  const invites = useQuery({ queryKey: ['org-invites'], queryFn: () => api<Invitation[]>('/client/organization-invitations') });
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['orgs'] });
    qc.invalidateQueries({ queryKey: ['org-invites'] });
  };
  const add = useMutation({
    mutationFn: () => post('/client/organizations', { ...form!, kpp: form!.kpp || undefined }),
    onSuccess: () => { setForm(null); refresh(); },
  });
  const accept = useMutation({ mutationFn: (id: string) => post(`/client/organization-invitations/${id}/accept`), onSuccess: refresh });

  return (
    <Screen>
      {invites.data?.map((i) => (
        <Card key={i.id} accent>
          <T style={{ fontWeight: '600' }}>Вас пригласили в «{i.name}»</T>
          <T v="small" muted>ИНН {i.inn}. Вы сможете заказывать технику от имени организации.</T>
          <Button small title="Принять приглашение" loading={accept.isPending} onPress={() => accept.mutate(i.id)} />
        </Card>
      ))}

      {orgs.data?.map((o) => <OrgCard key={o.id} org={o} />)}
      {orgs.data && !orgs.data.length && !form ? (
        <T muted>Организаций пока нет. Добавьте свою — или попросите руководителя пригласить вас по номеру телефона.</T>
      ) : null}

      {form ? (
        <Card>
          <T v="h3">Новая организация</T>
          <Field label="ИНН" value={form.inn} onChangeText={(v) => setForm({ ...form, inn: v.replace(/\D/g, '').slice(0, 12) })} keyboardType="number-pad" />
          <Field label="КПП (для юрлиц)" value={form.kpp} onChangeText={(v) => setForm({ ...form, kpp: v.replace(/\D/g, '').slice(0, 9) })} keyboardType="number-pad" />
          <Field label="Название" value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} placeholder="ООО «Ромашка»" />
          <Field label="Юридический адрес" value={form.legalAddress} onChangeText={(v) => setForm({ ...form, legalAddress: v })} />
          <Field label="Email для счетов и документов" value={form.email} onChangeText={(v) => setForm({ ...form, email: v.trim() })} keyboardType="email-address" autoCapitalize="none" />
          {add.error ? <Notice tone="danger">{(add.error as Error).message}</Notice> : null}
          <Button title="Добавить" loading={add.isPending} disabled={!form.inn || !form.name || !form.legalAddress || !form.email} onPress={() => add.mutate()} />
          <Button kind="ghost" title="Отмена" onPress={() => setForm(null)} />
        </Card>
      ) : (
        <Button kind="secondary" title="Добавить организацию" onPress={() => setForm(EMPTY)} />
      )}
    </Screen>
  );
}

function OrgCard({ org }: { org: Org }) {
  const qc = useQueryClient();
  const owner = org.role === 'owner';
  const members = useQuery({ queryKey: ['org-members', org.id], enabled: owner, queryFn: () => api<Member[]>(`/client/organizations/${org.id}/members`) });
  const [phone, setPhone] = useState('');
  const invite = useMutation({
    mutationFn: () => post(`/client/organizations/${org.id}/members`, { phone: normalizePhone(phone) }),
    onSuccess: () => { setPhone(''); qc.invalidateQueries({ queryKey: ['org-members', org.id] }); },
  });
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
        <T v="h3" style={{ flex: 1 }}>{org.name}</T>
        <Pill label={owner ? 'Руководитель' : 'Сотрудник'} tone={owner ? 'accent' : 'neutral'} />
      </View>
      <T v="small" muted>ИНН {org.inn}{org.kpp ? ` · КПП ${org.kpp}` : ''}</T>
      <T v="small" muted>{org.legal_address}</T>
      {owner ? (
        <Section title="Сотрудники">
          {members.data?.filter((m) => m.status !== 'removed').map((m) => (
            <T key={m.id} v="small">{m.full_name ?? m.phone} · {m.role === 'owner' ? 'руководитель' : m.status === 'invited' ? 'приглашён' : 'сотрудник'}</T>
          ))}
          <Field placeholder="+7 900 000-00-00" value={phone} onChangeText={setPhone} keyboardType="phone-pad" hint="Сотрудник сможет оформлять заказы от организации" />
          {invite.error ? <Notice tone="danger">{(invite.error as Error).message}</Notice> : null}
          <Button small kind="secondary" title="Пригласить" disabled={phone.replace(/\D/g, '').length < 10} loading={invite.isPending} onPress={() => invite.mutate()} />
        </Section>
      ) : null}
    </Card>
  );
}
