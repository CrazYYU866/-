import { Platform, StyleSheet, View } from 'react-native';

const FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' : undefined;
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { radius, useTheme } from './theme';

interface P { lat: number; lng: number }

/**
 * Схема «техника → объект» без картографической подложки.
 * Карта Яндекса (П-19) подключится вместе с ключом; до этого показываем только реальные точки и расстояние,
 * ничего не дорисовывая (ТЗ: не показывать выдуманное местоположение).
 */
export function RouteScheme({ site, from, fromLabel, stale }: { site: P; from?: P | null; fromLabel?: string; stale?: boolean }) {
  const t = useTheme();
  const W = 340, H = 200, PAD = 36;
  const pts = from ? [site, from] : [site];
  const k = Math.cos((site.lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k), ys = pts.map((p) => p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.01);
  const scale = Math.min((W - PAD * 2) / span, (H - PAD * 2) / span);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const proj = (p: P) => ({ x: W / 2 + (p.lng * k - cx) * scale, y: H / 2 - (p.lat - cy) * scale });
  const s = proj(site);
  const f = from ? proj(from) : null;
  const grid = [];
  for (let x = 0; x <= W; x += 28) grid.push(<Line key={`x${x}`} x1={x} y1={0} x2={x} y2={H} stroke={t.border} strokeWidth={0.6} />);
  for (let y = 0; y <= H; y += 28) grid.push(<Line key={`y${y}`} x1={0} y1={y} x2={W} y2={y} stroke={t.border} strokeWidth={0.6} />);
  return (
    <View style={[st.wrap, { borderColor: t.border, backgroundColor: t.surfaceAlt }]}>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} accessibilityLabel="Схема: техника и объект">
        <Rect x={0} y={0} width={W} height={H} fill={t.surfaceAlt} />
        <G>{grid}</G>
        {f ? <Line x1={f.x} y1={f.y} x2={s.x} y2={s.y} stroke={t.text} strokeWidth={3} strokeDasharray="8 6" strokeLinecap="round" /> : null}
        {f ? (
          <G>
            <Circle cx={f.x} cy={f.y} r={14} fill={stale ? t.textMuted : t.accent} stroke={t.surface} strokeWidth={3} />
            <SvgText fontFamily={FONT} x={f.x} y={f.y + 30} fontSize={12} fontWeight="600" fill={t.text} textAnchor="middle">{fromLabel ?? 'Техника'}</SvgText>
          </G>
        ) : null}
        <G>
          <Path d={`M${s.x} ${s.y + 2} l-11 -18 a12.5 12.5 0 1 1 22 0 z`} fill={t.danger} stroke={t.surface} strokeWidth={2} />
          <Circle cx={s.x} cy={s.y - 22} r={4.5} fill={t.surface} />
          <SvgText fontFamily={FONT} x={s.x} y={s.y + 18} fontSize={12} fontWeight="600" fill={t.text} textAnchor="middle">Объект</SvgText>
        </G>
      </Svg>
    </View>
  );
}

const st = StyleSheet.create({ wrap: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' } });
