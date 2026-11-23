import { api, Screen, T, post } from '@kovsh/mobile';
import { useQuery } from '@tanstack/react-query';
import { DocList, type DocReq } from '../../components/DocList';
import { useOrg } from '../../lib/org';

export default function OrgDocuments() {
  const { current } = useOrg();
  const q = useQuery({ queryKey: ['org', current?.orgId], queryFn: () => api<{ documents: DocReq[] }>('/partner/organizations/current') });
  return (
    <Screen>
      <T muted>Фото или PDF. Документы проверяет модератор; после подтверждения компания может принимать заказы.</T>
      <DocList items={q.data?.documents ?? []} onUpload={async (code, fileId) => { await post('/partner/organizations/current/documents', { documentTypeCode: code, fileId }); await q.refetch(); }} />
    </Screen>
  );
}
