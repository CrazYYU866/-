# «Ковш на Час» — план реализации (черновик v0.4)

> Статус: **на согласовании**. Код не пишется до подтверждения заказчиком.
> Основа: ТЗ v1.0. Всё, чего нет в ТЗ, вынесено в раздел «Вопросы» (§10) и **не** считается принятым правилом.
> Места, где я предлагаю техническое решение (а не бизнес-правило), помечены **[предложение]**.
>
> **Утверждённые решения (имеют приоритет над этим планом):**
> - [01 — Исполнители и компании](decisions/01-partners-and-companies.md) — Р-1…Р-21.
> - [02 — Основные бизнес-правила и ответы П-1…П-19](decisions/02-business-rules.md) — **приоритет над 01** (в т. ч. П-10: машинист только в одной компании).
> - [03 — Заказы, цены, оплата, подбор, документы, инфраструктура, админка](decisions/03-orders-pricing-infra.md) — **приоритет над 01 и 02**. Открытые вопросы К-1…К-16.
>
> Порядок приоритета: **03 > 02 > 01 > этот план > ТЗ v1.0**.

---

## 0. Краткое резюме

- **Продукт:** два мобильных приложения (Заказчик, Партнёр) + веб-админка + единый backend.
- **Ядро:** последовательное распределение заказа (одно предложение за раз, 40 с), расчёт цены (тариф + доставка по маршруту ×2), оплата через платформу, выплата исполнителю на следующий день, GPS машиниста в фоне.
- **Оплата (утверждено):** поиск без оплаты → исполнитель принял → заказчик платит 50% → после выполнения ещё 50% → выплата исполнителю на следующий день. Провайдер — ЮKassa, заменяемый через адаптер. Открытые детали — Н-1…Н-15.
- **Архитектура [предложение]:** модульный монолит на Node.js/TypeScript (NestJS), PostgreSQL + PostGIS, Redis (очереди и таймеры, pub/sub для WebSocket), S3-совместимое хранилище, монорепозиторий (Expo-приложения, админка на React, общие пакеты типов и контрактов).

---

## 1. Анализ бизнес-логики

### 1.1. Участники и роли

| Роль | Приложение | Кто создаёт | Коротко |
|---|---|---|---|
| Заказчик | Клиентское | Сам, по телефону | Создаёт и оплачивает заказы, отслеживает, оценивает |
| Главный владелец (`owner`), ровно один | Партнёр | Регистрирует организацию; смена — только через поддержку (Р-12) | Всё, что у руководителя + назначение/отзыв руководителей (Р-11) |
| Руководитель (`manager`), может быть несколько | Партнёр | Назначает главный владелец | Все функции диспетчера + сотрудники, вся финансовая информация, настройки (Р-10) |
| Корпоративный диспетчер (`dispatcher`) | Партнёр | Приглашает руководитель (Р-2) | Техника, линия, приём заказов, назначение/замена машинистов. Видит цену только своих заказов (Р-1). Может состоять в нескольких компаниях (Р-13) |
| Машинист (`operator`) | Партнёр (ограниченный режим) | Приглашает **только** руководитель, машинист подтверждает привязку (Р-2, Р-14) | Назначенные заказы, статусы (в т. ч. офлайн), GPS, отказ, сообщение о проблеме. Один аккаунт на несколько компаний, единый календарь: один заказ в календарный день (Р-5) |
| Независимый диспетчер (агент) | ? (см. В-21) | Сам, ИП/ЮЛ, модерация | Привлекает заказчиков, получает % |
| Администратор (с подролями) | Веб-админка | Суперадмин | Модерация, справочники, финансы, споры |

Один человек (номер телефона) может иметь несколько ролей: например, быть заказчиком и машинистом. **[предложение]** Аккаунт один (`users`), роли выдаются через членство в организациях; клиентское и партнёрское приложения — это два разных «контекста» одного аккаунта.

### 1.2. Основные сущности

Организация-партнёр (ИП/ЮЛ) → сотрудники (роли) → единицы техники (у каждой своя база, радиус, доступность, документы, статус проверки) → предложения заказов → заказы → назначенные техника и машинист → GPS-трек, чат, звонки → платёж → проводки → выплата → отзыв.

### 1.3. Ключевые бизнес-процессы

1. **Онбординг партнёра:** телефон+SMS → реквизиты → документы → «Ожидает проверки» → админ подтверждает/отклоняет с причиной → добавление техники → проверка техники → выход на линию.
2. **Приглашение сотрудника:** руководитель/диспетчер вводит телефон и роль → SMS-приглашение → сотрудник входит по SMS и попадает в ограниченный профиль организации.
3. **Заказ:** адрес объекта (≠ местоположение заказчика) → категория → дата/время → длительность → характеристики → расчёт (аренда + доставка) → подтверждение → оплата → поиск.
4. **Распределение:** подбор кандидатов → предложение одному → 40 с / «Пропустить» / «Принять» → закрепление → при отсутствии кандидатов расширение радиуса.
5. **Исполнение:** (для компании) назначение техники и машиниста → «Направляется» → «Прибыла» → «Работа» → «Ожидает подтверждения завершения» → «Завершён».
6. **Финансы:** платёж → холд/фиксация → расчёт комиссии платформы, суммы исполнителя, комиссии агента → выплата на следующий день → возвраты/споры.
7. **Постзаказ:** оценка и отзыв → модерация → пересчёт рейтинга → влияние на подбор.

---

## 2. Архитектура системы

### 2.1. Общая схема [предложение]

```
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ Client App   │  │ Partner App  │  │ Admin Web    │
 │ Expo / RN    │  │ Expo / RN    │  │ React + Vite │
 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
        │ REST /api/v1 + WebSocket (Socket.IO)│
        └──────────────┬──────────────────────┘
               ┌───────▼────────┐
               │  API (NestJS)  │  модульный монолит
               │  ─ HTTP + WS   │
               └───┬───────┬────┘
                   │       │  BullMQ (Redis)
          ┌────────▼──┐  ┌─▼──────────────────┐
          │PostgreSQL │  │ Worker(ы):         │
          │+ PostGIS  │  │ таймеры офферов,   │
          └───────────┘  │ выплаты, push, SMS,│
                         │ вебхуки, отчёты    │
  S3-хранилище           └────────────────────┘
  (фото, документы)
  Внешние: SMS · Push (Expo/FCM/APNs) · Карты/геокодинг · Маршрутизация · Платёжный провайдер · Телефония
```

### 2.2. Почему так

- **Модульный монолит, а не микросервисы.** Для первого запуска микросервисы дают только накладные расходы. Модули с чёткими границами (auth, orgs, fleet, pricing, orders, matching, payments, ledger, payouts, chat, telephony, tracking, notifications, reviews, admin) позже выносятся в отдельные сервисы без переписывания.
- **NestJS:** DI, guards для серверной проверки прав, встроенные WebSocket-шлюзы, удобное разбиение на модули. Альтернатива — Fastify без фреймворка, если команда так предпочитает.
- **ORM: Drizzle или Kysely + SQL-миграции.** Prisma плохо поддерживает PostGIS, exclusion constraints и частичные индексы, а они нужны для защиты от двойного назначения.
- **Redis + BullMQ:** отложенные задачи (тайм-аут оффера 40 с, расширение радиуса, выплаты T+1, повторы вебхуков) переживают перезапуск сервера. Socket.IO Redis-adapter позволяет держать несколько инстансов API.
- **Деньги** хранятся целыми копейками (`bigint`), учёт ведётся двойной записью (ledger).
- **Время** хранится в `timestamptz`, у каждого региона есть часовой пояс.

