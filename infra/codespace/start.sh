#!/usr/bin/env bash
# Запуск демо-стенда в GitHub Codespaces (или на ноутбуке с Docker и Node.js 22). Повторный запуск безопасен.
# База и Redis — в Docker; API, админка и веб-версия заказчика — процессами Node. Тестовые провайдеры:
# SMS не отправляются (коды — в админке «Тестовые SMS»), оплата без денег, адреса и маршруты приблизительные.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
DATA="${KOVSH_DEMO_DIR:-$HOME/.kovsh-demo}"
mkdir -p "$DATA/storage" "$DATA/logs"
PG_PORT=55432
REDIS_PORT=56379

# Публичный адрес порта: в Codespaces — https://<имя>-<порт>.app.github.dev, иначе localhost.
url() {
  if [ -n "${CODESPACE_NAME:-}" ]; then echo "https://${CODESPACE_NAME}-$1.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}";
  else echo "http://localhost:$1"; fi
}

echo "▶ База данных и Redis"
docker start kovsh-demo-db >/dev/null 2>&1 || docker run -d --name kovsh-demo-db --restart unless-stopped \
  -e POSTGRES_USER=kovsh -e POSTGRES_PASSWORD=kovsh -e POSTGRES_DB=kovsh -p "127.0.0.1:$PG_PORT:5432" \
  -v kovsh-demo-pg:/var/lib/postgresql/data "${POSTGIS_IMAGE:-postgis/postgis:16-3.4}" >/dev/null
docker start kovsh-demo-redis >/dev/null 2>&1 || docker run -d --name kovsh-demo-redis --restart unless-stopped \
  -p "127.0.0.1:$REDIS_PORT:6379" "${REDIS_IMAGE:-redis:7-alpine}" >/dev/null
# Образ PostGIS при первом запуске создаёт расширения и перезапускает базу — ждём стабильной готовности.
ready=0
for _ in $(seq 1 90); do
  if docker exec kovsh-demo-db psql -U kovsh -d kovsh -tAc 'SELECT postgis_version()' >/dev/null 2>&1; then
    ready=$((ready + 1)); [ "$ready" -ge 3 ] && break
  else ready=0; fi
  sleep 2
done

# Секреты демо создаются один раз и хранятся рядом с данными.
if [ ! -f "$DATA/secrets.env" ]; then
  rnd() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48; }
  { echo "JWT_ACCESS_SECRET=$(rnd)"; echo "OTP_HASH_SECRET=$(rnd)"; echo "ADMIN_JWT_SECRET=$(rnd)"; echo "DATA_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)"; } > "$DATA/secrets.env"
fi
set -a
# shellcheck disable=SC1091
. "$DATA/secrets.env"
NODE_ENV=development PORT=3000 LOG_LEVEL=info
DATABASE_URL="postgres://kovsh:kovsh@127.0.0.1:$PG_PORT/kovsh" REDIS_URL="redis://127.0.0.1:$REDIS_PORT/0"
STORAGE_DRIVER=local STORAGE_LOCAL_DIR="$DATA/storage" TRUST_PROXY=true JOBS_AUTORUN=true
SMS_PROVIDER=dev ROUTING_PROVIDER=dev GEOCODER_PROVIDER=dev PAYMENT_PROVIDER=dev PUSH_PROVIDER=dev TELEPHONY_PROVIDER=dev
PUBLIC_BASE_URL="$(url 3000)" CUSTOMER_WEB_URL="$(url 8090)"
set +a

echo "▶ Миграции и демо-данные"
for i in 1 2 3 4 5; do node apps/api/dist/database/migrate.cli.js && break; [ "$i" = 5 ] && exit 1; sleep 5; done
node apps/api/dist/demo/seed.cli.js >/dev/null

echo "▶ Запуск API, админки и веб-версии"
pkill -f "apps/api/dist/main.js" 2>/dev/null || true
pkill -f "infra/codespace/serve-web.cjs" 2>/dev/null || true
sleep 1
nohup node apps/api/dist/main.js > "$DATA/logs/api.log" 2>&1 &
nohup node infra/codespace/serve-web.cjs apps/admin/dist 5173 3000 > "$DATA/logs/admin.log" 2>&1 &
nohup node infra/codespace/serve-web.cjs apps/client/dist 8090 3000 > "$DATA/logs/web.log" 2>&1 &
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/api/v1/health >/dev/null

if [ -n "${CODESPACE_NAME:-}" ]; then
  # Телефону и ноутбуку адреса должны открываться без входа в GitHub.
  gh codespace ports visibility 3000:public 5173:public 8090:public -c "$CODESPACE_NAME" >/dev/null 2>&1 \
    || echo "⚠ Сделайте порты 3000, 5173 и 8090 публичными вручную: вкладка PORTS → правый клик → Port Visibility → Public"
fi

cat > "$DATA/DEMO.txt" <<TXT
════════════════ Демо «Ковш на Час» запущено ════════════════
Админка:              $(url 5173)
  вход: admin@demo.kovsh / Demo-Kovsh-2026!
  2FA:  ключ KOVSHDEMOKOVSHDEMO2026AB (добавить в аутентификатор вручную, «по времени»)
  коды входа в приложения: Система → Тестовые SMS
Веб-версия заказчика: $(url 8090)
API (для приложений): $(url 3000)

Приложения на iPhone через Expo Go — в новом терминале:
  bash infra/codespace/expo.sh client     (Ковш на Час)
  bash infra/codespace/expo.sh partner    (Ковш на Час Партнёр)

Демо-номера: заказчик +7 900 000-05-01; партнёр: руководитель +7 900 000-01-01,
  диспетчер …-01-02, машинист …-01-03, независимый диспетчер …-04-01
Логи: $DATA/logs
═════════════════════════════════════════════════════════════
TXT
cat "$DATA/DEMO.txt"
