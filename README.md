# Ковш на Час

Агрегатор аренды спецтехники: приложение заказчика, приложение партнёра, веб-админка и общий backend.

## Документы

- [План реализации](docs/IMPLEMENTATION_PLAN.md)
- Утверждённые решения: [01](docs/decisions/01-partners-and-companies.md) · [02](docs/decisions/02-business-rules.md) · [03](docs/decisions/03-orders-pricing-infra.md) · [04](docs/decisions/04-k-clarifications.md) (приоритет: 04 > 03 > 02 > 01)

## Структура

```
apps/api/            Backend (NestJS 11, TypeScript strict, PostgreSQL + PostGIS, Redis)
packages/contracts/  Общие типы, статусы, роли, реестр настроек
infra/               docker-compose для локальной разработки
```

Приложения заказчика и партнёра (Expo) и админка появятся на следующих этапах.

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

## Тесты

Тесты работают с настоящей БД (`kovsh_test`) и Redis (база 15):

```bash
pnpm --filter @kovsh/contracts build
pnpm typecheck
pnpm test
```

Адреса переопределяются через `TEST_DATABASE_URL` и `TEST_REDIS_URL`.

## Принципы

- Миграции — только SQL-файлы в `apps/api/migrations`, применённые миграции не редактируются.
- Настраиваемые параметры (ТЗ §22) — в `SETTINGS_REGISTRY`. Значение по умолчанию задаётся только если оно утверждено заказчиком, иначе зависящая функция не работает, пока администратор не задаст значение.
- Деньги — в копейках (`bigint`), время — `timestamptz`.
