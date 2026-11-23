# Развёртывание сервера «Ковш на Час»

> Документ этапа 13. Описывает рабочее окружение в Yandex Cloud (В-37). Всё, что проверено в этом проекте,
> помечено ✅; то, что можно проверить только в облаке, — ⚠️.

## 1. Состав

| Компонент | Где работает | Примечание |
|---|---|---|
| API (NestJS) | Docker-образ `apps/api/Dockerfile` → Yandex Container Registry → Compute Cloud (группа ВМ с Container-Optimized Image) или Managed Kubernetes | ✅ образ собран и запущен: health, миграции, защитные заголовки, пользователь `node` |
| Обработчик заданий | Тот же образ (`JOBS_AUTORUN=true`) | Задания берутся с `FOR UPDATE SKIP LOCKED` — несколько экземпляров безопасны ✅ (нагрузочный тест: 4 обработчика) |
| PostgreSQL 16 + PostGIS | Managed Service for PostgreSQL | Расширения: `postgis`, `btree_gist`, `pgcrypto` |
| Redis 7 | Managed Service for Redis (Valkey) | Сессии, лимиты, коды SMS, WebSocket между экземплярами |
| Файлы (документы, фото) | Object Storage, приватный бакет с шифрованием KMS-ключом по умолчанию | ✅ S3-драйвер проверен на эмуляторе; ⚠️ с Yandex Object Storage — после ключа доступа |
| Админка | Статика `apps/admin/dist` → Object Storage (веб-сайт) + CDN, или тот же балансировщик | Обращается к API по `/api` на том же домене |
| HTTPS | Application Load Balancer + Certificate Manager | Сертификаты Let's Encrypt или свои |
| Секреты | Lockbox | Передаются в переменные окружения контейнера |
| Мобильные приложения | EAS Build → App Store / Google Play / RuStore | `EXPO_PUBLIC_API_URL` — адрес API |

Схема запросов: `приложения/админка → ALB (TLS) → API (2+ экземпляра) → PostgreSQL / Redis / Object Storage`.
WebSocket (`/socket.io`, пространство `/ws`) идёт через тот же балансировщик; липкие сессии не нужны — события
между экземплярами передаются через Redis ✅ (тест «несколько экземпляров сервера»).

## 2. Переменные окружения API

Проверяются при старте (`apps/api/src/config/env.ts`): при ошибке сервер не запускается.
В `production` тестовые провайдеры **запрещены** — сервер не стартует, пока не подключены реальные
(SMS, маршрутизация, геокодер, платежи, push, телефония, хранилище S3).

| Переменная | Значение в production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DATABASE_URL` | строка подключения Managed PostgreSQL (`sslmode=verify-full`) |
| `DATABASE_POOL_MAX` | 10–20 на экземпляр (суммарно меньше `max_connections` кластера) |
| `REDIS_URL` | `rediss://…` Managed Redis |
| `JWT_ACCESS_SECRET`, `ADMIN_JWT_SECRET`, `OTP_HASH_SECRET` | случайные строки ≥ 32 символов, разные (Lockbox) |
| `DATA_ENCRYPTION_KEY` | 32 случайных байта в base64 (`openssl rand -base64 32`) — шифрует банковские реквизиты. **Потеря ключа = потеря реквизитов**, хранить копию отдельно |
| `STORAGE_DRIVER=s3`, `S3_ENDPOINT=https://storage.yandexcloud.net`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | сервисный аккаунт с ролью `storage.editor` только на бакет; `S3_SERVER_SIDE_ENCRYPTION` не задавать — шифрует бакет |
| `SMS_PROVIDER`, `ROUTING_PROVIDER`, `GEOCODER_PROVIDER`, `PAYMENT_PROVIDER`, `PUSH_PROVIDER`, `TELEPHONY_PROVIDER` | реальные провайдеры (см. `docs/INTEGRATIONS.md`) |
| `PUBLIC_BASE_URL` | `https://api.<домен>` — для ссылок оплаты и SMS-ссылок заявок |
| `TRUST_PROXY` | `true` (за балансировщиком; нужно для лимитов по IP) |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_AUTH_PER_MIN` | 600 / 30 по умолчанию |
| `SWAGGER_ENABLED` | не задавать (в production документация API закрыта) |
| `JOBS_AUTORUN` | `true` |
| `SETTINGS_CACHE_MS` | 5000 (изменение настроек в админке доходит до всех экземпляров за ≤ 5 с) |
| `LOG_LEVEL` | `info`; логи — JSON в stdout, токены и cookie маскируются ✅ |

## 3. Первый запуск

```bash
# 1. Образ
docker build -f apps/api/Dockerfile -t cr.yandex/<registry>/kovsh-api:<версия> .
docker push cr.yandex/<registry>/kovsh-api:<версия>

