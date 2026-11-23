#!/usr/bin/env bash
# Восстановление из копии backup.sh в ОТДЕЛЬНУЮ базу и проверка совпадения контрольных показателей.
# Рабочую базу скрипт не трогает: TARGET_DATABASE_URL должен указывать на новую пустую базу.
#
# Использование: TARGET_DATABASE_URL=postgres://.../kovsh_restore ./restore.sh ./backups/kovsh-20261123T010000Z
set -euo pipefail
SRC="${1:?укажите папку копии}"
: "${TARGET_DATABASE_URL:?нужен TARGET_DATABASE_URL (новая пустая база)}"

( cd "$SRC" && sha256sum --check --quiet SHA256SUMS ) && echo "[restore] контрольные суммы совпали"

tables=$(psql "$TARGET_DATABASE_URL" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
if [ "$tables" != "0" ]; then echo "[restore] целевая база не пустая ($tables таблиц) — отказ" >&2; exit 1; fi

echo "[restore] база данных"
# Любая ошибка восстановления останавливает скрипт: частично восстановленная база считается невосстановленной.
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$TARGET_DATABASE_URL" "$SRC/db.dump"

psql "$TARGET_DATABASE_URL" -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/verify.sql" > "$SRC/verify.restored.txt"
if diff -u "$SRC/verify.txt" "$SRC/verify.restored.txt"; then
  echo "[restore] контрольные показатели совпали: восстановление проверено"
else
  echo "[restore] РАСХОЖДЕНИЕ контрольных показателей" >&2; exit 2
fi

if [ -f "$SRC/storage.tar.gz" ] && [ -n "${RESTORE_STORAGE_DIR:-}" ]; then
  mkdir -p "$RESTORE_STORAGE_DIR" && tar -C "$RESTORE_STORAGE_DIR" -xzf "$SRC/storage.tar.gz"
  echo "[restore] файлы → $RESTORE_STORAGE_DIR ($(find "$RESTORE_STORAGE_DIR" -type f | wc -l) шт.)"
fi