### 2.3. Монорепозиторий [предложение]

```
apps/
  api/            NestJS (HTTP + WS)
  worker/         BullMQ-воркеры (тот же код модулей)
  client-app/     Expo + Expo Router
  partner-app/    Expo + Expo Router
  admin/          React + Vite (+ TanStack Query, UI-кит)
packages/
  contracts/      zod-схемы DTO, общие типы, коды ошибок, enum статусов
  api-client/     типизированный клиент (генерируется из OpenAPI)
  ui/             общие RN-компоненты
  config/         eslint, tsconfig (strict)
infra/            docker-compose (pg+postgis, redis, minio), CI
docs/             ADR, API, этот план
```

Инструменты: pnpm workspaces + Turborepo, TypeScript strict, Vitest/Jest, Testcontainers для интеграционных тестов с реальным PostGIS, OpenAPI-документация генерируется из кода.

### 2.4. Мобильные приложения

- Expo **development builds / EAS Build**, а не Expo Go: фоновая геолокация и нативные модули в Expo Go не работают.
- Фоновая геолокация: `expo-location` + `expo-task-manager` (на Android — foreground service с постоянным уведомлением). Если надёжности на части Android-устройств не хватит, запасной вариант — `react-native-background-geolocation` (платная лицензия).
- Офлайн-буфер координат: точки копятся локально и отправляются пачкой после восстановления связи.
- Push: Expo Push Service поверх FCM/APNs.

---

## 3. Структура базы данных

Обозначения: PK — `uuid`, суммы — `bigint` в копейках, время — `timestamptz`, гео — `geography(Point,4326)`. У всех таблиц есть `created_at`/`updated_at`.

### 3.1. Пользователи и доступ

| Таблица | Ключевые поля | Связи / ограничения |
|---|---|---|
| `users` | phone (unique, E.164), full_name, photo_file_id, status (active/blocked), blocked_reason | — |
| `otp_codes` | phone, code_hash, purpose, attempts, expires_at | rate limit по телефону и IP |
| `auth_sessions` | user_id, app (client/partner), refresh_token_hash, device_id, expires_at, revoked_at | → users |
| `push_devices` | user_id, app, platform, token, active | → users |
| `admin_users` | email, password_hash, totp_secret (enc), role_id, status | отдельно от `users` |
| `admin_roles` / `admin_permissions` | набор прав | RBAC админки |
| `admin_audit_log` | admin_id, action, entity, entity_id, before/after (jsonb), ip | только добавление записей |

### 3.2. Организации, сотрудники, документы

| Таблица | Ключевые поля | Связи / ограничения |
|---|---|---|
| `organizations` | kind (partner / agent), legal_form (IP / LLC / …), name, inn, ogrn, kpp, legal_address, email, contact_phone, status (draft / pending_review / verified / rejected / blocked), rejection_reason, verified_at, region_id | unique (inn, kind) |
| `organization_bank_accounts` | org_id, bik, account_no (enc), corr_account, bank_name, is_primary, verified | → organizations |
| `organization_members` | org_id, user_id, role (owner / manager / dispatcher / operator), status (invited / active / blocked / detached), invited_by, detached_by, detached_at | unique (org_id, user_id); **unique (org_id) WHERE role='owner'** — ровно один главный владелец (Р-11); **unique (user_id) WHERE role='operator' AND status IN ('invited','active')** — машинист только в одной компании (П-10) |
| `organization_ownership_history` | org_id, from_user_id, to_user_id, admin_id, basis_documents, reason | только через админку (Р-12) |
| `partner_incidents` | org_id, order_id, type (assignment_timeout / unit_replacement_failed / operator_declined / returned_to_search), meta | фиксация фактов (Р-7, Р-16) |
| `invitations` | org_id, phone, role, token_hash, expires_at, accepted_at | → organizations |
| `document_types` | code, title, applies_to (organization / equipment / operator), legal_form filter, required, has_expiry | справочник в админке |
| `documents` | owner_type, owner_id, document_type_id, file_id, status (uploaded / approved / rejected / expired), reviewer_id, review_comment, expires_at | → document_types, files |
| `files` | storage_key, mime, size, sha256, uploaded_by, visibility (public / private) | документы только private, выдаются по presigned URL |
| `organization_status_history` | org_id, from, to, reason, actor | история модерации |

### 3.3. География

| Таблица | Ключевые поля |
|---|---|
| `regions` | name, timezone, active |
| `cities` | region_id, name, center (geo), active |
| `service_zones` | city_id / region_id, name, area `geography(MultiPolygon)`, active |

### 3.4. Техника

| Таблица | Ключевые поля | Связи / ограничения |
|---|---|---|
| `equipment_categories` | parent_id, name, slug, icon_file_id, sort, active | дерево категорий |
| `category_attributes` | category_id, key, label, type (number / enum / bool / text), unit, options, required, filterable | описывают динамические характеристики |
| `equipment_units` | org_id, category_id, brand, model, year, reg_number, attributes (jsonb, проверяется по `category_attributes`), base_point (geo), base_address, work_radius_km, is_online, verification_status (draft / pending / approved / rejected), rejection_reason, rating_avg, rating_count | GIST(base_point), GIN(attributes) |
| `equipment_photos` | unit_id, file_id, sort | → equipment_units |
| `equipment_availability` | unit_id, тип и параметры (см. В-12) | модель зависит от ответа |
| `unit_bookings` | unit_id, order_id, period `tstzrange` | **EXCLUDE USING gist (unit_id WITH =, period WITH &&)** — одна техника физически не может быть занята двумя заказами одновременно |
| `operator_day_assignments` | user_id, work_date (день **начала** заказа в часовом поясе объекта, П-4), order_id, org_id, status (active / declined / replaced / cancelled) | **UNIQUE (user_id, work_date) WHERE status='active'** — один заказ в календарный день (Р-5, П-4) |

### 3.5. Тарифы и настройки

| Таблица | Ключевые поля | Примечание |
|---|---|---|
| `tariffs` | category_id, region_id, hour_price, min_hours (=4), max_shift_hours (=11), hour_step (=1), km_price, valid_from, valid_to, version, created_by | Н-3: аренда = часы × hour_price; записи не изменяются: правка тарифа создаёт новую версию |
| `commission_rules` | scope (global / region / category), scope_id, platform_percent, valid_from | версионируются |
| `agent_commission_rules` | percent / fixed, база расчёта, срок привязки | по ответам на В-20…В-23 |
| `platform_settings` | key, value (jsonb), updated_by | время оффера, шаги расширения радиуса, правила отмены, правила выплат |
| `platform_settings_history` | key, old, new, admin_id | аудит |
| `cancellation_policies` | кто отменяет, окно времени, удержание (% / фикс.), версия | по ответам на В-15 |

