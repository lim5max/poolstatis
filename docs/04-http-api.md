# HTTP API

Два публичных контура с разными ключами:

| Контур | Базовый путь | Авторизация | Назначение |
|--------|--------------|-------------|------------|
| Ingest | `/i/v1/*` | `pk_…` (ingest key) | запись событий/сущностей из продукта |
| Platform | `/api/v1/*` | `sk_…` / `pt_…` | метаданные + запросы (то, что зовёт MCP) |

## Ingest API

### POST /i/v1/events

```jsonc
// Authorization: Bearer pk_…   (ключ определяет project и env)
{
  "batch_id": "uuid-от-клиента",        // идемпотентность: повтор батча не дублирует события
  "events": [
    {
      "event": "checkout.completed",
      "timestamp": "2026-06-13T10:21:03.120Z",  // опционально, default = время приёма
      "distinct_id": "user_8a21",
      "session_id": "s_b1f0",                    // опционально
      "properties": { "amount": 49.0, "plan": "pro" }
    }
  ]
}
// → 200 { "accepted": 1, "unregistered": 0 }
```

Правила приёма:

- Батч ≤ 500 событий, тело ≤ 1 МБ. Ответ всегда быстрый: валидация синхронная, но лёгкая.
- `timestamp` из будущего (> +5 мин) или старше ретеншна → заменяется на `ingested_at`, событие помечается `$clock_skew: true`.
- Сверка с реестром: имя события входит в `source.event` какой-либо `active`-метрики → `registered = true`. Иначе событие **принимается** с `registered = false` — счётчик `unregistered` в ответе даёт SDK/агенту мгновенный сигнал о расхождении со стандартом.
- Невалидные события (нет `event`/`distinct_id`) не валят батч: ответ `207` с поэлементными ошибками.

### POST /i/v1/entities

```jsonc
{
  "entities": [
    {
      "entity_type": "account",
      "entity_id": "acc_42",
      "properties": { "plan": "pro", "seats": 7, "trial": null }  // null удаляет ключ
    }
  ]
}
// → 200 { "upserted": 1 }
```

Merge-семантика: присланные ключи перезаписывают существующие, отсутствующие сохраняются.

### POST /i/v1/flags/evaluate

Оценка feature flag из продукта. Нужен тот же write-only `pk_` ключ, что и
для SDK. `distinct_id` обязан быть стабильным: deterministic assignment и
экспериментная статистика строятся именно по нему.

```jsonc
{
  "key": "checkout_copy",
  "distinct_id": "user_8a21",
  "session_id": "s_b1f0" // optional
}
// → { "key": "checkout_copy", "variant": { "key": "test", "payload": { "label": "Pay now" } } }
// либо { "key": "checkout_copy", "variant": null } для нераспределённого трафика
```

Только `active` флаги можно оценивать. Когда вернулся variant, endpoint
записывает зарегистрированное системное событие `$feature_flag_called` c
`flag_key`, `variant` и `payload`. Это exposure для эксперимента; SDK кэширует
результат на `(flag, distinct_id)` в течение жизни клиента, чтобы один рендер не
раздувал данные.

## Platform API

CRUD-слой 1:1 с тулами MCP (см. [03-mcp-server.md](03-mcp-server.md)):

```
GET    /api/v1/projects
GET    /api/v1/projects/{slug}/schema
POST   /api/v1/projects/{slug}/metrics
PATCH  /api/v1/projects/{slug}/metrics/{key}
POST   /api/v1/projects/{slug}/metrics/{key}/deprecate
GET    /api/v1/projects/{slug}/metrics/{key}/usage
GET    /api/v1/projects/{slug}/metrics
POST   /api/v1/projects/{slug}/entity-types
POST   /api/v1/projects/{slug}/funnels
GET    /api/v1/projects/{slug}/funnels
POST   /api/v1/projects/{slug}/flags
GET    /api/v1/projects/{slug}/flags
PATCH  /api/v1/projects/{slug}/flags/{key}
POST   /api/v1/projects/{slug}/flags/{key}/archive
POST   /api/v1/projects/{slug}/flags/{key}/evaluate  ← inspect only, не пишет exposure
POST   /api/v1/projects/{slug}/experiments
GET    /api/v1/projects/{slug}/experiments
PATCH  /api/v1/projects/{slug}/experiments/{key}
POST   /api/v1/projects/{slug}/experiments/{key}/start
POST   /api/v1/projects/{slug}/experiments/{key}/conclude
GET    /api/v1/projects/{slug}/experiments/{key}/results?env=prod
POST   /api/v1/projects/{slug}/query          ← единая точка Query DSL
GET    /api/v1/projects/{slug}/events/sample
GET    /api/v1/projects/{slug}/data-quality
GET    /api/v1/projects/{slug}/insights
POST   /api/v1/projects/{slug}/insights
```