# 2. Миграции (отдельный запуск того же образа перед выкладкой новой версии)
docker run --rm --env-file prod.env cr.yandex/<registry>/kovsh-api:<версия> node dist/database/migrate.cli.js

# 3. Первый суперадминистратор (2FA включается при первом входе — обязательна)
docker run --rm -it --env-file prod.env cr.yandex/<registry>/kovsh-api:<версия> \
  node dist/admin/create-admin.cli.js admin@<домен> "ФИО" "пароль-не-короче-12"
```

Затем в админке: границы регионов (GeoJSON), тарифы аренды и доставки, реквизиты платформы, праздничные дни,
проверка значений настроек. Демо-данные (`demo:seed`) в production не запускаются (скрипт отказывается сам).

Миграции применяются под advisory-блокировкой и проверяют контрольные суммы уже применённых файлов ✅ — изменённая
старая миграция остановит выкладку.

## 4. Выкладка новой версии

1. CI зелёный (типы, все автотесты, сборка).
2. Миграции → новая версия образа в группу ВМ с постепенной заменой (rolling update, health check `/api/v1/health`).
3. Миграции пишутся совместимыми с предыдущей версией кода (добавление колонок/таблиц; удаление — следующим релизом).

## 5. Резервное копирование и восстановление

* **Основное:** автоматические бэкапы Managed PostgreSQL с восстановлением на момент времени (PITR), хранение 7+ дней;
  версионирование и правила жизненного цикла бакета Object Storage. ⚠️ настраивается при создании кластера.
* **Независимая логическая копия:** `infra/backup/backup.sh` (ежедневно, например cron на отдельной ВМ или
  Cloud Functions по таймеру) → бакет для копий в другом каталоге/аккаунте.
* **Проверка восстановления:** `infra/backup/restore.sh <копия>` в новую пустую базу. Скрипт сверяет число строк
  во всех таблицах, нулевую сумму двойной записи, суммы оплат/возвратов, миграции, триггеры защиты, ограничения
  и расширения. ✅ Проверено на демо-базе: 64 таблицы, все показатели совпали, сервер на восстановленной базе
  работает (вход, заказы). Рекомендуется повторять раз в месяц.

## 6. Мониторинг

| Что | Как |
|---|---|
| Доступность | проверка `/api/v1/health` балансировщиком и Monitoring (БД, PostGIS, Redis) |
| Ошибки | JSON-логи → Cloud Logging; алерт на `level>=50`. ⚠️ Sentry — по желанию, после выбора |
| Очередь заданий | `SELECT count(*) FROM scheduled_jobs WHERE status='pending' AND run_at < now() - interval '1 minute'` → алерт, если > 0 долго |
| Деньги | ежедневная проверка `sum(amount_kopecks) FROM ledger_entries = 0`; выплаты/возвраты в статусе «в обработке» > 2 суток |
| Нагрузка | p95 времени ответа API, соединения PostgreSQL, память Redis |

## 7. Безопасность окружения

* Доступ к БД и Redis — только из подсети API (группы безопасности), не из интернета.
* Бакет с документами — приватный; файлы отдаются только через API с проверкой прав ✅.
* Секреты — только в Lockbox, не в образе и не в репозитории (`.dockerignore` исключает `.env`).
* Вебхук платёжного провайдера (`/api/v1/webhooks/payments/<провайдер>`) не ограничивается лимитами; проверяется
  провайдером (подпись / список IP / перезапрос статуса) — реализуется вместе с провайдером.
* Админка — только HTTPS; вход с обязательной 2FA и блокировкой после 5 неверных паролей ✅.