### 3.6. Заказы и распределение

| Таблица | Ключевые поля | Ограничения |
|---|---|---|
| `orders` | number (человекочитаемый), customer_id, region_id, category_id, required_attributes (jsonb), site_point, site_address, site_comment, customer_point (отдельно!), scheduled_start, duration_hours, status, partner_org_id, equipment_unit_id, operator_member_id, agent_org_id, source (app / agent / promo …), **снимок цены** (tariff_id, rent_amount, delivery_km, delivery_amount, total_amount, commission_percent, platform_fee, partner_amount, agent_amount), version (optimistic lock) | индексы по статусу, региону, дате |
| `order_status_history` | order_id, from_status, to_status, actor_type, actor_id, reason, meta, at | только добавление |
| `order_offers` | order_id, unit_id, org_id, attempt_no, search_radius_km, route_km, score, status (pending / accepted / skipped / expired / revoked), offered_at, expires_at, responded_at, responder_id | **unique (order_id) WHERE status='pending'** — одновременно максимум одно активное предложение; unique (order_id, unit_id) |
| `matching_runs` | order_id, step, radius, candidates (jsonb со скорингом) | для разбора спорных случаев «почему не мне» |
| `order_assignments` | order_id, org_id, unit_id, operator_user_id, managing_member_id, assigned_by, assigned_at, ended_at, end_reason (replaced / declined / breakdown / returned_to_search) | полная история назначений техники и машинистов (Р-3, Р-8, Р-16) |
| `order_incidents` | order_id, reported_by, type (breakdown / other), comment, photos, status | «Сообщить о проблеме» (Р-17) |

Дополнения к `orders`: `managing_member_id` (диспетчер, управляющий заказом — Р-1, П-8), `assignment_deadline_at` (Р-7), `platform_delivery_subsidy` (Р-3).
Дополнения к `order_status_history`: `client_event_id` (unique, идемпотентность офлайн-событий), `device_recorded_at`, `server_received_at`, `point`, `location_unavailable_reason` (Р-18).

### 3.7. GPS

| Таблица | Ключевые поля | Примечание |
|---|---|---|
| `location_pings` | order_id, operator_user_id, point, accuracy_m, speed, heading, battery, recorded_at, received_at | секционирование по дням; срок хранения — настройка `gps_retention_hours` **без значения по умолчанию**, утверждено «пара дней», точное значение — П-16 |
| `order_routes` | order_id, polyline, distance_m, duration_s (с пробками), built_from_point, built_at, reason (initial / deviation / periodic) | маршрут и ETA (Р-19–21) |
| `order_last_location` | order_id (PK), point, recorded_at | быстрый доступ для карты заказчика |

### 3.8. Коммуникации

| Таблица | Ключевые поля |
|---|---|
| `chats` | order_id (unique), status (open / closed) |
| `chat_participants` | chat_id, user_id, side (customer / partner / support) |
| `chat_messages` | chat_id, sender_id, body, attachments, created_at, read_by |
| `call_sessions` | order_id, provider, virtual_number, caller_user_id, callee_user_id, started_at, duration_s, status, recording_file_id (В-27) |

### 3.9. Финансы

| Таблица | Ключевые поля | Ограничения |
|---|---|---|
| `payments` | order_id, provider, provider_payment_id, type (hold / charge), amount, status (pending / authorized / captured / cancelled / failed), idempotency_key | unique(idempotency_key), unique(provider, provider_payment_id) |
| `payment_webhook_events` | provider, event_id, payload, processed_at | unique(provider, event_id) — защита от повторной обработки |
| `refunds` | payment_id, order_id, amount, reason, status, provider_refund_id, initiated_by | — |
| `ledger_accounts` | code (customer_funds, platform_revenue, partner_payable:{org}, agent_payable:{org}, refunds …) | — |
| `ledger_entries` | transaction_id, account_id, debit, credit, order_id, payout_id, created_at | двойная запись: сумма по транзакции = 0; записи не изменяются |
| `payouts` | org_id, amount, status (scheduled / processing / paid / failed), scheduled_for, provider_payout_id, bank_account_id | — |
| `payout_items` | payout_id, order_id, amount, kind (partner / agent) | unique(order_id, kind) — **защита от повторной выплаты и повторного начисления агенту** |
| `disputes` | order_id, opened_by, reason, status, resolution, refund_amount, partner_amount_adj, resolved_by | на время спора выплата приостанавливается |
| `fiscal_receipts` | payment_id / refund_id, provider_receipt_id, status | чеки по 54-ФЗ (В-34) |

### 3.10. Агенты (независимые диспетчеры)

| Таблица | Ключевые поля | Ограничения |
|---|---|---|
| `agent_codes` | agent_org_id, code, active | unique(code) |
| `agent_attributions` | customer_id, agent_org_id, source, attributed_at, valid_until | правила по В-21/В-22 |
| `agent_commissions` | order_id, agent_org_id, base_amount, percent, amount, status (accrued / payable / paid / reversed) | **unique(order_id)** |

### 3.10а. Дополнения по решениям 03

| Таблица | Назначение |
|---|---|
| `quotes` | зафиксированный расчёт до поиска: reference_unit_id, reference_route_km, разбивка, срок действия (Н-1) |
| `order_shifts` | смены заказа ≤ 11 ч (Н-4, размещение — К-3) |
| `order_extensions` | запросы доп. времени: часы, сумма, status requested / approved / rejected (Н-5) |
| `customer_debts` / `debt_events` / `debt_case_packages` | задолженность по второй части, уведомления, пакет материалов для взыскания (Н-9) |
| `invoices` / `closing_documents` / `edo_dispatches` | счета, акты, УПД с НДС и без; отправка через Диадок / СБИС (Н-23) |
| `customer_legal_profiles` | заказчики-юрлица: ИНН, КПП, реквизиты, ЭДО-идентификатор |
| `unit_schedules` | расписание доступности техники (В-12) |
| `operator_verifications` + `category_operator_requirements` | проверка машинистов и требуемые допуски по категориям (В-32) |
| `customer_ratings` | оценка заказчика исполнителем (В-29) |
| `legal_holds` | продление хранения GPS, чатов и записей при споре (В-27, Н-19) |

Изменения: `equipment_units.allow_beyond_work_radius` (Н-17); у `reviews` нет публичного статуса, оценка привязана к машинисту (В-29, В-30); `operator_rating_avg` в профиле машиниста; `admin_roles` = superadmin / support / finance / moderator (В-40); `organizations.kind` дополнен `agent` с регистрацией через партнёрское приложение (Н-24).

### 3.11. Отзывы, жалобы, поддержка, уведомления, промо

| Таблица | Ключевые поля |
|---|---|
| `reviews` | order_id (unique), author_id, target_org_id, target_unit_id, target_operator_id, rating (1–5), text, status (published / hidden / on_moderation), partner_reply (В-29) |
| `review_complaints` | review_id, author_id, reason, status, resolved_by |
| `support_tickets` / `ticket_messages` | user_id, order_id?, topic, status, assignee_admin_id |
| `notifications` | user_id, app, type, title, body, payload, read_at |
| `notification_templates` | type, app, title, body (с переменными), channels |
| `broadcasts` | аудитория (фильтр), текст, отправлено, admin_id |
| `promo_codes` / `promo_redemptions` | этап 2, по решению (В-33) |

