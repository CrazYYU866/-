#!/usr/bin/env bash
# Самонастройка тестового стенда на новом сервере Ubuntu (запускается от root; повторный запуск безопасен).
# Вызывается из user-data при создании ВМ (docs/IPHONE_SETUP.md) или вручную: sudo bash infra/stand/bootstrap.sh [домен]
# Ход работы — в /var/log/kovsh-stand.log; итог (адреса стенда) — в /home/kovsh/STAND.txt.
set -euo pipefail
cd "$(dirname "$0")"
USER_NAME="${STAND_USER:-kovsh}"
log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "1/5 Файл подкачки (нужен сборке)"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || fallocate -l 4G /swapfile
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "2/5 Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
usermod -aG docker "$USER_NAME" 2>/dev/null || true

log "3/5 Настройки стенда со случайными секретами"
sudo -u "$USER_NAME" ./init.sh "${1:-}"

log "4/5 Сборка и запуск — 15–30 минут"
docker compose up -d --build

log "    ожидание запуска API"
for _ in $(seq 1 90); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1; then break; fi
  sleep 10
done
docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null

log "5/5 Демо-данные"
docker compose exec -T api node dist/demo/seed.cli.js

DOMAIN="$(grep '^STAND_DOMAIN=' .env | cut -d= -f2)"
cat > "/home/$USER_NAME/STAND.txt" <<TXT
Стенд «Ковш на Час» готов.
  API (сообщить разработчику): https://api.$DOMAIN
  Админка:                     https://admin.$DOMAIN
  Веб-версия заказчика:        https://app.$DOMAIN
Администратор создаётся командой из docs/IPHONE_SETUP.md (шаг 6).
TXT
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/STAND.txt"
log "СТЕНД ГОТОВ"
cat "/home/$USER_NAME/STAND.txt"
# Итог — и в последовательный порт: виден в консоли Yandex Cloud без SSH.
cat "/home/$USER_NAME/STAND.txt" > /dev/console 2>/dev/null || true
