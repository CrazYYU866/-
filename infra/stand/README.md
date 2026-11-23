# Тестовый стенд для проверки приложений на телефонах

Один сервер с Docker: API, база (PostgreSQL + PostGIS), Redis, админка, веб-версия приложения заказчика и
автоматический HTTPS (Caddy + Let's Encrypt). Провайдеры — тестовые: SMS не отправляются (коды — в админке,
раздел «Тестовые SMS»), оплата без денег, маршруты и адреса приблизительные. Проверено локально: вход по коду,
заказы, WebSocket через HTTPS, загрузка файлов, админка, страница заявки по SMS-ссылке.

## Что нужно

* Сервер: Ubuntu 22.04/24.04, 2 vCPU, 4 ГБ RAM, 30 ГБ диска, публичный IP, открытые порты 80 и 443
  (Yandex Cloud: Compute Cloud, группа безопасности с входящими 80/443/22).
* Домен — необязательно: без домена используется бесплатный `<IP>.sslip.io`.

## Запуск (≈ 15 минут)

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. Код
git clone <репозиторий> kovsh && cd kovsh/infra/stand

# 3. Настройки со случайными секретами
./init.sh                     # домен <IP>.sslip.io
# или ./init.sh stand.example.ru — тогда A-записи api., admin., app. → IP сервера

# 4. Сборка и запуск
docker compose up -d --build

# 5. Демо-данные и администратор
docker compose exec api node dist/demo/seed.cli.js
docker compose exec api node dist/admin/create-admin.cli.js you@example.ru "Ваше имя" "пароль-не-короче-12"
```

Адреса (их печатает `init.sh`):

| Что | Адрес |
|---|---|
| API для приложений (`EXPO_PUBLIC_API_URL`) | `https://api.<домен>` |
| Админка | `https://admin.<домен>` (вход с обязательной 2FA) |
| Веб-версия заказчика, SMS-ссылки | `https://app.<домен>` |

## Обслуживание

```bash
docker compose logs -f api                       # логи сервера (там же тестовые SMS)
git pull && docker compose up -d --build         # обновление (миграции применяются при старте)
DATABASE_URL=... ../backup/backup.sh             # копия базы, см. infra/backup
docker compose down                              # остановка (данные сохраняются в томах)
```

Стенд — не рабочая версия: в production тестовые провайдеры запрещены, см. `docs/DEPLOYMENT.md`.