---

## 4. Статусная модель заказа

### 4.1. Технические статусы и соответствие трём видимым статусам

| Технический статус | Видит заказчик | Кто переводит дальше |
|---|---|---|
| `searching` — поиск (без оплаты; лимит 30 мин срочный / 6 ч предварительный) | Новый | система |
| `search_failed` — исполнитель не найден, деньги не списывались | Отменён / не найден (Н-16) | — |
| `offered` — предложен исполнителю | Новый («ищем») | исполнитель / таймер |
| `accepted` — принят исполнителем | В работе | система |
| `awaiting_prepayment` — ожидает предоплаты 50%, 10 минут (Н-8) | В работе | платёжный вебхук; таймаут → `cancelled_unpaid` без повторного поиска |
| `cancelled_unpaid` — отменён: предоплата не поступила | Отменён | — |
| `awaiting_assignment` — ждёт назначения техники и машиниста (10 минут, Р-7) | В работе | диспетчер / руководитель |
| `assigned` — машинист назначен, подтверждение машиниста не нужно (Р-9) | В работе | машинист «Выехал» |
| `en_route` — направляется | В работе | машинист |
| `arrived` — техника прибыла | В работе | машинист |
| `in_progress` — выполняется работа | В работе | машинист |
| `awaiting_completion_confirmation` — ждёт подтверждения | В работе | заказчик / автозавершение (срок — Н-19) |
| `awaiting_final_payment` — ожидает оплаты оставшихся 50%, 24 часа (Н-9) | Завершён / к оплате | платёжный вебхук; таймаут → долг (`customer_debts`) |
| `completed` — завершён | Завершён | — |
| `cancelled` — отменён | Отменён (В-16) | — |
| `refund_pending` — возврат средств | Отменён / Возврат | платёжный вебхук |
| `disputed` — спор | Спор | администратор |

> Схема переходов ниже нарисована до решения об оплате 50/50. Актуальный порядок: `searching ⇄ offered → accepted → awaiting_prepayment → awaiting_assignment → assigned → en_route → …`. Схему перерисую после ответа на Н-8.

### 4.2. Переходы [предложение по технике, правила ждут подтверждения]

```
awaiting_payment → searching ⇄ offered → accepted → awaiting_assignment → en_route → arrived → in_progress → awaiting_completion_confirmation → completed
        ↓              ↓          ↓          ↓              ↓                ↓          ↓            ↓                       ↓
     cancelled      cancelled / search_failed → refund_pending        cancelled (по правилам)               disputed ←───────┘
```

- Переходы описываются конечным автоматом в одном модуле. Каждый переход проверяет роль инициатора и пишет запись в `order_status_history` в той же транзакции.
- **Возврат в общий поиск** (`return_to_search`) из `accepted` / `awaiting_assignment` / `assigned` / `en_route`: истёк срок назначения (Р-7), нет замены техники (Р-3), нет замены машинисту (Р-16). Цена для заказчика не меняется.
- Замена машиниста (Р-8) и техники внутри компании (Р-3) не меняют статус заказа, а пишутся в `order_assignments` и историю.
- Статусы машиниста принимаются офлайн-пачкой с временем устройства (Р-18).
- Обновление заказа идёт через `UPDATE … WHERE id=? AND status=? AND version=?`. Если ни одна строка не обновилась, переход отклоняется (конфликт).

---

## 5. Алгоритм распределения

### 5.1. Отбор кандидатов (один SQL-запрос)

- Категория совпадает, требуемые характеристики удовлетворены (`attributes` сравниваются с `required_attributes` по типам: «не меньше», «равно», «входит в список»).
- Техника `approved`, организация `verified` и не заблокирована, техника `is_online`.
- `ST_DWithin(base_point, site_point, LEAST(work_radius_km, текущий_радиус_поиска))` (как сочетать радиусы — В-9).
- Нет пересечения в `unit_bookings` на интервал заказа (интервал с учётом дороги — В-13).
- Этой технике / организации ещё не предлагали этот заказ (В-8: повторно ли предлагать той же компании другой единицей).

### 5.2. Ранжирование

Сначала предварительная сортировка по прямому расстоянию. Затем для top-N кандидатов запрашивается **маршрутное** расстояние: так ограничивается стоимость запросов к маршрутизатору. Итоговый балл — взвешенная сумма:

Утверждено (В-7): расстояние, рейтинг машиниста, надёжность (принятые и выполненные заказы, отказы, отмены), загрузка. Жёсткие фильтры: доступность (линия + расписание + календарь, В-12), категория, рабочий радиус (или флаг выхода за него, Н-17).

`score = w1·близость + w2·рейтинг + w3·надёжность + w4·(1 − загрузка)`

Веса задаются в админке (значения по умолчанию — К-6). У нового исполнителя рейтинг и надёжность принимаются нейтральными (средними по пулу), а не нулевыми. Как учитывать рейтинг машиниста до назначения — К-5.

Радиус (Н-17): 30 км → +20 км каждые 2 минуты → максимум 150 км. Срок поиска: срочный 30 мин, предварительный 6 ч (граница — К-2).

### 5.3. Цикл предложений

1. Транзакция: вставка `order_offers(pending, expires_at = now()+offer_timeout)`, статус заказа `offered`. Частичный уникальный индекс не даст создать второе активное предложение.
2. Push и WS-событие исполнителю. Отложенная задача BullMQ сработает через `offer_timeout`.
3. **Принять:** в транзакции `SELECT … FOR UPDATE` по заказу и офферу → проверка `status='pending' AND now() < expires_at` → вставка в `unit_bookings` (exclusion constraint защищает от занятости техники) → `accepted` → коммит. Опоздавший ответ получает ошибку `OFFER_EXPIRED`.
4. **Пропустить / тайм-аут:** оффер `skipped`/`expired` → следующий кандидат. Тайм-аут обрабатывается идемпотентно: если оффер уже не `pending`, задача ничего не делает.
5. **Нет кандидатов:** следующий шаг радиуса по настройке (например, +N км каждые M секунд до максимума). Шаги и максимум — В-9. По исчерпании — В-10.
6. Время на клиенте сверяется с сервером: таймер 40 с показывается по `expires_at` от сервера, а не от момента получения push.

### 5.4. Корпоративный сценарий (по решениям Р-3…Р-16)

1. Предложение адресуется организации с указанием подходящей единицы техники. Принимает диспетчер или руководитель; ИП без диспетчера — сам (Р-4). Кто получает предложение при нескольких диспетчерах — П-8.
2. После принятия — `awaiting_assignment`, таймер 10 минут (Р-7) и напоминания.
3. Диспетчер видит список свободных в этот день машинистов своей компании (проверка единого календаря, Р-6) и выбирает одного. Назначение без подтверждения машиниста (Р-9), машинист получает уведомление.
4. Замена машиниста — в любой момент на свободного, заказчик получает имя и фото нового (Р-8). Отказ машиниста → диспетчер назначает другого, иначе возврат в поиск (Р-16).
5. Поломка или невозможность техники → замена из парка компании, цена для заказчика сохраняется, удорожание доставки покрывает платформа. Иначе возврат в поиск (Р-3).

