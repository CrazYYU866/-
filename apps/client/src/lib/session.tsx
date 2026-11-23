import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth, type Session } from './api';

const Ctx = createContext<{ session: Session | null; ready: boolean }>({ session: null, ready: false });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ session: Session | null; ready: boolean }>({ session: null, ready: false });
  useEffect(() => {
    auth.load().then((s) => setState({ session: s, ready: true }));
    return auth.subscribe((s) => setState({ session: s, ready: true }));
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
