/**
 * Технические статусы заказа (ТЗ §11 + решения 02–04).
 * Схема переходов будет зафиксирована в модуле заказов (этап 6).
 */
export const ORDER_STATUSES = [
  'awaiting_customer_confirmation',
  'searching',
  'offered',
  'search_failed',
  'accepted',
  'awaiting_prepayment',
  'cancelled_unpaid',
  'awaiting_assignment',
  'assigned',
  'en_route',
  'arrived',
  'in_progress',
  'awaiting_completion_confirmation',
  'completed',
  'awaiting_final_payment',
  'cancelled',
  'refund_pending',
  'disputed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Три статуса, которые видит заказчик (ТЗ §11), плюс отмена и спор. */
export const CUSTOMER_VISIBLE_STATUSES = ['new', 'in_progress', 'completed', 'cancelled', 'disputed'] as const;
export type CustomerVisibleStatus = (typeof CUSTOMER_VISIBLE_STATUSES)[number];

const VISIBLE: Record<OrderStatus, CustomerVisibleStatus> = {
  awaiting_customer_confirmation: 'new',
  searching: 'new',
  offered: 'new',
  search_failed: 'cancelled',
  accepted: 'in_progress',
  awaiting_prepayment: 'in_progress',
  cancelled_unpaid: 'cancelled',
  awaiting_assignment: 'in_progress',
  assigned: 'in_progress',
  en_route: 'in_progress',
  arrived: 'in_progress',
  in_progress: 'in_progress',
  awaiting_completion_confirmation: 'in_progress',
  completed: 'completed',
  awaiting_final_payment: 'completed',
  cancelled: 'cancelled',
  refund_pending: 'cancelled',
  disputed: 'disputed',
};

export function toCustomerVisibleStatus(status: OrderStatus): CustomerVisibleStatus {
  return VISIBLE[status];
}