---

## 6. Расчёт стоимости

```
аренда   = f(тариф категории в регионе, длительность)   ← точная формула: В-1
доставка = route_km(база техники → объект) × 2 × km_price(категория, регион)
итого    = аренда + доставка (− промо, если будет)
```

- Тариф выбирается по региону **объекта** (В-3: какой регион, если база и объект в разных регионах).
- Снимок цены (id тарифа, все составляющие, % комиссии) сохраняется в заказе при подтверждении. Последующие изменения тарифа его не затрагивают.
- Округление route_km и сумм — В-2.
- Утверждено: минимум 4 ч, максимум стандартной смены 11 ч, шаг 1 ч, доп. время — по почасовому тарифу, промокод −10%.
- Цена для заказчика фиксируется и не меняется при замене. Исполнитель получает фактическую доставку, разница проводится по счёту платформы (П-3).
- Открыто: от какой базы считать доставку до поиска (Н-1), формула аренды (Н-3), смены длиннее 11 ч (Н-4), переработка (Н-5), округления (Н-6), регион тарифа (Н-7).

---

## 7. Финансовая логика [предложение по технике]

1. Поиск идёт без оплаты. После принятия исполнителем — платёж 50% с ключом идемпотентности (двойное нажатие «Оплатить» не создаёт второго списания).
2. Вебхук провайдера (проверка подписи, дедупликация по event_id) → проводка `customer_funds` → заказ идёт дальше. Вторые 50% — после выполнения (механизм — Н-9).
2а. Провайдер подключается через интерфейс `PaymentProvider`, первая реализация — ЮKassa. Заказчики-юрлица и документооборот (счета, акты, НДС) — Н-11, Н-23.
3. Завершение → проводки: `platform_revenue += комиссия`, `partner_payable[org] += сумма исполнителя`, `agent_payable[org] += комиссия агента` (откуда берётся — В-20).
4. Ежедневная задача выплат: заказы, завершённые «вчера» (по часовому поясу — В-18), без открытых споров → `payouts` + `payout_items` (уникальность по заказу) → запрос выплаты провайдеру → вебхук → `paid`.
5. Отмены и возвраты — по политике отмены (В-15), с обратными проводками и чеком возврата.
6. Модель приёма платежа и выплат (агентская схема, «безопасная сделка», мультирасчёты) — В-34/В-35, решается с юристом и провайдером. Платформа сама деньги не хранит: деньги лежат на номинальном или специальном счёте провайдера, а ledger — это учёт, а не «кошелёк».

---

## 8. API

Общее: `REST /api/v1`, JSON, JWT access-токен (15 мин) + refresh-токен с ротацией, отдельные области прав для `client`, `partner`, `admin`. Заголовок `Idempotency-Key` обязателен на всех операциях с деньгами и на принятии заказа. Пагинация курсором. Единый формат ошибок `{code, message, details}`. Документация — OpenAPI.

### 8.1. Общие

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/auth/otp/request` | отправить SMS-код (phone, app) |
| POST | `/auth/otp/verify` | проверить код → токены |
| POST | `/auth/refresh` · `/auth/logout` | токены |
| GET/PATCH | `/me` | профиль, фото |
| POST/DELETE | `/me/push-devices` | регистрация push-токена |
| POST | `/files/upload-url` | presigned URL для загрузки → file_id |
| GET | `/files/{id}/url` | временная ссылка (с проверкой прав) |
| GET | `/dictionary/categories` | категории + характеристики |
| GET | `/dictionary/regions` | регионы, города, зоны |
| GET | `/geo/geocode` · `/geo/reverse` · `/geo/suggest` | прокси к картографическому провайдеру (ключи не хранятся в приложении) |
| GET/POST | `/chats/{orderId}/messages` | история / отправка |
| POST | `/chats/{orderId}/read` | отметка о прочтении |
| POST | `/calls/{orderId}` | получить подменный номер для звонка |
| GET/POST | `/support/tickets` · `/support/tickets/{id}/messages` | поддержка |
| GET | `/notifications` · POST `/notifications/read` | центр уведомлений |

### 8.2. Приложение заказчика (`/client`)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/client/quotes` | предварительный расчёт (site, категория, характеристики, дата, длительность) → разбивка цены, quote_id, срок действия |
| POST | `/client/orders` | создать заказ из quote (+ agent/promo code) |
| POST | `/client/orders/{id}/payment` | инициировать оплату → данные для платёжного SDK / redirect |
| GET | `/client/orders` | история (фильтр по статусу) |
| GET | `/client/orders/{id}` | детали: статус, история, исполнитель, компания, машинист (ФИО, фото), техника |
| GET | `/client/orders/{id}/location` | последняя позиция + время обновления |
| POST | `/client/orders/{id}/cancel/preview` | условия и сумма возврата при отмене сейчас |
| POST | `/client/orders/{id}/cancel` | отмена |
| POST | `/client/orders/{id}/confirm-completion` | подтвердить завершение |
| POST | `/client/orders/{id}/dispute` | открыть спор |
| POST | `/client/orders/{id}/review` | оценка + отзыв |
| POST | `/client/reviews/{id}/complaint` | жалоба на отзыв (если заказчикам доступно) |

### 8.3. Приложение партнёра (`/partner`)

**Организация и модерация**

| Метод | Путь | Роль |
|---|---|---|
Все запросы `/partner/*` выполняются в контексте организации (`X-Org-Id`), права проверяются по роли в этой организации (Р-13). `GET /partner/memberships` — список организаций и ролей для переключателя.

| POST | `/partner/organizations` | создать (ИП/ЮЛ), ИНН/ОГРН | любой новый пользователь (становится `owner`) |
| GET/PATCH | `/partner/organizations/current` | реквизиты | owner |
| POST | `/partner/organizations/current/submit` | отправить на проверку | owner |
| GET/PUT | `/partner/organizations/current/bank-account` | реквизиты для выплат | owner |
| GET/POST/DELETE | `/partner/organizations/current/documents` | документы | owner, dispatcher |
| GET/POST | `/partner/members` · PATCH/DELETE `/partner/members/{id}` · POST `/partner/members/{id}/block` · `/detach` | сотрудники, приглашения, блокировка, отвязка | owner, manager (Р-2); роль manager выдаёт/отзывает только owner (Р-11) |
| GET | `/partner/invitations` · POST `/partner/invitations/{id}/accept` · `/decline` | приглашения пользователя в компании | приглашённый (Р-14) |
| POST | `/partner/memberships/{orgId}/leave` | машинист прекращает сотрудничество (П-11) | operator |

**Автопарк**

| Метод | Путь | Роль |
|---|---|---|
| GET/POST | `/partner/units` | список / добавить | owner, dispatcher |
| GET/PATCH/DELETE | `/partner/units/{id}` | карточка, характеристики, база, радиус | owner, dispatcher |
| POST/DELETE | `/partner/units/{id}/photos` · `/documents` | медиа и документы | owner, dispatcher |
| POST | `/partner/units/{id}/submit` | на проверку | owner, dispatcher |
| POST | `/partner/units/{id}/online` · `/offline` | выход на линию / снятие | owner, dispatcher |
| GET/PUT | `/partner/units/{id}/availability` | расписание доступности | owner, dispatcher |

