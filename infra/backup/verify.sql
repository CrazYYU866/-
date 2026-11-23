-- Контрольные показатели копии: одинаковые до копирования и после восстановления.
-- Число строк в каждой таблице.
SELECT 'rows:' || relname || '=' || n FROM (
  SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, true, '')))[1]::text AS n
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'spatial_ref_sys'
) t ORDER BY 1;
-- Двойная запись: сумма всех проводок равна нулю.
SELECT 'ledger_sum=' || COALESCE(sum(amount_kopecks), 0) FROM ledger_entries;
-- Деньги по заказам.
SELECT 'orders_paid=' || COALESCE(sum(paid_kopecks), 0) || ',refunded=' || COALESCE(sum(refunded_kopecks), 0) FROM orders;
-- Применённые миграции и их контрольные суммы.
SELECT 'migration:' || name || '=' || checksum FROM schema_migrations ORDER BY name;
-- Защитные механизмы схемы на месте.
SELECT 'trigger:' || tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;
SELECT 'constraint:' || conname FROM pg_constraint WHERE contype = 'x' ORDER BY 1;
SELECT 'extension:' || extname FROM pg_extension WHERE extname IN ('postgis', 'btree_gist') ORDER BY 1;
