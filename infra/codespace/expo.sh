#!/usr/bin/env bash
# Запуск приложения для Expo Go на iPhone/Android: печатает QR-код. Использование: bash infra/codespace/expo.sh client|partner
set -euo pipefail
APP="${1:-}"
case "$APP" in client) PORT=8081 ;; partner) PORT=8082 ;; *) echo "Укажите: client или partner"; exit 1 ;; esac
cd "$(dirname "$0")/../../apps/$APP"
if [ -n "${CODESPACE_NAME:-}" ]; then
  API="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  API="${EXPO_PUBLIC_API_URL:?укажите EXPO_PUBLIC_API_URL=http://<IP ноутбука в Wi-Fi>:3000}"
fi
echo "API: $API"
echo "Отсканируйте QR-код камерой iPhone (откроется Expo Go). Остановить — Ctrl+C."
# Туннель нужен, потому что телефон не в одной сети с Codespaces.
EXPO_PUBLIC_API_URL="$API" exec npx expo start --tunnel --port "$PORT"
