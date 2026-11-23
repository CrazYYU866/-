import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '@kovsh/mobile';
import { ErrorView, Loading, Notice, T } from '@kovsh/mobile';
import { api, auth, post } from '@kovsh/mobile';
import { time } from '@kovsh/mobile';
import { useOrderRealtime } from '@kovsh/mobile';
import { font, radius, space, useTheme } from '@kovsh/mobile';

interface Msg { id: number | string; sender_user_id: string | null; sender_role: string; sender_name: string | null; body: string; created_at: string }
const ROLE: Record<string, string> = { customer: 'Вы', operator: 'Машинист', partner: 'Исполнитель', admin: 'Поддержка', system: 'Сервис' };

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const qc = useQueryClient();
  useOrderRealtime(id);
  const me = auth.current?.user.id;
  const q = useQuery({ queryKey: ['chat', id], queryFn: () => api<Msg[]>(`/client/orders/${id}/chat`), refetchInterval: 15_000 });
  const [text, setText] = useState('');
  const list = useRef<FlatList<Msg>>(null);
  const send = useMutation({
    mutationFn: (body: string) => post<Msg>(`/client/orders/${id}/chat`, { body }),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['chat', id] }); },
  });
  const last = q.data?.[q.data.length - 1]?.id;
  useEffect(() => {
    if (last) post(`/client/orders/${id}/chat/read`, { lastReadId: Number(last) }).catch(() => undefined);
  }, [id, last]);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        {q.isLoading ? <Loading /> : null}
        {q.error ? <View style={{ padding: space.lg }}><ErrorView error={q.error} onRetry={() => q.refetch()} /></View> : null}
        <FlatList
          ref={list}
          data={q.data ?? []}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={s.list}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={q.isSuccess ? <T muted center>Здесь можно договориться с машинистом о деталях. Переписка сохраняется в заказе.</T> : undefined}
          renderItem={({ item: m }) => {
            const mine = m.sender_user_id === me;
            return (
              <View style={[s.bubble, mine ? { alignSelf: 'flex-end', backgroundColor: t.accent } : { alignSelf: 'flex-start', backgroundColor: t.surface, borderColor: t.border, borderWidth: 1 }]}>
                {!mine ? <T v="small" style={{ fontWeight: '600' }}>{m.sender_name ?? ROLE[m.sender_role] ?? ''}{m.sender_role !== 'operator' && ROLE[m.sender_role] ? ` · ${ROLE[m.sender_role]}` : ''}</T> : null}
                <T style={mine ? { color: t.accentText } : undefined}>{m.body}</T>
                <T v="small" style={{ color: mine ? t.accentText : t.textMuted, opacity: 0.7, alignSelf: 'flex-end' }}>{time(m.created_at)}</T>
              </View>
            );
          }}
        />
        {send.error ? <View style={{ paddingHorizontal: space.lg }}><Notice tone="danger">{(send.error as Error).message}</Notice></View> : null}
        <View style={[s.composer, { borderTopColor: t.border, backgroundColor: t.surface }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Сообщение"
            placeholderTextColor={t.textMuted}
            multiline
            style={[s.input, { color: t.text, backgroundColor: t.surfaceAlt }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Отправить" disabled={!text.trim() || send.isPending} onPress={() => send.mutate(text.trim())}
            style={[s.send, { backgroundColor: t.accent, opacity: !text.trim() || send.isPending ? 0.4 : 1 }]}>
            <Icon name="send" color={t.accentText} size={20} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, gap: space.sm, flexGrow: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, padding: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10, fontSize: font.size.md },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
