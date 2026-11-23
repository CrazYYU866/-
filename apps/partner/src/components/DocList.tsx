import { Card, Pill, space, T } from '@kovsh/mobile';
import { View } from 'react-native';
import { FileButton } from './FileButton';

export interface DocReq { code: string; title: string; required: boolean; status: 'missing' | 'uploaded' | 'approved' | 'rejected' | 'expired'; rejectionReason?: string | null }
const DOC_STATUS = {
  missing: { label: 'Нет', tone: 'neutral' },
  uploaded: { label: 'На проверке', tone: 'info' },
  approved: { label: 'Принят', tone: 'success' },
  rejected: { label: 'Отклонён', tone: 'danger' },
  expired: { label: 'Истёк срок', tone: 'warning' },
} as const;

/** Список требуемых документов со статусами и загрузкой (В-32). */
export function DocList({ items, onUpload, readOnly }: { items: DocReq[]; onUpload: (code: string, fileId: string) => Promise<unknown>; readOnly?: boolean }) {
  return (
    <View style={{ gap: space.sm }}>
      {items.map((d) => {
        const st = DOC_STATUS[d.status] ?? DOC_STATUS.missing;
        return (
          <Card key={d.code}>
            <View style={{ flexDirection: 'row', gap: space.sm, justifyContent: 'space-between' }}>
              <T style={{ flex: 1 }}>{d.title}{d.required ? '' : ' (необязательно)'}</T>
              <Pill label={st.label} tone={st.tone} />
            </View>
            {d.rejectionReason && d.status === 'rejected' ? <T v="small" muted>Причина: {d.rejectionReason}</T> : null}
            {!readOnly && d.status !== 'approved' ? <FileButton title={d.status === 'missing' ? 'Загрузить' : 'Загрузить заново'} onUploaded={(fileId) => onUpload(d.code, fileId)} /> : null}
          </Card>
        );
      })}
    </View>
  );
}
