# Ковш на Час

Агрегатор аренды спецтехники: приложение заказчика, приложение партнёра, веб-админка и общий backend.

## Документы

- [План реализации](docs/IMPLEMENTATION_PLAN.md)
- Утверждённые решения: [01](docs/decisions/01-partners-and-companies.md) · [02](docs/decisions/02-business-rules.md) · [03](docs/decisions/03-orders-pricing-infra.md) · [04](docs/decisions/04-k-clarifications.md) (приоритет: 04 > 03 > 02 > 01)

## Структура

```
apps/api/            Backend (NestJS 11, TypeScript strict, PostgreSQL + PostGIS, Redis)
apps/admin/          Веб-панель администрации (Vite + React)
apps/client/         Приложение заказчика «Ковш на Час» (Expo SDK 58, Expo Router)
apps/partner/        Приложение «Ковш на Час Партнёр»: компании, диспетчеры, машинисты, независимые диспетчеры
packages/contracts/  Общие типы, статусы, роли, реестр настроек
packages/ui/         Дизайн-система: цвета, темы, отступы, подписи статусов
packages/mobile/     Общий код мобильных приложений: API-клиент, вход, компоненты, адреса, схема маршрута
infra/               docker-compose для локальной разработки
```

## Локальный запуск

Нужны Node.js 22, pnpm 10, Docker (или локальные PostgreSQL 16 + PostGIS 3 и Redis 7).

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
cp apps/api/.env.example apps/api/.env
pnpm build
cd apps/api && set -a && . ./.env && set +a
pnpm db:migrate
pnpm start
```

Первый суперадминистратор: `pnpm --filter @kovsh/api admin:create admin@example.ru "ФИО" "пароль-не-короче-12"`

- Проверка состояния: http://localhost:3000/api/v1/health
- Документация API (Swagger): http://localhost:3000/api/docs

## Демо-данные

```bash
pnpm --filter @kovsh/api demo:seed   # запрещено в production
```

Создаёт демонстрационные компании, технику, заказчиков и заказы. Вход в админку: `admin@demo.kovsh` / `Demo-Kovsh-2026!`,
2FA-секрет `KOVSHDEMOKOVSHDEMO2026AB`. Заказчики в приложении: `+7 900 000-05-01` (частное лицо), `+7 900 000-06-01` (руководитель ООО «ГородСтрой»).
Код из SMS в тестовом режиме печатается в лог API (`[DEV SMS]`).

## Мобильные приложения

```bash
cd apps/client    # или apps/partner
EXPO_PUBLIC_API_URL=http://<адрес-API>:3000 npx expo start   # Expo Go / dev-сборка на телефоне
npx expo export --platform web                                # веб-сборка для быстрого просмотра
```

В веб-сборке приложение обращается к API по тому же адресу, что и страница (нужен прокси `/api` и `/socket.io` на API).
Пока нет ключей Яндекса, адрес ищется тестовым геокодером (короткий встроенный список), а маршрут показывается схемой без карты.

Демо-партнёры (вход в «Ковш на Час Партнёр»): `+7 900 000-01-01` — руководитель ООО «СтройТехПарк», `…-01-02` — диспетчер,
`…-01-03` — машинист, `…-02-01` — ИП, который сам работает машинистом, `…-04-01` — независимый диспетчер,
`…-07-01` — компания на проверке.

Сборка на телефоны — через EAS (профили в `apps/*/eas.json`: `development` — сборка для разработки с фоновым GPS,
`preview` — внутренняя установка, `production` — магазины). Адрес API задаётся переменной `EXPO_PUBLIC_API_URL`
в настройках EAS. Нужны аккаунты Apple Developer и Google Play Console.

Фоновая передача GPS машиниста (с «Выехал» до «Прибыл») работает только в сборке приложения на телефоне
(development build или магазинная сборка): Expo Go и веб-версия передают координаты, пока приложение открыто.

## Документы этапа 13

- [Отчёт о тестировании и безопасности](docs/testing/STAGE13_REPORT.md)
- [Развёртывание сервера](docs/DEPLOYMENT.md)
- [Подключение реальных провайдеров](docs/INTEGRATIONS.md)
- [Оставшиеся блокеры](docs/BLOCKERS.md)
- [Тестирование на iPhone и Android](docs/DEVICE_TESTING.md)
- Резервное копирование и проверка восстановления: `infra/backup/`

## Тесты

Тесты работают с настоящей БД (`kovsh_test`) и Redis (база 15):

```bash
pnpm --filter @kovsh/contracts build
pnpm typecheck
pnpm test
```

Адреса переопределяются через `TEST_DATABASE_URL` и `TEST_REDIS_URL`.

Нагрузочный тест подбора: `pnpm --filter @kovsh/api test:load` (параметры `LOAD_COMPANIES`, `LOAD_ORDERS`, `LOAD_WORKERS`).

## Принципы

- Миграции — только SQL-файлы в `apps/api/migrations`, применённые миграции не редактируются.
- Настраиваемые параметры (ТЗ §22) — в `SETTINGS_REGISTRY`. Значение по умолчанию задаётся только если оно утверждено заказчиком, иначе зависящая функция не работает, пока администратор не задаст значение.
- Деньги — в копейках (`bigint`), время — `timestamptz`.
