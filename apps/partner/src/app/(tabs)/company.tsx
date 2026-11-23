import { auth, Button, Card, maskPhone, Notice, Pill, post, Row, Screen, Section, space, T, useTheme } from '@kovsh/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { api } from '@kovsh/mobile';
import { Icon } from '@kovsh/mobile';
import { can, ROLE_LABEL, useOrg } from '../../lib/org';
import type { DocReq } from '../../components/DocList';

interface OrgView {
  id: string; kind: 'partner' | 'agent'; name: string; inn: string; ogrn: string; kpp: string | null; legalAddress: string; status: string;
  rejectionReason: string | null; blockedReason: string | null; bankAccount: { bankName: string; accountLast4: string } | null; documents: DocReq[];
}
const ORG_STATUS = {
  draft: { label: 'Черновик', tone: 'neutral' }, pending_review: { label: 'На проверке', tone: 'info' }, verified: { label: 'Подтверждена', tone: 'success' },
  rejected: { label: 'Отклонена', tone: 'danger' }, blocked: { label: 'Заблокирована', tone: 'danger' },
} as const;

export default function Company() {
  const t = useTheme();
  const qc = useQueryClient();
  const org = useOrg();
  const c = can(org.current);
  const q = useQuery({ queryKey: ['org', org.current?.orgId], queryFn: () => api<OrgView>('/partner/organizations/current') });
  const submit = useMutation({ mutationFn: () => post('/partner/organizations/current/submit'), onSuccess: () => { q.refetch(); org.refresh(); } });
  const o = q.data;
  const st = o ? ORG_STATUS[o.status as keyof typeof ORG_STATUS] ?? ORG_STATUS.draft : null;
  const missing = (o?.documents ?? []).filter((d) => d.required && d.status === 'missing').length;

  async function logout() {
    try { await post('/auth/logout'); } catch { /* сессию забываем в любом случае */ }
    qc.clear();
    await auth.set(null);
  }

  const link = (title: string, hint: string, href: '/company/documents' | '/company/members' | '/company/bank' | '/company/finance' | '/company/my-documents') => (
    <Pressable key={href} onPress={() => router.push(href)} accessibilityRole="button"
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ flex: 1 }}><T style={{ fontWeight: '600' }}>{title}</T><T v="small" muted>{hint}</T></View>
      <Icon name="chevron" color={t.textMuted} size={20} />
    </Pressable>
  );

  return (
    <Screen>
      {o && st ? (
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
            <T v="h3" style={{ flex: 1 }}>{o.name}</T>
            <Pill label={st.label} tone={st.tone} />
          </View>
          <T v="small" muted>ИНН {o.inn} · ОГРН {o.ogrn}</T>
          <T v="small" muted>Ваша роль: {org.current ? ROLE_LABEL[org.current.role].toLowerCase() : ''}{org.current?.canOperate && org.current.role !== 'operator' ? ', работаете машинистом' : ''}</T>
          {o.status === 'rejected' && o.rejectionReason ? <Notice tone="danger">{`Причина отказа: ${o.rejectionReason}`}</Notice> : null}
          {o.status === 'blocked' ? <Notice tone="danger">{`Компания заблокирована${o.blockedReason ? `: ${o.blockedReason}` : ''}. Обратитесь в поддержку.`}</Notice> : null}
          {o.status === 'pending_review' ? <Notice tone="info">Документы на проверке у модератора. Мы сообщим о результате.</Notice> : null}
          {c.ownerOnly && (o.status === 'draft' || o.status === 'rejected') ? (
            <>
              <T v="small" muted>{missing ? `Осталось загрузить обязательных документов: ${missing}.` : 'Все обязательные документы загружены.'}</T>
              <Button title="Отправить на проверку" disabled={missing > 0} loading={submit.isPending} onPress={() => submit.mutate()} />
              {submit.error ? <Notice tone="danger">{(submit.error as Error).message}</Notice> : null}
            </>
          ) : null}
        </Card>
      ) : null}

      <Card>
        {c.manage ? link('Документы компании', 'Регистрация, ИНН, полномочия руководителя', '/company/documents') : null}
        {c.manage || c.dispatch ? link('Сотрудники', 'Диспетчеры, машинисты, приглашения', '/company/members') : null}
        {c.ownerOnly ? link('Реквизиты для выплат', o?.bankAccount ? `${o.bankAccount.bankName}, счёт •••${o.bankAccount.accountLast4}` : 'Не указаны — выплаты не производятся', '/company/bank') : null}
        {c.finance ? link('Финансы', 'Начисления, баланс, выплаты', '/company/finance') : null}
        {c.operate ? link('Мои документы машиниста', 'Паспорт, удостоверение тракториста-машиниста', '/company/my-documents') : null}
      </Card>

      {org.memberships.length > 1 ? (
        <Section title="Мои компании">
          {org.memberships.map((m) => (
            <Card key={m.orgId} accent={m.orgId === org.current?.orgId} onPress={() => org.select(m.orgId)}>
              <T style={{ fontWeight: '600' }}>{m.name}</T>
              <T v="small" muted>{ROLE_LABEL[m.role]}</T>
            </Card>
          ))}
        </Section>
      ) : null}

      <View style={{ gap: space.xs }}>
        <T v="small" muted center>{auth.current ? maskPhone(auth.current.user.phone) : ''}</T>
        <Button kind="danger" title="Выйти" onPress={logout} />
      </View>
    </Screen>
  );
}
