import { api, setOrgId, storage, useSession } from '@kovsh/mobile';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Role = 'owner' | 'manager' | 'dispatcher' | 'operator';
export interface Membership { orgId: string; memberId: string; name: string; kind: 'partner' | 'agent'; status: string; role: Role; canOperate: boolean }

const KEY = 'kovsh.partner.org';
export const ROLE_LABEL: Record<Role, string> = { owner: 'Главный руководитель', manager: 'Руководитель', dispatcher: 'Диспетчер', operator: 'Машинист' };

interface Ctx {
  ready: boolean;
  memberships: Membership[];
  current: Membership | null;
  select: (orgId: string) => Promise<void>;
  refresh: () => Promise<unknown>;
}
const OrgCtx = createContext<Ctx>({ ready: false, memberships: [], current: null, select: async () => undefined, refresh: async () => undefined });

/** Компания, в контексте которой работает пользователь (Р-13). Выбор запоминается на устройстве. */
export function OrgProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['memberships', session?.user.id],
    enabled: Boolean(session),
    queryFn: () => api<Membership[]>('/partner/memberships', { noOrg: true }),
  });
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  useEffect(() => { storage.get(KEY).then(setSaved); }, []);
  const list = q.data ?? [];
  const current = list.find((m) => m.orgId === saved) ?? list[0] ?? null;
  // Заголовок X-Org-Id выставляется синхронно до рендера экранов, использующих компанию.
  setOrgId(current?.orgId ?? null);

  const select = useCallback(async (orgId: string) => {
    await storage.set(KEY, orgId);
    setSaved(orgId);
    setOrgId(orgId);
    qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'memberships' });
  }, [qc]);

  const value = useMemo<Ctx>(() => ({
    ready: !session || (q.isFetched && saved !== undefined),
    memberships: list,
    current,
    select,
    refresh: () => q.refetch(),
  }), [session, q, saved, list, current, select]);
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}

export const useOrg = () => useContext(OrgCtx);

/** Права по роли (Р-2, Р-11, Н-22). */
export function can(m: Membership | null) {
  const role = m?.role;
  const manage = role === 'owner' || role === 'manager';
  return {
    dispatch: m?.kind === 'partner' && (manage || role === 'dispatcher'),
    manage,
    finance: manage,
    operate: m?.kind === 'partner' && Boolean(m?.canOperate),
    agent: m?.kind === 'agent',
    ownerOnly: role === 'owner',
  };
}
