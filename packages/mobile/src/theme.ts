import { darkTheme, font, lightTheme, radius, space, type Theme } from '@kovsh/ui';
import { useColorScheme } from 'react-native';

export { font, radius, space };
export type { Theme };

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

export type Tone = 'neutral' | 'info' | 'accent' | 'success' | 'danger' | 'warning';
export function toneColors(t: Theme, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case 'info': return { bg: t.infoSoft, fg: t.info };
    case 'accent': return { bg: t.accentSoft, fg: t.text };
    case 'success': return { bg: t.successSoft, fg: t.success };
    case 'danger': return { bg: t.dangerSoft, fg: t.danger };
    case 'warning': return { bg: t.warningSoft, fg: t.warning };
    default: return { bg: t.surfaceAlt, fg: t.textMuted };
  }
}