**Заказы**

| Метод | Путь | Роль |
|---|---|---|
| GET | `/partner/offers/active` | текущие предложения (с `expires_at`) | owner, dispatcher |
| POST | `/partner/offers/{id}/accept` | принять (Idempotency-Key) | owner, dispatcher |
| POST | `/partner/offers/{id}/skip` | пропустить | owner, dispatcher |
| GET | `/partner/orders` · `/partner/orders/{id}` | заказы организации | owner, dispatcher |
| GET | `/partner/orders/{id}/available-operators` | свободные в этот день машинисты компании (Р-6) | owner, manager, dispatcher |
| POST | `/partner/orders/{id}/assign-operator` · `/reassign-operator` | назначить / заменить машиниста (Р-6, Р-8) | owner, manager, dispatcher |
| GET | `/partner/orders/{id}/replacement-units` · POST `/replace-unit` | замена техники из парка (Р-3) | owner, manager, dispatcher |
| POST | `/partner/orders/{id}/release` | «не можем выполнить» → возврат в поиск (Р-3, Р-16) | owner, manager, dispatcher |
| POST | `/partner/orders/{id}/cancel` | отказ после принятия (В-15) | owner, manager, dispatcher |

Поля цены в ответах `/partner/orders` для `dispatcher` есть только в заказах, которыми он управляет (Р-1).

**Машинист**

| Метод | Путь |
|---|---|
| GET | `/partner/operator/orders` · `/partner/operator/orders/{id}` — только назначенные |
| POST | `/partner/operator/orders/{id}/status-events` — пачка офлайн-событий `{client_event_id, status, device_recorded_at, point? / location_unavailable_reason}` (Р-18) |
| POST | `/partner/operator/orders/{id}/decline` — отказ от заказа с причиной (Р-16) |
| POST | `/partner/operator/orders/{id}/incidents` — поломка или другая проблема (Р-17) |
| POST | `/partner/operator/locations` — пачка координат (принимаются только от назначенного машиниста в окне трекинга, П-1/П-2) |

Календарь машиниста и список его заказов агрегируются по всем компаниям, при этом каждая карточка видна в контексте своей компании.

**Финансы, отзывы, агент**

| Метод | Путь | Роль |
|---|---|---|
| GET | `/partner/finance/summary` · `/accruals` · `/payouts` | owner, manager (диспетчеру недоступно — Р-1) |
| GET | `/partner/reviews` · POST `/partner/reviews/{id}/complaint` | owner, dispatcher |
| GET | `/partner/agent/codes` · `/agent/customers` · `/agent/commissions` · `/agent/payouts` | агент |

### 8.4. Админ-панель (`/admin`)

Все запросы проходят проверку прав админ-роли и пишутся в аудит.

| Группа | Эндпоинты |
|---|---|
| Авторизация | `POST /admin/auth/login`, `/admin/auth/2fa` |
| Пользователи | `GET /admin/users`, `GET /admin/users/{id}`, `POST /admin/users/{id}/block` · `/unblock` |
| Организации | `GET /admin/organizations?status=`, `GET /{id}`, `POST /{id}/approve`, `/reject {reason}`, `/block`, `/unblock`, `POST /{id}/transfer-ownership` (документы-основания, Р-12) |
| Документы | `GET /admin/documents?status=`, `POST /admin/documents/{id}/approve` · `/reject` |
| Техника | `GET /admin/units`, `POST /admin/units/{id}/approve` · `/reject` · `/force-offline` |
| Справочники | CRUD `/admin/categories`, `/admin/categories/{id}/attributes`, `/admin/document-types`, `/admin/regions`, `/admin/cities`, `/admin/zones` |
| Тарифы | `GET/POST /admin/tariffs` (новая версия), `POST /admin/tariffs/import` (стартовая таблица CSV/XLSX) |
| Комиссии и настройки | `/admin/commission-rules`, `/admin/agent-commission-rules`, `/admin/cancellation-policies`, `GET/PATCH /admin/settings` |
| Заказы | `GET /admin/orders` (фильтры), `GET /{id}` (история, офферы, matching_runs, трек, чат), `POST /{id}/cancel`, `/reassign`, `/change-status` (с обязательной причиной) |
| Платежи | `GET /admin/payments`, `POST /admin/payments/{id}/refund` |
| Выплаты | `GET /admin/payouts`, `POST /{id}/retry`, `/hold`, `/release` |
| Споры | `GET /admin/disputes`, `POST /{id}/resolve` |
| Отзывы и жалобы | `GET /admin/reviews`, `POST /{id}/hide` · `/publish`, `GET /admin/review-complaints`, `GET /admin/complaints` |
| Поддержка | `GET /admin/tickets`, ответы |
| Рассылки | `POST /admin/broadcasts` |
| Промо | `/admin/promo-codes` (позже) |
| Отчёты | `GET /admin/reports/{orders\|finance\|payouts\|agents}?from&to&region` + экспорт |
| Аудит | `GET /admin/audit-log` |

### 8.5. WebSocket (Socket.IO, авторизация по JWT)

| Событие | Получатель |
|---|---|
| `offer.new` / `offer.revoked` / `offer.expired` | диспетчеры и руководитель организации |
| `order.status_changed` | участники заказа |
| `order.assigned` | машинист, заказчик |
| `order.location` / `order.route_updated` / `order.eta` | заказчик (комната заказа); ETA только от свежей точки (Р-19–21) |
| `order.operator_changed` / `order.unit_changed` | заказчик (Р-8, Р-3) |
| `assignment.deadline_reminder` | диспетчеры и руководители (Р-7) |
| `offer.taken` | остальные диспетчеры компании |
| `chat.message` / `chat.read` | участники чата |
| `notification.new` | пользователь |
| `admin.order_updated` | админка (живой мониторинг) |

Push дублирует критичные события, когда приложение в фоне.

### 8.6. Вебхуки (входящие)

`POST /webhooks/payments/{provider}`, `/webhooks/telephony/{provider}`, `/webhooks/sms/{provider}` — с проверкой подписи и дедупликацией.

---

## 9. Противоречия, пробелы и риски

### 9.1. Противоречия в ТЗ

1. ~~**Оплата до подбора и доставка от базы конкретной техники.**~~ **Решено:** оплата 50% после принятия. Осталась часть про цену до поиска — Н-1. По §7 и §8 оплата происходит до поиска исполнителя. По §13 доставка считается от базы конкретной единицы, которая известна только после принятия. Заказчик по §13 должен видеть точную сумму до подтверждения. Варианты (выбирать вам, см. В-0):
   - а) холд максимальной суммы (доставка рассчитывается по максимальному радиусу поиска), списание фактической суммы после принятия;
   - б) доставка по ближайшему подходящему кандидату на момент расчёта, а при передаче заказа дальше — платформа покрывает разницу либо исполнитель соглашается на цену;
   - в) доставка по фиксированной зональной ставке региона (без привязки к базе);
   - г) предложение показывается исполнителю с ценой, рассчитанной от его базы; если сумма выше оплаченной — доплата заказчиком с подтверждением.
