# Модель данных

Все таблицы metadata plane — Postgres. События — Event Store (см. [02-storage.md](02-storage.md)).

## 1. Тенантность и доступ

```sql
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  slug        text NOT NULL,              -- 'my-saas': человекочитаемый id для MCP/API
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid REFERENCES projects(id),     -- NULL для pt_ (скоуп в key_scopes)
  org_id      uuid NOT NULL REFERENCES organizations(id),
  kind        text NOT NULL CHECK (kind IN ('ingest','secret','personal')),
  env         text NOT NULL DEFAULT 'prod',     -- имеет смысл для ingest-ключей
  token_hash  text NOT NULL,                    -- храним только hash, сам токен показываем один раз
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
```

Среда (`env`) — атрибут ключа, а не сущность: ingest-ключ `pk_…` выпускается на `prod`/`dev`, и все принятые им события автоматически помечаются этим env. Так невозможно «случайно» прислать дев-события в прод — у дев-сборки просто другой ключ.

## 2. Events — факты с аудируемыми исправлениями

Логическая схема (физическая — в адаптере хранилища):

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | uuid | стабильный id события для inspection и correction |
| `project_id` | uuid | изоляция тенанта |
| `env` | text | `prod` / `dev` / … — из ingest-ключа |
| `event` | text | имя события, стандарт `object.action`: `checkout.completed` |
| `timestamp` | timestamptz(ms) | время события (от клиента, с защитой от клоксью) |
| `distinct_id` | text | идентификатор актора (id пользователя из продукта) |
| `session_id` | text? | группировка в сессию, опционально |
| `properties` | json | произвольные свойства события |
| `registered` | bool | соответствует ли событие активной метрике реестра |
| `ingested_at` | timestamptz | время приёма сервером |
| `revision` | integer | текущая версия materialized-факта, начиная с 1 |
| `origin` | text | `live` или `backfill` |
| `backfill_batch_id` | uuid? | ссылка на исторический batch-аудит |

Правила:

- Обычный ingest остаётся **append-only**. Исправить нативное событие можно только
  через preview + optimistic revision: текущая materialized-строка меняется для
  всех запросов, а `event_revisions` навсегда сохраняет actor, reason и
  before/after. System/Browser Experience evidence не редактируется.
- Исторический backfill — отдельный Platform API: все timestamps обязательны,
  batch валидируется целиком и сохраняется только all-or-nothing. Постоянный
  `batch_id` и payload hash делают retry идемпотентным.
- GDPR-удаление ищет `distinct_id` и в текущем событии, и во всех before/after
  snapshots, затем под тем же row lock удаляет событие и персональный audit.
  Batch-аудит без event payload остаётся. Большой purge идёт ограниченными
  batch-ами по server-time snapshot: события, принятые после начала операции,
  относятся уже к следующему purge, поэтому непрерывный ingest не удерживает
  необратимый HTTP-запрос бесконечно.
- Retention удаляет revision snapshots атомарно с истёкшим событием: audit не
  продлевает срок хранения PII.
- **Имена:** `snake_case`, формат `object.action`. Префикс `$` зарезервирован за системными событиями и свойствами (`$session_start`, `$utm_source`).
- **`registered`:** ставится на ингесте сверкой с реестром метрик. Незарегистрированные события принимаются и хранятся — но платформа видит долю «дикой» инструментации по проекту (метрика качества данных, вход для инсайтов).

### Идентификация акторов

`distinct_id` — внешний id из продукта. Стабильный id остаётся лучшим вариантом, но
anonymous→identified flow поддерживается через `actor_links`. Связь ограничена project + env,
проверяется на циклы/конфликты и может быть отозвана. События не переписываются: canonical
actor вычисляется при чтении, а создание/отзыв попадают в append-only `actor_link_audit`.

Typed `actors` query агрегирует canonical population в bounded временном окне:
first/last seen, total events, active days, registered-only top events и
nullable trusted Browser session count. Это read model поверх immutable
events, а не новая `users` table. `linked` доказывается active link provenance
или несколькими raw IDs; без server-owned stable/anonymous provenance статус
`unknown`, а обнаруженный конфликт даёт `ambiguous`.

Person detail использует ту же canonical population, возвращает bounded raw
IDs/link provenance и keyset-paginated registered activity. Arbitrary entity
или event properties не становятся identity/pinned properties автоматически:
без deterministic mapping, allowlist и masking policy они fail closed.
GDPR/admin purge по `distinct_id` остаётся exact raw-ID удалением и никогда
не расширяет blast radius на canonical actor.

## 3. Entities — «статичные» данные с состоянием

Изменяемые объекты продукта: пользователи, аккаунты, документы — всё, у чего есть текущее состояние, а не поток фактов.

```sql
CREATE TABLE entity_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  name         text NOT NULL,        -- 'user', 'account', 'document'
  description  text NOT NULL,        -- зачем этот тип нужен (семантика обязательна)
  prop_schema  jsonb,                -- JSON Schema свойств: рекомендательная, не блокирующая
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE entities (
  project_id   uuid NOT NULL REFERENCES projects(id),
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,        -- внешний id из продукта
  env          text NOT NULL DEFAULT 'prod',
  properties   jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, env, entity_type, entity_id)
);
CREATE INDEX entities_props_gin ON entities USING gin (properties);
```

- Семантика записи — **upsert с merge свойств** (присланные ключи перезаписывают, остальные сохраняются; `null` удаляет ключ).
- Событие ссылается на сущность через `distinct_id` (актор = entity типа `user`) и/или свойства-ссылки (`account_id` в `properties`).
- История изменений свойств — не в MVP; при необходимости добавится append-таблица `entity_changes`.

