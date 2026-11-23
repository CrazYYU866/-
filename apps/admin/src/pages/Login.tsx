import { useState } from 'react';
import { api, ApiError, loadSession, saveSession, type Session } from '../api';
import { ErrorBox } from '../components/ui';

/** Вход по email и паролю; двухфакторная авторизация обязательна (С-9): подключение при первом входе, код — при каждом. */
export function LoginPage() {
  const pending = loadSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string } | null>(null);

  if (pending?.mustEnrollTotp) {
    return (
      <div className="login"><div className="card">
        <h1>Подключите 2FA</h1>
        <p className="muted">Двухфакторная авторизация обязательна для всех администраторов. Добавьте ключ в приложение-аутентификатор (Google Authenticator, Яндекс Ключ и т. п.) и введите код.</p>
        {!enroll ? (
          <button className="primary" onClick={async () => { try { setEnroll(await api('/admin/auth/2fa/setup', { method: 'POST' })); } catch (e) { setError(e); } }}>Получить ключ</button>
        ) : (
          <>
            <label className="field">Ключ для ручного ввода<div className="mono">{enroll.secret}</div></label>
            <label className="field">Ссылка для приложения<div className="mono">{enroll.otpauthUrl}</div></label>
            <label className="field">Код из приложения<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} /></label>
            <button className="primary" onClick={async () => {
              try {
                await api('/admin/auth/2fa/confirm', { method: 'POST', body: { code } });
                saveSession({ ...pending, mustEnrollTotp: false, admin: { ...pending.admin, totpEnabled: true } });
              } catch (e) { setError(e); }
            }}>Подтвердить</button>
          </>
        )}
        <ErrorBox error={error} />
        <button className="ghost" onClick={() => saveSession(null)}>Выйти</button>
      </div></div>
    );
  }

  return (
    <div className="login">
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const s = await api<Session>('/admin/auth/login', { method: 'POST', body: { email, password, ...(needCode ? { totpCode: code } : {}) } });
          saveSession(s);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') setNeedCode(true);
          else setError(err);
        }
      }}>
        <div className="brand" style={{ color: 'var(--text)', padding: 0 }}><span className="brand-mark">К</span>Ковш на Час</div>
        <h1>Вход в админку</h1>
        <label className="field">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label className="field">Пароль<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {needCode && <label className="field">Код из приложения-аутентификатора<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} autoFocus /></label>}
        <ErrorBox error={error} />
        <button className="primary" type="submit">Войти</button>
      </form>
    </div>
  );
}