2. **Расширение радиуса и рабочий радиус единицы.** Партнёр задаёт радиус работы, а система «расширяет радиус поиска». Может ли система предлагать заказ технике за пределами её рабочего радиуса? (В-9)
3. **Последовательный оффер и компания с несколькими единицами.** Предлагается единица или компания? Если диспетчер после принятия назначает другую единицу (с другой базой), меняется доставка, уже оплаченная заказчиком. (В-5)
4. **«Стоимость одного часа» и «стоимость дополнительного часа».** Неясно, как они соотносятся с минимальной сменой. (В-1)
5. **Три видимых статуса и «Отменён/Спор».** «Отменён», «Возврат», «Спор» не попадают ни в «Новый», ни в «В работе», ни в «Завершён». (В-16)
6. **Выплата на следующий день и споры/подтверждение завершения.** Если заказчик не подтвердил завершение или открыл спор, выплата T+1 противоречит контролю выполнения. (В-14, В-17)
7. **«Исполнитель не получает уведомлений об оплате».** Если он видит заказ только после оплаты, это выполняется автоматически. Но при варианте 1а/1г (холд/доплата) нужно правило, что именно он видит.

### 9.2. Недостающие требования

- Формула аренды, округления, переработка (работа дольше заказанного), простой.
- Правила отмены и штрафов для каждой стороны и каждого этапа.
- Что происходит, если исполнитель не найден (сколько ищем, автовозврат).
- Кто и как подтверждает завершение, автоподтверждение.
- Заказчики-юрлица: оплата по счёту, закрывающие документы (акты, УПД), НДС. Для B2B-рынка спецтехники это, скорее всего, большая доля клиентов.
- Срочный заказ («сейчас») и заказ на будущее: минимальное время до начала, максимальный горизонт.
- Модель доступности техники: переключатель «на линии» или календарь.
- Список документов (ТЗ прямо откладывает это на согласование).
- Проверка ИНН/ОГРН: вручную или через ФНС/DaData.
- Фискализация (54-ФЗ), агентская схема, налоговая модель платформы.
- Политика хранения GPS, записей звонков, переписки (152-ФЗ, хранение ПДн в РФ).
- Подроли админов (модератор, финансист, поддержка).
- Мультиязычность, валюта (предполагаю: только русский и рубли — подтвердите).
- Работает ли ИП-одиночка сам машинистом.
- Возможность заказать несколько единиц техники в одном заказе.

### 9.3. Технические риски

| Риск | Влияние | Митигация |
|---|---|---|
| Фоновая геолокация (iOS-ревью, «убийцы» фоновых процессов на Xiaomi/Huawei/Samsung) | трек обрывается | foreground service, инструкция по настройке батареи, показ «последнее обновление N мин назад», запасной вариант — платная библиотека |
| App Store Review: обоснование фоновой геолокации, логин по телефону, тестовые аккаунты | задержка публикации | готовим тексты и демо-аккаунты заранее |
| Платёжная схема с расщеплением и выплатами ЮЛ/ИП требует договора с провайдером и KYC платформы | блокирует финансовый модуль | выбрать провайдера на этапе 1, параллельно с разработкой |
| Стоимость маршрутизации (запрос на каждого кандидата и каждый расчёт) | расходы, лимиты | сначала фильтр по прямой, маршрут только для top-N, кэш |
| Гонки при принятии заказа | двойное назначение | транзакции + FOR UPDATE + частичный уникальный индекс + exclusion constraint + нагрузочные тесты |
| Таймеры 40 с при перезапуске сервера | заказ «зависает» | задачи в Redis (BullMQ) + периодический «подметальщик» просроченных офферов |
| Подменные номера: стоимость, номерная ёмкость, правила операторов | расходы, задержка | выбор провайдера, пул номеров на регион |
| SMS-фрод (накрутка отправки кодов) | расходы | rate limit, капча, лимиты по IP/номеру |
| Утечка документов / ПДн | юридические риски | приватное хранилище, presigned URL, шифрование полей, аудит |
| Объём `location_pings` | нагрузка на БД | секционирование, срок хранения, прореживание |
| Отсутствие аккаунтов провайдеров на старте | интеграции нельзя проверить | адаптеры с sandbox-режимом провайдеров; заглушки только с вашего явного согласия (§21 ТЗ) |

---

## 10. Вопросы к заказчику

