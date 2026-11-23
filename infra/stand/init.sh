#!/usr/bin/env sh
# Создаёт .env стенда со случайными секретами. Домен: свой (api./admin./app. должны указывать на сервер)
# или бесплатный <IP-сервера>.sslip.io — тогда DNS настраивать не нужно.
set -eu
cd "$(dirname "$0")"
if [ -f .env ]; then echo ".env уже существует — не перезаписываю"; exit 0; fi
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  IP="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
  [ -n "$IP" ] || { echo "Укажите домен: ./init.sh stand.example.ru"; exit 1; }
  DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"
fi
rnd() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
cat > .env <<ENV
STAND_DOMAIN=$DOMAIN
DB_PASSWORD=$(rnd 32)
JWT_ACCESS_SECRET=$(rnd 48)
OTP_HASH_SECRET=$(rnd 48)
ADMIN_JWT_SECRET=$(rnd 48)
DATA_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
SMS_PROVIDER=dev
ROUTING_PROVIDER=dev
GEOCODER_PROVIDER=dev
PAYMENT_PROVIDER=dev
PUSH_PROVIDER=dev
TELEPHONY_PROVIDER=dev
ENV
echo "Готово. Адреса стенда:"
echo "  API:     https://api.$DOMAIN"
echo "  Админка: https://admin.$DOMAIN"
echo "  Веб:     https://app.$DOMAIN"
