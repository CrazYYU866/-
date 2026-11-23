import { api, auth, Button, Card, Choice, Field, Notice, post, Screen, Section, T, normalizePhone } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { ROLE_LABEL, useOrg, type Role } from '../lib/org';

interface Invitation { memberId: string; orgId: string; orgName: string; role: Role }

const LEGAL_FORMS = [
  { value: 'ip', label: 'ИП' },
  { value: 'llc', label: 'ООО' },
  { value: 'jsc', label: 'АО' },
  { value: 'other_legal_entity', label: 'Другое юрлицо' },
] as const;

/** Нет компании: принять приглашение (сотрудник, машинист) или зарегистрировать свою (ИП/ЮЛ). */
export default function Welcome() {
  const qc = useQueryClient();
  const org = useOrg();
  const inv = useQuery({ queryKey: ['invitations'], queryFn: () => api<Invitation[]>('/partner/invitations', { noOrg: true }) });
  const accept = useMutation({
    mutationFn: (id: string) => post(`/partner/invitations/${id}/accept`),
    onSuccess: () => org.refresh(),
  });
  const decline = useMutation({ mutationFn: (id: string) => post(`/partner/invitations/${id}/decline`), onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }) });
  type Form = { kind: string; legalForm: string; name: string; representativeName: string; inn: string; ogrn: string; kpp: string; legalAddress: string; email: string; contactPhone: string };
  const [form, setForm] = useState<null | Form>(null);
  const create = useMutation({
    mutationFn: () => post<{ id: string }>('/partner/organizations', {
      kind: form!.kind, legalForm: form!.legalForm, name: form!.name.trim(), representativeName: form!.representativeName.trim(),
      inn: form!.inn, ogrn: form!.ogrn, kpp: form!.kpp || undefined, legalAddress: form!.legalAddress.trim(), email: form!.email.trim(),
      contactPhone: normalizePhone(form!.contactPhone),
    }),
    onSuccess: async (o) => { await org.select(o.id); await org.refresh(); },
  });
  const set = (k: keyof Form) => (v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <Screen>
      <View style={{ gap: 4 }}>
        <T v="h2">Добро пожаловать</T>
        <T muted>Если вас пригласила компания — примите приглашение. Владельцы техники и независимые диспетчеры регистрируют свою компанию.</T>
      </View>
      {inv.data?.map((i) => (
        <Card key={i.memberId} accent>
          <T style={{ fontWeight: '600' }}>{i.orgName}</T>
          <T muted>Приглашает вас: {ROLE_LABEL[i.role].toLowerCase()}</T>
          <Button title="Принять" loading={accept.isPending} onPress={() => accept.mutate(i.memberId)} />
          <Button kind="ghost" title="Отклонить" onPress={() => decline.mutate(i.memberId)} />
        </Card>
      ))}
      {accept.error ? <Notice tone="danger">{(accept.error as Error).message}</Notice> : null}

      {!form ? (
        <Button kind="secondary" title="Зарегистрировать компанию" onPress={() => setForm({ kind: 'partner', legalForm: 'ip', name: '', representativeName: '', inn: '', ogrn: '', kpp: '', legalAddress: '', email: '', contactPhone: auth.current?.user.phone ?? '' })} />
      ) : (
        <Section title="Новая компания">
          <Choice value={form.kind} onChange={set('kind')} options={[
            { value: 'partner', label: 'У меня есть техника', hint: 'ИП или компания: техника, машинисты, приём заказов' },
            { value: 'agent', label: 'Я независимый диспетчер', hint: 'Оформляю заявки за заказчиков, вознаграждение 7%' },
          ]} />
          <Choice value={form.legalForm} onChange={set('legalForm')} options={LEGAL_FORMS.map((f) => ({ value: f.value, label: f.label }))} />
          <Field label="Название" value={form.name} onChangeText={set('name')} placeholder={form.legalForm === 'ip' ? 'ИП Иванов Иван Иванович' : 'ООО «Ромашка»'} />
          <Field label="ФИО руководителя" value={form.representativeName} onChangeText={set('representativeName')} />
          <Field label="ИНН" value={form.inn} onChangeText={(v) => set('inn')(v.replace(/\D/g, '').slice(0, 12))} keyboardType="number-pad" />
          <Field label={form.legalForm === 'ip' ? 'ОГРНИП' : 'ОГРН'} value={form.ogrn} onChangeText={(v) => set('ogrn')(v.replace(/\D/g, '').slice(0, 15))} keyboardType="number-pad" />
          {form.legalForm !== 'ip' ? <Field label="КПП" value={form.kpp} onChangeText={(v) => set('kpp')(v.replace(/\D/g, '').slice(0, 9))} keyboardType="number-pad" /> : null}
          <Field label="Юридический адрес" value={form.legalAddress} onChangeText={set('legalAddress')} />
          <Field label="Email" value={form.email} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" />
          <Field label="Контактный телефон" value={form.contactPhone} onChangeText={set('contactPhone')} keyboardType="phone-pad" />
          {create.error ? <Notice tone="danger">{(create.error as Error).message}</Notice> : null}
          <Button title="Создать компанию" loading={create.isPending} onPress={() => create.mutate()} />
          <T v="small" muted>Дальше загрузите документы и отправьте компанию на проверку. Принимать заказы можно после подтверждения.</T>
        </Section>
      )}
      <Button kind="ghost" title="Выйти" onPress={() => auth.set(null)} />
    </Screen>
  );
}
