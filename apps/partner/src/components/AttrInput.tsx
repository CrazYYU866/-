import { Field, radius, space, T, useTheme } from '@kovsh/mobile';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { Attr } from '../lib/units';

/** Поле характеристики техники по её типу из каталога (этап 4). */
export function AttrInput({ attr, value, onChange }: { attr: Attr; value: unknown; onChange: (v: unknown) => void }) {
  const t = useTheme();
  const label = `${attr.label}${attr.unit ? `, ${attr.unit.label}` : ''}${attr.required ? ' *' : ''}`;
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));
  if (attr.type === 'number' || attr.type === 'integer') {
    return <Field label={label} value={text} keyboardType={attr.type === 'integer' ? 'number-pad' : 'decimal-pad'} onChangeText={(v) => {
      const clean = v.replace(attr.type === 'integer' ? /[^\d]/g : /[^\d.,]/g, '');
      setText(clean);
      const n = Number(clean.replace(',', '.'));
      onChange(clean === '' || Number.isNaN(n) ? undefined : n);
    }} />;
  }
  if (attr.type === 'text') return <Field label={label} value={text} onChangeText={(v) => { setText(v); onChange(v.trim() || undefined); }} />;
  const opts: { label: string; v: unknown }[] = attr.type === 'boolean' ? [{ label: 'Да', v: true }, { label: 'Нет', v: false }] : (attr.options ?? []).map((o) => ({ label: o, v: o }));
  const multi = attr.type === 'multi_enum';
  const selected = (v: unknown) => (multi ? Array.isArray(value) && value.includes(v) : value === v);
  return (
    <View style={{ gap: 6 }}>
      <T v="label" muted>{label}</T>
      <View style={s.chips}>
        {opts.map((o) => {
          const on = selected(o.v);
          return (
            <Pressable key={o.label} accessibilityRole={multi ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }}
              onPress={() => {
                if (!multi) return onChange(on ? undefined : o.v);
                const cur = Array.isArray(value) ? (value as unknown[]) : [];
                const next = on ? cur.filter((x) => x !== o.v) : [...cur, o.v];
                onChange(next.length ? next : undefined);
              }}
              style={[s.chip, { backgroundColor: on ? t.text : t.surface, borderColor: on ? t.text : t.border }]}>
              <T v="small" style={{ color: on ? t.surface : t.text, fontWeight: '600' }}>{o.label}</T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm },
});
