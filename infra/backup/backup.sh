#!/usr/bin/env bash
# Резервная копия «Ковш на Час»: база данных (pg_dump, custom-формат) + локальное файловое хранилище.
# В Yandex Cloud основная защита — автоматические бэкапы Managed PostgreSQL с восстановлением на момент времени (PITR)
# и версионирование бакета Object Storage; этот скрипт — независимая логическая копия (ТЗ §19).
#
# Переменные: DATABASE_URL (обязательно), BACKUP_DIR (по умолчанию ./backups), BACKUP_KEEP_DAYS (14),
#             STORAGE_DRIVER/STORAGE_LOCAL_DIR (если файлы хранятся локально), BACKUP_S3_URI (необязательно: s3://bucket/path).
set -euo pipefail
: "${DATABASE_URL:?нужен DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/kovsh-$STAMP"
mkdir -p "$OUT"

echo "[backup] база данных → $OUT/db.dump"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$OUT/db.dump" "$DATABASE_URL"
# Контрольные показатели для проверки восстановления.
psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/verify.sql" > "$OUT/verify.txt"

if [ "${STORAGE_DRIVER:-local}" = "local" ] && [ -n "${STORAGE_LOCAL_DIR:-}" ] && [ -d "$STORAGE_LOCAL_DIR" ]; then
  echo "[backup] файлы → $OUT/storage.tar.gz"
  tar -C "$STORAGE_LOCAL_DIR" -czf "$OUT/storage.tar.gz" .
fi

( cd "$OUT" && sha256sum ./* > SHA256SUMS )
echo "[backup] готово: $(du -sh "$OUT" | cut -f1)"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  echo "[backup] выгрузка в $BACKUP_S3_URI/kovsh-$STAMP"
  aws s3 cp --recursive "$OUT" "$BACKUP_S3_URI/kovsh-$STAMP" ${AWS_ENDPOINT_URL:+--endpoint-url "$AWS_ENDPOINT_URL"}
fi

# Хранение: удаляем локальные копии старше KEEP_DAYS дней.
find "$BACKUP_DIR" -maxdepth 1 -type d -name 'kovsh-*' -mtime +"$KEEP_DAYS" -print -exec rm -r {} +
