import { Redirect } from 'expo-router';
import { can, useOrg } from '../../lib/org';

/** Стартовая вкладка по роли: диспетчер — предложения, машинист — смены, диспетчер-агент — заявки. */
export default function Start() {
  const c = can(useOrg().current);
  if (c.dispatch) return <Redirect href="/offers" />;
  if (c.operate) return <Redirect href="/shifts" />;
  if (c.agent) return <Redirect href="/agent" />;
  return <Redirect href="/company" />;
}