**Актуальный список открытых вопросов — в [decisions/02](decisions/02-business-rules.md#новые-вопросы-н-1н-24) (Н-1…Н-24 и оставшиеся В).**

**Закрыты решениями блока 01:** В-4 (Р-1, Р-2), В-11 (Р-7), В-25 (Р-14, затем изменено П-10).
**Частично закрыты:** В-5 (замена техники — Р-3; кому адресуется оффер — П-8), В-6 (П-8), В-24 (П-13), В-26 (П-14), В-31 (П-16).
**Новые вопросы по блоку:** П-1…П-19 в [decisions/01](decisions/01-partners-and-companies.md#противоречия-и-вопросы-по-блоку).

Без ответов на В-0…В-18 нельзя начинать бизнес-модули (заказы, деньги). Остальные вопросы можно закрывать по ходу.

**Цена и оплата**
- **В-0.** Как решаем конфликт «оплата до подбора и доставка от базы» (варианты 1а–1г в §9.1 или свой)?
- **В-1.** Точная формула аренды. Например: `если часы ≤ min_hours → min_shift_price, иначе min_shift_price + (часы − min_hours) × extra_hour_price`? Для чего тогда нужна «стоимость одного часа»?
- **В-2.** Шаг длительности (1 ч, 0,5 ч?). Округление километров и сумм.
- **В-3.** Регион тарифа, если база в одном регионе, а объект в другом.
- **В-4.** Права диспетчера: видит ли финансы? Может ли приглашать других диспетчеров или только машинистов?
- **В-5.** Оффер адресуется единице техники или компании? Может ли диспетчер после принятия заменить технику другой единицей, и что тогда с ценой доставки?
- **В-6.** В компании оффер видят все диспетчеры одновременно? Это всё ещё «один исполнитель» в смысле последовательной выдачи?
- **В-7.** Факторы подбора и их приоритет. Как ранжируется новый партнёр без рейтинга?
- **В-8.** Если компания пропустила заказ одной единицей, предлагать ли его её другой единице?
- **В-9.** Правила расширения радиуса: начальный радиус, шаг, интервал, максимум. Может ли система выходить за рабочий радиус единицы?
- **В-10.** Сколько длится поиск, если никто не принял? Автоотмена и полный возврат? Уведомление админа для ручного подбора?
- **В-11.** Сколько времени у компании на назначение машиниста после принятия? Что, если не назначила?
- **В-12.** Доступность техники — это переключатель «на линии», расписание (дни/часы) или календарь занятости?
- **В-13.** Учитывать ли время дороги и буфер между заказами одной техники?
- **В-14.** Кто подтверждает завершение (заказчик?), есть ли автоподтверждение через N часов?
- **В-15.** Правила отмены: заказчиком до принятия, после принятия, после выезда, после прибытия. Отказ исполнителя после принятия (штраф, рейтинг, переподбор?).
- **В-16.** Какие статусы видит заказчик для отмены, возврата и спора?
- **В-17.** Что значит «на следующий день»: следующий календарный или рабочий день? После подтверждения заказчиком или после окончания работы? Что со спорами?
- **В-18.** Переработка: если работа длилась дольше заказанного, как это оплачивается (доплата, повторный платёж)? Возможно ли продление из приложения?
- **В-19.** Кто такие заказчики: только физлица или и юрлица со счетами и закрывающими документами?

**Независимые диспетчеры (агенты)**
- **В-20.** Комиссия агента берётся из комиссии платформы, из доли исполнителя или добавляется к цене заказчика?
- **В-21.** Как агент «привлекает» клиента: реферальный код/ссылка, или агент сам оформляет заказы от имени клиентов? В каком приложении он работает?
- **В-22.** Клиент привязывается к агенту навсегда, на срок или только на один заказ? Что, если клиент пришёл по кодам двух агентов?
- **В-23.** Может ли организация быть одновременно партнёром и агентом?

**Роли и сценарии**
- **В-24.** ИП-одиночка может сам быть машинистом своей техники?
- **В-25.** Может ли машинист работать в нескольких компаниях?
- **В-26.** С кем говорит и переписывается заказчик в корпоративном заказе: с диспетчером, машинистом или с обоими?
- **В-27.** Записывать ли звонки? Хранить ли переписку и сколько?
- **В-28.** Нужен ли заказ на «прямо сейчас»? Минимальное время до начала и максимальный горизонт планирования?
- **В-29.** Может ли партнёр отвечать на отзывы? Оценивает ли исполнитель заказчика?
- **В-30.** Рейтинг относится к компании, к единице техники или к машинисту?

**Юридическое и инфраструктура**
- **В-31.** Срок хранения GPS-треков.
- **В-32.** Список документов для ИП, ЮЛ, техники и машиниста. Нужна ли автоматическая проверка ИНН/ОГРН (ФНС/DaData)?
- **В-33.** Промокоды в первом релизе — да или нет? Кто финансирует скидку?
- **В-34.** Выбранный или предпочтительный платёжный провайдер (ЮKassa, Т-Банк Мультирасчёты, Сбер и т. п.) и юридическая схема (агентская?). Кто выдаёт чеки?
- **В-35.** Провайдеры: SMS, телефония (подменные номера), карты/маршруты (Яндекс, 2ГИС, OSRM на своём сервере). Есть ли уже договоры или ключи?
- **В-36.** Регионы первого запуска и стартовые категории техники.
- **В-37.** Хостинг (облако в РФ: Yandex Cloud, VK Cloud, Selectel?). Требование хранить ПДн в РФ.
- **В-38.** Аккаунты Apple Developer и Google Play — на кого оформляются, есть ли уже?
- **В-39.** Есть ли дизайн или макеты, брендбук? Или делаем экраны по системному UI-киту?
- **В-40.** Подроли администраторов (модератор, финансы, поддержка, суперадмин)?

---

## 11. Этапы разработки

У каждого этапа есть критерий приёмки. К следующему этапу переходим только после проверки предыдущего (ТЗ §20–21).

| # | Этап | Содержание | Критерий приёмки |
|---|---|---|---|
| **0а** | Дизайн | UI-kit «Ковш на Час», ключевые экраны трёх интерфейсов, утверждение сценариев (В-39, К-16). Идёт параллельно с этапами 1–5 | Экраны утверждены вами |
| **0** | Согласование | Ответы на вопросы, выбор провайдеров, ADR, финализация схемы БД и статусов | Документ подписан вами |
| **1** | Фундамент | Монорепо, CI (lint, typecheck, tests), docker-compose (PG+PostGIS, Redis, MinIO), каркас NestJS, миграции, конфигурация, логирование, OpenAPI | `pnpm test` и CI зелёные, API поднимается локально |
| **2** | Auth и пользователи | SMS-OTP (адаптер провайдера), JWT/refresh, роли и guards, push-устройства, файлы | Интеграционные тесты входа и прав доступа |
| **3** | Организации и модерация | ИП/ЮЛ, реквизиты (шифрование), документы, статусы, сотрудники и приглашения, админ-модерация, аудит | Партнёр проходит путь от регистрации до «Подтверждён» через API и админку |
| **4** | Справочники, техника, тарифы | Регионы/зоны, категории и характеристики, карточки техники, проверка техники, линия и доступность, тарифы с версиями, комиссии, настройки | Админ заводит стартовую тарифную сетку (импорт), партнёр выводит технику на линию |
| **5** | Расчёт цены | Адаптер маршрутизации, quote API, снимок цены | Юнит-тесты формул на наборах примеров, которые вы утвердите |
| **6** | Заказы и распределение | Автомат статусов, подбор, офферы 40 с, расширение радиуса, бронирования, назначение машиниста | Тесты гонок (параллельное принятие), тайм-аутов, перезапуска воркера |
| **7** | Платежи и финансы | Адаптер провайдера (sandbox), вебхуки, идемпотентность, ledger, отмены и возвраты, выплаты T+1, агентские начисления, споры | Сквозной сценарий в песочнице провайдера, тесты двойной оплаты и повторной выплаты |
| **8** | Коммуникации | WebSocket, чат, подменные номера, push и шаблоны уведомлений, поддержка | Сценарии §16 ТЗ покрыты тестами отправки |
| **9** | GPS | Приём пачек координат, проверка прав, последняя позиция, срок хранения | Координаты принимаются только от назначенного машиниста при активном заказе |
| **10** | Приложение заказчика | Все экраны §2.1 | Сквозной заказ на реальных устройствах (iOS + Android) |
| **11** | Приложение партнёра | Онбординг, автопарк, офферы с таймером, диспетчер, режим машиниста, фоновый GPS, финансы | Фоновый трек при заблокированном экране на iOS и Android |
| **12** | Админ-панель | Все разделы §2.3 + отчёты | Админ выполняет все операции из ТЗ |
| **13** | Тестирование и безопасность | Полный чек-лист §7 ТЗ, нагрузочный тест распределения, ревью безопасности, бэкапы и восстановление | Отчёт о тестировании |
| **14** | Запуск | Прод-инфраструктура, мониторинг (Sentry, метрики, алерты), публикация в сторах, пилотный регион | Первые реальные заказы |

Порядок отличается от ТЗ §20 (там сначала весь backend, затем приложения) только тем, что интеграции встроены в соответствующие модули, а не вынесены в отдельный этап. Так каждый модуль проверяется с реальным провайдером (в песочнице) сразу. Если вам важен исходный порядок — оставлю его.

---

## 12. Что мне нужно от вас для старта

1. Ответы на вопросы В-0…В-19 (минимум для старта этапов 1–4: В-4, В-12, В-24, В-25, В-32, В-36, В-37).
2. Подтверждение архитектуры (§2) или ваши предпочтения по стеку.
3. Подтверждение порядка этапов (§11).

После этого начну с этапа 1 (фундамент) и после каждого этапа буду показывать результат.
