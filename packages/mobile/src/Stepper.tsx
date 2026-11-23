import { Pressable, StyleSheet, View } from 'react-native';
import { radius, space, useTheme } from './theme';
import { T } from './ui';

export function Stepper({ value, onChange, min, max, step = 1, format, label }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string; label?: string }) {
  const t = useTheme();
  const btn = (delta: number, sign: string) => {
    const next = value + delta;
    const off = next < min || next > max;
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${label ?? ''} ${sign}`} disabled={off} onPress={() => onChange(next)}
        style={[s.btn, { backgroundColor: t.surfaceAlt, opacity: off ? 0.35 : 1 }]}>
        <T v="h3">{sign}</T>
      </Pressable>
    );
  };
  return (
    <View style={s.wrap}>
      {btn(-step, '−')}
      <T style={s.value}>{format ? format(value) : value}</T>
      {btn(step, '+')}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  btn: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  value: { minWidth: 64, textAlign: 'center', fontWeight: '600' },
});