## Feature delivery and experiments

Feature flag хранит обязательный `purpose`, стабильный server-side salt и
variants `{key, rollout_percentage, payload?}`. Проценты не могут превышать
100%; один и тот же `distinct_id` всегда получает тот же вариант, пока salt не
меняется (он никогда не меняется через API). `draft` и `archived` флаги не
доступны рантайму.

Эксперимент ссылается на один flag и на `active` registry metric типа `count`
или `unique_actors`. Старт возможен только для active flag с распределением
ровно 100%. Результат сопоставляет первый `$feature_flag_called` пользователя в
окне эксперимента с outcome-event **после** exposure, затем возвращает по
вариантам `exposed`, `converted`, `conversion_rate`, `uplift_vs_control`, 95%
Beta credible interval и `probability_best`.

`POST /flags/{key}/evaluate` в Platform API создан для MCP/debugging и не
создаёт exposure. Рантайм всегда использует ingest endpoint выше.

## Query DSL

Один POST `/query`, дискриминатор — `kind`. DSL невелик по построению: он обязан транслироваться в узкий интерфейс `EventStore` (см. [02-storage.md](02-storage.md)).

```jsonc
// Временной ряд по метрике реестра
{
  "kind": "trend",
  "metric": "checkout_revenue",          // key из реестра — семантика уже в нём
  "date_from": "-30d",                   // относительные и ISO-даты
  "date_to": null,
  "interval": "day",                     // hour | day | week | month
  "breakdown": { "property": "plan" },   // опционально, топ-10 значений + other
  "env": "prod"
}

// Воронка
{
  "kind": "funnel",
  "funnel": "activation",                // либо inline: "steps": [{"metric":"signup"}, …]
  "date_from": "-14d",
  "env": "prod"
}

// Сущности
{
  "kind": "entities",
  "entity_type": "account",
  "filters": [{ "property": "plan", "op": "eq", "value": "pro" }],
  "order_by": { "property": "seats", "dir": "desc" },
  "limit": 50
}
```

Операторы фильтров: `eq, ne, gt, gte, lt, lte, in, contains, is_set, is_not_set`.

Ответ любого запроса включает `meta`: `{computed_at, date_range, sampling: null}` — задел под кеширование и сэмплирование без смены контракта.

Принципиально: **trend и funnel принимают только ключи метрик реестра**, не сырые имена событий. Хочешь график — зарегистрируй метрику (с purpose). Это та самая воронка принуждения к семантике, на которой стоит платформа; исключение — `sample_events` для отладки.

`query_funnel` возвращает семантику каждого шага вместе с числами:

```jsonc
{
  "steps": [
    {
      "label": "Signup",
      "metric_key": "signup_completed",
      "purpose": "Counts completed signups as the activation entry point.",
      "category": "activation",
      "actors": 120,
      "conversion_from_prev": 1,
      "conversion_from_start": 1
    }
  ]
}
```

## Metric retirement and usage

```http
POST /api/v1/projects/{slug}/metrics/{key}/deprecate
{ "reason": "Replaced by a stricter checkout success metric." }
```

Обычный `PATCH /metrics/{key}` больше не переводит метрику в `deprecated`: retirement требует причину, чтобы будущий агент понял, почему метрика убрана. История и definition остаются, а событие больше не участвует в `registered` после ухода из `active`.

```http
GET /api/v1/projects/{slug}/metrics/{key}/usage?env=prod&since_days=30
```

Возвращает саму метрику, source events, observed event stats за период, воронки/insights, где metric key используется, и `guidance` для решения `delete_metric` vs `deprecate_metric`.

## Data quality

```http
GET /api/v1/projects/{slug}/data-quality?env=prod&limit=50&since_days=30
```

Возвращает семантические противоречия, которые видит платформа. Сейчас реализован первый диагностический класс:

```jsonc
{
  "issues": [
    {
      "kind": "entity_event_status_conflict",
      "severity": "warning",
      "entity_type": "brief",
      "entity_id": "bd-101",
      "current_status": "new",
      "expected_status": "completed",
      "event": "brief.completed",
      "evidence_events": 1
    }
  ],
  "checked": { "terminal_event_specs": 1, "evidence_rows": 1 }
}
```

Правило консервативное: active event-метрика вида `brief.completed` задаёт expected status `completed`, а событие должно содержать `entity_id`, `brief_id` или `id`. Если текущая entity всё ещё имеет другой `properties.status`, endpoint подсвечивает конфликт.

## Лимиты и ошибки

- Rate limit: ингест 1000 событий/с на проект (burst 5000), Platform API 60 rps на ключ. Ответ `429` с `Retry-After`.
- Формат ошибок единый: `{ "error": { "code": "metric_key_taken", "message": "…", "hint": "…" } }` — `hint` пишется для агента-читателя.
