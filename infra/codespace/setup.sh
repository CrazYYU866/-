#!/usr/bin/env bash
# Подготовка демо в GitHub Codespaces (один раз при создании): зависимости и сборка сервера, админки и веб-версии.
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "▶ Установка зависимостей"
corepack enable >/dev/null 2>&1 || sudo corepack enable
pnpm install --frozen-lockfile
echo "▶ Сборка сервера и админки"
pnpm --filter @kovsh/contracts build
pnpm --filter @kovsh/api build
pnpm --filter @kovsh/admin build
echo "▶ Сборка веб-версии приложения заказчика"
(cd apps/client && CI=1 npx expo export --platform web --output-dir dist)
echo "▶ Туннель для Expo Go"
npm install -g @expo/ngrok@^4.1.0 >/dev/null 2>&1 || sudo npm install -g @expo/ngrok@^4.1.0
echo "✔ Подготовка завершена"
