import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field, Notice, T } from './ui';
import Constants from 'expo-constants';
import { API_NOT_CONFIGURED, API_URL, ApiError, auth, currentApp, post, type Session } from './api';
import { maskPhone, normalizePhone } from './format';
import { font, radius, space, useTheme } from './theme';

export function LoginScreen({ title, subtitle }: { title: string; subtitle: string }) {
  const t = useTheme();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  const digits = phone.replace(/\D/g, '');
  const phoneOk = digits.length === 11;

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ resendAfterSec: number }>('/auth/otp/request', { phone: normalizePhone(phone), app: currentApp() });
      setStep('code');
      setCode('');
      setResendIn(r.resendAfterSec);
      setTimeout(() => codeRef.current?.focus(), 100);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить код');
    } finally {
      setBusy(false);
    }
  }

  async function verify(value = code) {
    if (value.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const s = await post<Session>('/auth/otp/verify', { phone: normalizePhone(phone), app: currentApp(), code: value });
      await auth.set(s);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось войти');
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.wrap}>
        <View style={s.brand}>
          <View style={[s.logo, { backgroundColor: t.accent }]}><T style={s.logoText}>К</T></View>
          <T v="title" center>{title}</T>
          <T muted center>{subtitle}</T>
        </View>

        {step === 'phone' ? (
          <View style={s.form}>
            <Field
              label="Номер телефона"
              value={phone}
              onChangeText={(v) => setPhone(maskPhone(v))}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              placeholder="+7 (900) 000-00-00"
              onSubmitEditing={() => phoneOk && requestCode()}
            />
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Button title="Получить код" onPress={requestCode} disabled={!phoneOk} loading={busy} />
          </View>
        ) : (
          <View style={s.form}>
            <T muted>Код отправлен на {maskPhone(phone)}</T>
            <TextInput
              ref={codeRef}
              value={code}
              onChangeText={(v) => {
                const d = v.replace(/\D/g, '').slice(0, 6);
                setCode(d);
                if (d.length === 6) verify(d);
              }}
              keyboardType="number-pad"
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              maxLength={6}
              placeholder="••••••"
              placeholderTextColor={t.textMuted}
              accessibilityLabel="Код из SMS"
              style={[s.code, { color: t.text, borderColor: t.border, backgroundColor: t.surface }]}
            />
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Button title="Войти" onPress={() => verify()} disabled={code.length < 4} loading={busy} />
            <View style={s.links}>
              <Button kind="ghost" small title="Изменить номер" onPress={() => { setStep('phone'); setError(null); }} />
              <Button kind="ghost" small title={resendIn > 0 ? `Отправить снова через ${resendIn} с` : 'Отправить код снова'} disabled={resendIn > 0 || busy} onPress={requestCode} />
            </View>
          </View>
        )}
        {API_NOT_CONFIGURED ? <Notice tone="danger">Сборка без адреса сервера (EXPO_PUBLIC_API_URL). Обратитесь к разработчику.</Notice> : null}
        <T v="small" muted center>Версия {Constants.expoConfig?.version ?? '—'}{API_URL ? ` · ${API_URL.replace(/^https?:\/\//, '')}` : ''}</T>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.xxl, width: '100%', maxWidth: 440, alignSelf: 'center' },
  brand: { alignItems: 'center', gap: space.sm },
  logo: { width: 72, height: 72, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  logoText: { fontSize: 36, fontWeight: '800', color: '#121417' },
  form: { gap: space.md },
  code: { height: 64, borderWidth: 1, borderRadius: radius.md, fontSize: font.size.xxl, letterSpacing: 12, textAlign: 'center', fontWeight: '600' },
  links: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap' },
});