## 4. Metrics — реестр с семантикой (ядро платформы)

```sql
CREATE TABLE metrics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  key         text NOT NULL,        -- 'checkout_conversion', стабильный id для API/MCP
  name        text NOT NULL,        -- человекочитаемое имя
  purpose     text NOT NULL,        -- ЗАЧЕМ собирается — обязательное, непустое
  category    text,                -- project-scoped purpose key; NULL = uncategorized
  tags        text[] NOT NULL DEFAULT '{}',  -- open facet; prefer surface:checkout etc.
  type        text NOT NULL CHECK (type IN
                ('count',          -- сколько раз произошло событие
                 'unique_actors',  -- сколько уникальных distinct_id
                 'value',          -- агрегат по числовому свойству (sum/avg/p90)
                 'conversion',     -- доля акторов, дошедших от события A к B
                 'state')),        -- агрегат по сущностям (count entities where ...)
  source      jsonb NOT NULL,      -- декларация источника, см. ниже
  status      text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','active','deprecated')),
  owner       text,                -- 'agent:claude' | 'user:email@…'
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
```

`metric_categories` хранит project-scoped определения: `key`, `name`, `description`,
`domain` (`product|business|technical|custom`), `color`, `is_system`. Составной FK
`metrics(project_id, category) → metric_categories(project_id, key)` не даёт
сослаться на категорию другого tenant. Системные определения неизменяемы и
засеваются для существующих и новых проектов; custom-объекты можно создавать и
редактировать, а удалить — только пока на них не ссылаются метрики.

Системная библиотека:

- product: `acquisition`, `activation`, `adoption`, `engagement`, `retention`,
  `referral`, `satisfaction`;
- business: `revenue`, `cost`, `efficiency`;
- technical: `quality`, `reliability`, `performance`, `delivery`, `security`,
  `data_quality`.

Категория отвечает **зачем** существует метрика. Namespaced tags (`surface:*`,
`component:*`, `channel:*`, `capability:*`) отвечают **где/что**, а funnel с
обязательным `goal` — **какой путь**. Поэтому feature или экран не становятся
отдельной категорией. Старые plain tags и `category = NULL` остаются валидными.

Поле `source` — что физически считаем:

```jsonc
// type=count / unique_actors
{ "event": "checkout.completed",
  "filters": [{ "property": "plan", "op": "eq", "value": "pro" }] }

// type=value
{ "event": "checkout.completed", "value_property": "amount", "agg": "sum" }

// type=conversion
{ "from": { "event": "checkout.started" },
  "to":   { "event": "checkout.completed" },
  "window_seconds": 3600 }

// type=state — по сущностям
{ "entity_type": "account",
  "filters": [{ "property": "plan", "op": "ne", "value": "free" }],
  "agg": "count" }
```

Жизненный цикл: агент регистрирует метрику как `proposed` → владелец (или агент с подтверждением) активирует → `active` метрики участвуют в сверке `registered` на ингесте → устаревшие переводятся в `deprecated` через отдельное действие с `deprecation_reason`, но не удаляются (история запросов должна работать).

## 5. Funnels и Insights

```sql
CREATE TABLE funnels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  key         text NOT NULL,
  name        text NOT NULL,
  goal        text NOT NULL,        -- зачем воронка: 'довести нового юзера до первого экспорта'
  steps       jsonb NOT NULL,       -- [{"metric_key":"signup","label":"Регистрация"}, …]
  window_seconds integer NOT NULL DEFAULT 604800,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
```

Шаги воронки ссылаются на **метрики реестра**, не на сырые события. Это принципиально: воронка наследует семантику шагов, и инсайт-слой знает не только «конверсия шага 2→3 упала», но и «упала конверсия в активацию, цель которой — X».

```sql
CREATE TABLE insights (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  kind        text NOT NULL CHECK (kind IN ('manual','auto')),
  title       text NOT NULL,
  body        text NOT NULL,        -- markdown: находка + обоснование
  query       jsonb,                -- Query DSL, которым воспроизводится находка
  severity    text CHECK (severity IN ('info','warning','critical')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ack','resolved')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

`manual` — сохранённые запросы/заметки через MCP; `auto` зарезервирован для автоматически
сгенерированных insights. Evidence и decision proposals Product Decision Loop хранятся в
отдельных audit-таблицах ниже, а не маскируются под insight. Дашборд в Poolstatis — не
отдельная сущность: клиент или агент строит его на своей стороне из Query DSL.

## 6. Product Decision Loop

Decision Loop накладывает versioned product intent на аналитические примитивы:

- `property_definitions` — тип, purpose и trust свойств, которыми фильтруется evidence;
- `measurement_contracts` + revisions — runtime-копия `poolstatis.yml`, гипотеза, owner,
  primary/guardrails, окна, sample threshold и expected effect;
- `releases` + revisions — commit/deploy provenance и frozen contract snapshot;
- `evidence_sets` — append-only baseline/observed facts, trust, blockers и exact Query DSL;
- `decisions` + revisions — proposal отдельно от accepted human outcome;
- `decision_explanations` — bounded correlation hypotheses, не causal claims;
- `decision_actions` + audit — exact prepared payload, undo, fingerprint и approval state;
- `evaluation_attempts` и `webhook_outbox` — restart-safe bounded workers и delivery history.

Mutable current rows (`contracts`, `releases`, `decisions`, `actions`) имеют append-only
revision/audit рядом. Evidence, audit и delivery attempts защищены от update/delete
trigger-ами. Подробный lifecycle: [09-product-decision-loop.md](09-product-decision-loop.md).
