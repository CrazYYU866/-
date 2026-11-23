import { api, Notice, post, Screen, T } from '@kovsh/mobile';
import { useQuery } from '@tanstack/react-query';
import { DocList, type DocReq } from '../../components/DocList';
import { useOrg } from '../../lib/org';

/** Документы машиниста загружает сам машинист или руководитель компании (С-5). */
export default function MyDocuments() {
  const { current } = useOrg();
  const id = current?.memberId;
  const q = useQuery({ queryKey: ['member-docs', id], enabled: Boolean(id), queryFn: () => api<{ requirements: DocReq[] }>(`/partner/members/${id}/documents`) });
  const missing = (q.data?.requirements ?? []).filter((d) => d.required && d.status === 'missing').length;
  return (
    <Screen>
      <T muted>Без проверенных документов диспетчер не сможет назначить вас на заказ.</T>
      {missing ? <Notice tone="warning">{`Осталось загрузить обязательных документов: ${missing}.`}</Notice> : null}
      {q.error ? <Notice tone="danger">{(q.error as Error).message}</Notice> : null}
      <DocList items={q.data?.requirements ?? []} onUpload={async (code, fileId) => { await post(`/partner/members/${id}/documents`, { documentTypeCode: code, fileId }); await q.refetch(); }} />
    </Screen>
  );
}
