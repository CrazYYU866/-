import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, radius, space, toneColors, useTheme, type Tone } from '../lib/theme';

export function Screen({ children, scroll = true, footer, edges }: { children: ReactNode; scroll?: boolean; footer?: ReactNode; edges?: ('top' | 'bottom')[] }) {
  const t = useTheme();
  const body = scroll ? (
    <ScrollView contentContainerStyle={s.screenBody} keyboardShouldPersistTaps="handled">{children}</ScrollView>
  ) : (
    <View style={[s.screenBody, { flex: 1 }]}>{children}</View>
  );
  return (
    <SafeAreaView edges={edges ?? []} style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={s.column}>
        {body}
        {footer ? <View style={[s.footer, { borderTopColor: t.border, backgroundColor: t.surface }]}>{footer}</View> : null}
      </View>
    </SafeAreaView>
  );
}

export function T({ children, v = 'body', muted, style, center, numberOfLines }: { children: ReactNode; v?: 'title' | 'h2' | 'h3' | 'body' | 'small' | 'label'; muted?: boolean; style?: StyleProp<TextStyle>; center?: boolean; numberOfLines?: number }) {
  const t = useTheme();
  return (
    <Text numberOfLines={numberOfLines} style={[s[v], { color: muted ? t.textMuted : t.text }, center && { textAlign: 'center' }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style, onPress, accent }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accent?: boolean }) {
  const t = useTheme();
  const base = [s.card, { backgroundColor: t.surface, borderColor: accent ? t.accent : t.border }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [base, pressed && { opacity: 0.85 }]}>
      {children}
    </Pressable>
  );
}

export function Button({ title, onPress, kind = 'primary', loading, disabled, small, icon }: { title: string; onPress?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean; disabled?: boolean; small?: boolean; icon?: ReactNode }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.dangerSoft : kind === 'secondary' ? t.surfaceAlt : 'transparent';
  const fg = kind === 'primary' ? t.accentText : kind === 'danger' ? t.danger : t.text;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: loading }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : (
        <View style={s.rowCenter}>
          {icon}
          <Text style={[s.btnText, small && { fontSize: font.size.sm }, { color: fg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }: TextInputProps & { label?: string; hint?: string; error?: string | null }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? <T v="label" muted>{label}</T> : null}
      <TextInput
        placeholderTextColor={t.textMuted}
        {...props}
        style={[s.input, { backgroundColor: t.surface, color: t.text, borderColor: error ? t.danger : t.border }, props.multiline && { minHeight: 88, textAlignVertical: 'top' }, props.style]}
      />
      {error ? <T v="small" style={{ color: t.danger }}>{error}</T> : hint ? <T v="small" muted>{hint}</T> : null}
    </View>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const t = useTheme();
  const c = toneColors(t, tone);
  return (
    <View style={[s.pill, { backgroundColor: c.bg }]}>
      <Text style={[s.pillText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <View style={s.row}>
      <T muted style={{ flexShrink: 1 }}>{label}</T>
      {typeof value === 'string' || typeof value === 'number' ? <T style={[{ textAlign: 'right', flexShrink: 1 }, strong && { fontWeight: '700' }]}>{value}</T> : value}
    </View>
  );
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: space.sm }} />;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: Tone }) {
  const t = useTheme();
  const c = toneColors(t, tone);
  return (
    <View style={[s.notice, { backgroundColor: c.bg }]}>
      {typeof children === 'string' ? <Text style={[s.small, { color: tone === 'accent' ? t.text : c.fg }]}>{children}</Text> : children}
    </View>
  );
}

export function Loading() {
  const t = useTheme();
  return <View style={{ padding: space.xxl, alignItems: 'center' }}><ActivityIndicator color={t.accent} size="large" /></View>;
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <View style={{ gap: space.md }}>
      <Notice tone="danger">{error instanceof Error ? error.message : 'Не удалось загрузить данные'}</Notice>
      {onRetry ? <Button kind="secondary" title="Повторить" onPress={onRetry} /> : null}
    </View>
  );
}

export function Choice<V extends string>({ options, value, onChange }: { options: { value: V; label: string; hint?: string }[]; value: V; onChange: (v: V) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)}
            style={[s.choice, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accentSoft : t.surface }]}>
            <View style={[s.radio, { borderColor: on ? t.accent : t.border }]}>{on ? <View style={[s.radioDot, { backgroundColor: t.accent }]} /> : null}</View>
            <View style={{ flex: 1 }}>
              <T style={{ fontWeight: '600' }}>{o.label}</T>
              {o.hint ? <T v="small" muted>{o.hint}</T> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={s.rowBetween}><T v="h3">{title}</T>{right}</View>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  column: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
  screenBody: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  footer: { padding: space.lg, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  title: { fontSize: font.size.xxl, fontWeight: '700', letterSpacing: -0.3 },
  h2: { fontSize: font.size.xl, fontWeight: '700' },
  h3: { fontSize: font.size.lg, fontWeight: '600' },
  body: { fontSize: font.size.md, lineHeight: 22 },
  small: { fontSize: font.size.sm, lineHeight: 19 },
  label: { fontSize: font.size.sm, fontWeight: '500' },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: space.sm },
  btn: { minHeight: 52, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  btnSmall: { minHeight: 40, paddingHorizontal: space.md },
  btnText: { fontSize: font.size.md, fontWeight: '600' },
  input: { minHeight: 52, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.md, fontSize: font.size.md },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: font.size.xs, fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: 2 },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  notice: { borderRadius: radius.md, padding: space.md },
  choice: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
