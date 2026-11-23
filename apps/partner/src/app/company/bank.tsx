import { Button, Field, Notice, post, Screen, T, api } from '@kovsh/mobile';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';

/** Реквизиты для выплат: изменение подтверждается кодом из SMS главному руководителю (Р-6). */
export default function Bank() {
  const qc = useQueryClient();
  const [f, setF] = useState({ bik: '', accountNumber: '', correspondentAccount: '', bankName: '', code: '' });
  const [sent, setSent] = useState(false);
  const digits = (k: keyof typeof f, n: number) => (v: string) => setF({ ...f, [k]: v.replace(/\D/g, '').slice(0, n) });
  const code = useMutation({ mutationFn: () => post('/partner/organizations/current/bank-account/code'), onSuccess: () => setSent(true) });
  const save = useMutation({
    mutationFn: () => api('/partner/organizations/current/bank-account', { method: 'PUT', body: { ...f, bankName: f.bankName.trim() } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org'] }); router.back(); },
  });
  const ok = f.bik.length === 9 && f.accountNumber.length === 20 && f.correspondentAccount.length === 20 && f.bankName.trim().length >= 2;
  return (
    <Screen>
      <T muted>Выплаты за выполненные заказы приходят на этот счёт на следующий день после завершения заказа.</T>
      <Field label="БИК" value={f.bik} onChangeText={digits('bik', 9)} keyboardType="number-pad" />
      <Field label="Название банка" value={f.bankName} onChangeText={(v) => setF({ ...f, bankName: v })} />
      <Field label="Расчётный счёт" value={f.accountNumber} onChangeText={digits('accountNumber', 20)} keyboardType="number-pad" />
      <Field label="Корреспондентский счёт" value={f.correspondentAccount} onChangeText={digits('correspondentAccount', 20)} keyboardType="number-pad" />
      {!sent ? (
        <Button title="Получить код подтверждения" disabled={!ok} loading={code.isPending} onPress={() => code.mutate()} />
      ) : (
        <>
          <Field label="Код из SMS" value={f.code} onChangeText={digits('code', 8)} keyboardType="number-pad" />
          <Button title="Сохранить реквизиты" disabled={!ok || f.code.length < 4} loading={save.isPending} onPress={() => save.mutate()} />
        </>
      )}
      {code.error || save.error ? <Notice tone="danger">{((code.error ?? save.error) as Error).message}</Notice> : null}
    </Screen>
  );
}
