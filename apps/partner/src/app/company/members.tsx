import { api, Button, Card, Choice, confirmAction, Field, maskPhone, normalizePhone, Notice, Pill, post, Screen, Section, space, T } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { DocList, type DocReq } from '../../components/DocList';
import { can, ROLE_LABEL, useOrg, type Role } from '../../lib/org';

interface Member { id: string; userId: string; fullName: string | null; phone: string; role: Role; canOperate: boolean; status: 'invited' | 'active' | 'blocked' | 'detached'; operatorVerification: 'not_submitted' | 'pending' | 'approved' | 'rejected' }
const VERIFY = { not_submitted: { label: 'Документы не загружены', tone: 'warning' }, pending: { label: 'Документы на проверке', tone: 'info' }, approved: { label: 'Машинист проверен', tone: 'success' }, rejected: { label: 'Документы отклонены', tone: 'danger' } } as const;

/** Сотрудники (Р-2, Р-11, Р-14): приглашение по телефону, роли, работа машинистом, блокировка и отвязка. */
export default function Members() {
  const qc = useQueryClient();
  const { current } = useOrg();
  const c = can(current);
  const q = useQuery({ queryKey: ['members', current?.orgId], queryFn: () => api<Member[]>('/partner/members') });
  const [form, setForm] = useState<null | { phone: string; role: Exclude<Role, 'owner'>; fullName: string }>(null);
  const invite = useMutation({
    mutationFn: () => post('/partner/members', { phone: normalizePhone(form!.phone), role: form!.role, fullName: form!.fullName.trim() || undefined }),
    onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ['members'] }); },
  });
  const list = (q.data ?? []).filter((m) => m.status !== 'detached');
  return (
    <Screen>
      {list.map((m) => <MemberCard key={m.id} m={m} manage={c.manage} ownerOnly={c.ownerOnly} />)}
      {c.manage ? (form ? (
        <Section title="Пригласить сотрудника">
          <Field label="Телефон" value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" placeholder="+7 900 000-00-00" />
          <Field label="Имя (необязательно)" value={form.fullName} onChangeText={(v) => setForm({ ...form, fullName: v })} />
          <Choice value={form.role} onChange={(role) => setForm({ ...form, role })} options={[
            { value: 'operator', label: 'Машинист', hint: 'Видит только свои смены, отмечает статусы, передаёт GPS в пути' },
            { value: 'dispatcher', label: 'Диспетчер', hint: 'Принимает заказы, назначает машинистов, ведёт автопарк' },
            ...(c.ownerOnly ? [{ value: 'manager' as const, label: 'Руководитель', hint: 'Всё, что диспетчер, плюс сотрудники и финансы' }] : []),
          ]} />
          {invite.error ? <Notice tone="danger">{(invite.error as Error).message}</Notice> : null}
          <Button title="Отправить приглашение" disabled={form.phone.replace(/\D/g, '').length < 10} loading={invite.isPending} onPress={() => invite.mutate()} />
          <Button kind="ghost" title="Отмена" onPress={() => setForm(null)} />
          <T v="small" muted>Сотрудник получит SMS, установит приложение и примет приглашение.</T>
        </Section>
      ) : <Button kind="secondary" title="Пригласить сотрудника" onPress={() => setForm({ phone: '', role: 'operator', fullName: '' })} />) : null}
    </Screen>
  );
}

function MemberCard({ m, manage, ownerOnly }: { m: Member; manage: boolean; ownerOnly: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const done = () => qc.invalidateQueries({ queryKey: ['members'] });
  const act = useMutation({
    mutationFn: (a: { path: string; method?: string; body?: unknown }) => api(`/partner/members/${m.id}/${a.path}`, { method: a.method ?? 'POST', body: a.body ?? {} }),
    onSuccess: done,
  });
  const docs = useQuery({ queryKey: ['member-docs', m.id], enabled: open && m.canOperate, queryFn: () => api<DocReq[] | { requirements: DocReq[] }>(`/partner/members/${m.id}/documents`) });
  const reqs = Array.isArray(docs.data) ? docs.data : docs.data?.requirements ?? [];
  const v = VERIFY[m.operatorVerification];
  const editable = manage && m.role !== 'owner' && (ownerOnly || m.role !== 'manager');
  return (
    <Card onPress={() => setOpen(!open)}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <T style={{ fontWeight: '600' }}>{m.fullName ?? maskPhone(m.phone)}</T>
          <T v="small" muted>{ROLE_LABEL[m.role]}{m.canOperate && m.role !== 'operator' ? ' · работает машинистом' : ''} · {maskPhone(m.phone)}</T>
        </View>
        {m.status !== 'active' ? <Pill label={m.status === 'invited' ? 'Приглашён' : 'Заблокирован'} tone={m.status === 'invited' ? 'info' : 'danger'} /> : null}
      </View>
      {m.canOperate ? <Pill label={v.label} tone={v.tone} /> : null}
      {open ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          {m.canOperate ? <DocList items={reqs} onUpload={async (code, fileId) => { await post(`/partner/members/${m.id}/documents`, { documentTypeCode: code, fileId }); await docs.refetch(); done(); }} /> : null}
          {editable && m.role !== 'operator' ? (
            <Button small kind="secondary" title={m.canOperate ? 'Не работает машинистом' : 'Также работает машинистом'} onPress={() => act.mutate({ path: 'can-operate', method: 'PATCH', body: { canOperate: !m.canOperate } })} />
          ) : null}
          {editable && m.role === 'operator' ? <Button small kind="secondary" title="Сделать диспетчером" onPress={() => act.mutate({ path: 'role', method: 'PATCH', body: { role: 'dispatcher' } })} /> : null}
          {editable && m.role === 'dispatcher' ? <Button small kind="secondary" title="Сделать машинистом" onPress={() => act.mutate({ path: 'role', method: 'PATCH', body: { role: 'operator' } })} /> : null}
          {editable ? <Button small kind="secondary" title={m.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'} onPress={async () => { if (m.status === 'blocked' || (await confirmAction('Заблокировать сотрудника?', 'Он не сможет работать в компании, пока вы его не разблокируете.'))) act.mutate({ path: m.status === 'blocked' ? 'unblock' : 'block' }); }} /> : null}
          {editable ? <Button small kind="danger" title="Отвязать от компании" onPress={async () => { if (await confirmAction('Отвязать от компании?', 'Сотрудник потеряет доступ к компании. Вернуть его можно только новым приглашением.', 'Отвязать')) act.mutate({ path: 'detach' }); }} /> : null}
          {act.error ? <Notice tone="danger">{(act.error as Error).message}</Notice> : null}
        </View>
      ) : null}
    </Card>
  );
}
