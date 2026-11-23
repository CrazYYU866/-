/**
 * Дизайн-система «Ковш на Час».
 * Характер: строительная техника — тёплый «сигнальный» жёлтый на графите, крупные цели касания, спокойные нейтральные фоны.
 * Используется веб-админкой (как CSS-переменные) и мобильными приложениями (как объект темы).
 */
export const palette = {
  amber50: '#FFF8E1',
  amber100: '#FFECB3',
  amber400: '#FFC21A',
  amber500: '#F5B000', // фирменный «ковш»
  amber600: '#D99A00',
  graphite950: '#121417',
  graphite900: '#1B1E23',
  graphite800: '#262A31',
  graphite700: '#363B44',
  graphite500: '#6B7280',
  graphite300: '#C9CDD3',
  graphite200: '#E3E6EA',
  graphite100: '#F1F3F5',
  graphite50: '#F8F9FA',
  white: '#FFFFFF',
  green600: '#1E8E4E',
  green50: '#E8F6EE',
  red600: '#D23B3B',
  red50: '#FCEBEB',
  blue600: '#2563EB',
  blue50: '#EAF1FE',
  orange600: '#D9661A',
  orange50: '#FDF0E7',
} as const;

export interface Theme {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  warning: string;
  warningSoft: string;
  sidebar: string;
  sidebarText: string;
}

export const lightTheme: Theme = {
  bg: palette.graphite50,
  surface: palette.white,
  surfaceAlt: palette.graphite100,
  border: palette.graphite200,
  text: palette.graphite950,
  textMuted: palette.graphite500,
  accent: palette.amber500,
  accentText: palette.graphite950,
  accentSoft: palette.amber50,
  success: palette.green600,
  successSoft: palette.green50,
  danger: palette.red600,
  dangerSoft: palette.red50,
  info: palette.blue600,
  infoSoft: palette.blue50,
  warning: palette.orange600,
  warningSoft: palette.orange50,
  sidebar: palette.graphite900,
  sidebarText: palette.graphite200,
};

export const darkTheme: Theme = {
  bg: palette.graphite950,
  surface: palette.graphite900,
  surfaceAlt: palette.graphite800,
  border: palette.graphite700,
  text: palette.graphite100,
  textMuted: palette.graphite300,
  accent: palette.amber400,
  accentText: palette.graphite950,
  accentSoft: '#3A2F0B',
  success: '#3FBF73',
  successSoft: '#123222',
  danger: '#F06A6A',
  dangerSoft: '#3A1717',
  info: '#6B9BFF',
  infoSoft: '#15264A',
  warning: '#F2994A',
  warningSoft: '#3A2410',
  sidebar: '#0C0E10',
  sidebarText: palette.graphite300,
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
export const font = {
  family: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 22, xxl: 28 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

/** Цвет и подпись статуса заказа — одинаково в админке и приложениях. */
export const ORDER_STATUS_UI: Record<string, { label: string; tone: 'neutral' | 'info' | 'accent' | 'success' | 'danger' | 'warning' }> = {
  awaiting_customer_confirmation: { label: 'Ждёт подтверждения заказчика', tone: 'neutral' },
  searching: { label: 'Поиск исполнителя', tone: 'info' },
  offered: { label: 'Предложен исполнителю', tone: 'info' },
  search_failed: { label: 'Исполнитель не найден', tone: 'danger' },
  awaiting_prepayment: { label: 'Ждёт оплаты', tone: 'warning' },
  cancelled_unpaid: { label: 'Отменён: не оплачен', tone: 'danger' },
  awaiting_assignment: { label: 'Назначение машиниста', tone: 'accent' },
  assigned: { label: 'Машинист назначен', tone: 'accent' },
  en_route: { label: 'Едет на объект', tone: 'accent' },
  arrived: { label: 'Прибыл', tone: 'accent' },
  in_progress: { label: 'Идёт работа', tone: 'accent' },
  awaiting_completion_confirmation: { label: 'Ждёт подтверждения', tone: 'warning' },
  awaiting_final_payment: { label: 'Ждёт доплаты', tone: 'warning' },
  completed: { label: 'Завершён', tone: 'success' },
  cancelled: { label: 'Отменён', tone: 'neutral' },
  refund_pending: { label: 'Возврат', tone: 'warning' },
  disputed: { label: 'Спор', tone: 'danger' },
};

export const formatRub = (kopecks: number | null | undefined): string =>
  kopecks === null || kopecks === undefined ? '—' : `${(kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
