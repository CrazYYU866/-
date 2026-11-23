-- П-8: руководитель передаёт управление заказом другому диспетчеру; факт передачи пишется в журнал назначений.
ALTER TABLE order_assignments DROP CONSTRAINT order_assignments_kind_check;
ALTER TABLE order_assignments ADD CONSTRAINT order_assignments_kind_check CHECK (kind IN (
  'accepted', 'operator_assigned', 'operator_replaced', 'operator_declined', 'unit_replaced', 'released', 'returned_to_search', 'manager_changed'));
