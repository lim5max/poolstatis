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

### POST /i/v1/experience/events

Optional Browser Experience SDK использует этот endpoint после явного consent.
Сначала platform token создаёт active surface с `key`, `name` и `purpose`;
ingest key затем отправляет только типизированные interaction events для этой
surface:

```jsonc
{
  "surface": "checkout",
  "batch_id": "browser-batch-uuid",
  "events": [{
    "kind": "element_clicked",
    "distinct_id": "user_8a21",
    "session_id": "opaque-session-id",
    "route": "checkout",
    "version": "2026.07.27-abc123",
    "device": "desktop",
    "viewport_width": 1440,
    "viewport_height": 900,
    "document_width": 1440,
    "document_height": 3200,
    "sequence": 7,
    "label": "pay_now",
    "x": 0.62,
    "y": 0.48,
    "viewport_x": 0.62,
    "viewport_y": 0.72
  }]
}
// → { "accepted": 1 }
```

Допустимы только `page_viewed`, labelled `element_clicked`, `scroll_depth`,
`section_exposed` и `client_error`. `route` — registered developer-provided
stable key, а не URL/path. Every signal carries a release `version`,
desktop/mobile device and viewport/document dimensions. Click `x/y` are
normalized document coordinates; `viewport_x/viewport_y` retain layout-relative
position. API откажет unknown/archived surface, unregistered/invalid route key,
duplicate fields и неразрешённые поля. `batch_id` обязателен и сохраняется на retry, поэтому
потерянный HTTP response не удваивает карту. DOM, URL/path, текст, CSS
selectors, input values, error stack/message и network data не являются частью
этого контракта.

## Platform API

CRUD-слой 1:1 с тулами MCP (см. [03-mcp-server.md](03-mcp-server.md)):

```
GET    /api/v1/projects
GET    /api/v1/projects/{slug}/schema
GET    /api/v1/projects/{slug}/onboarding/status?env=prod
POST   /api/v1/projects/{slug}/onboarding/observe-agent
POST   /api/v1/projects/{slug}/onboarding/acknowledgements
POST   /api/v1/projects/{slug}/identity-links
GET    /api/v1/projects/{slug}/identity-links?env=prod
POST   /api/v1/projects/{slug}/identity-links/{id}/revoke
POST   /api/v1/projects/{slug}/properties
POST   /api/v1/projects/{slug}/properties/acquisition-attribution
POST   /api/v1/projects/{slug}/properties/browser-analytics
GET    /api/v1/projects/{slug}/properties
PATCH  /api/v1/projects/{slug}/properties/{scope}/{key}
POST   /api/v1/projects/{slug}/measurement/trust
POST   /api/v1/projects/{slug}/sources/posthog
GET    /api/v1/projects/{slug}/sources
POST   /api/v1/projects/{slug}/sources/posthog/{id}/verify
GET    /api/v1/projects/{slug}/sources/posthog/{id}/schema
GET    /api/v1/projects/{slug}/sources/posthog/{id}/sample?event=…&limit=20
POST   /api/v1/projects/{slug}/contracts/validate
POST   /api/v1/projects/{slug}/contracts/diff
POST   /api/v1/projects/{slug}/contracts/apply
GET    /api/v1/projects/{slug}/contracts
GET    /api/v1/projects/{slug}/contracts/export
GET    /api/v1/projects/{slug}/contracts/{key}
POST   /api/v1/projects/{slug}/releases
GET    /api/v1/projects/{slug}/releases
GET    /api/v1/projects/{slug}/releases/{id}
POST   /api/v1/projects/{slug}/releases/{id}/transition
POST   /api/v1/projects/{slug}/releases/{id}/evaluate
GET    /api/v1/projects/{slug}/decisions
GET    /api/v1/projects/{slug}/decisions/{id}
POST   /api/v1/projects/{slug}/decisions/{id}/approve
POST   /api/v1/projects/{slug}/decisions/{id}/reject
POST   /api/v1/projects/{slug}/decisions/{id}/edit
POST   /api/v1/projects/{slug}/decisions/{id}/explain
GET    /api/v1/projects/{slug}/decisions/{id}/explanations
GET    /api/v1/projects/{slug}/decisions/search
POST   /api/v1/projects/{slug}/contracts/similar
POST   /api/v1/projects/{slug}/decisions/{id}/actions
GET    /api/v1/projects/{slug}/decisions/{id}/actions
GET    /api/v1/projects/{slug}/actions/{id}
POST   /api/v1/projects/{slug}/actions/{id}/approve
POST   /api/v1/projects/{slug}/actions/{id}/reject
POST   /api/v1/projects/{slug}/actions/{id}/retry
GET    /api/v1/projects/{slug}/decision-inbox
POST   /api/v1/projects/{slug}/webhooks
GET    /api/v1/projects/{slug}/webhooks
POST   /api/v1/projects/{slug}/webhooks/{id}/test
GET    /api/v1/projects/{slug}/webhook-deliveries
GET    /api/v1/projects/{slug}/metric-categories
POST   /api/v1/projects/{slug}/metric-categories
PATCH  /api/v1/projects/{slug}/metric-categories/{key}
DELETE /api/v1/projects/{slug}/metric-categories/{key}
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
POST   /api/v1/projects/{slug}/experience/surfaces
GET    /api/v1/projects/{slug}/experience/surfaces
POST   /api/v1/projects/{slug}/experience/surfaces/{key}/archive
POST   /api/v1/projects/{slug}/experience/surfaces/{key}/routes
GET    /api/v1/projects/{slug}/experience/routes
POST   /api/v1/projects/{slug}/experience/snapshots
GET    /api/v1/projects/{slug}/experience/snapshots
GET    /api/v1/projects/{slug}/experience/snapshots/{id}/image
DELETE /api/v1/projects/{slug}/experience/snapshots/{id}
POST   /api/v1/projects/{slug}/query          ← единая точка Query DSL
GET    /api/v1/projects/{slug}/events/sample
GET    /api/v1/projects/{slug}/data-quality
GET    /api/v1/projects/{slug}/insights
POST   /api/v1/projects/{slug}/insights
```

Category CRUD работает только в scope проекта. Создавать можно только
`domain: "custom"`; system definitions неизменяемы (`409
system_metric_category`). Удаление используемой custom-категории возвращает
`409 metric_category_in_use` и `details.metric_count`. Metric create/update
проверяет category в том же проекте и возвращает `400 unknown_metric_category`.
`GET .../schema` также возвращает `metric_categories`, включая definitions,
цвет, domain, `is_system` и usage count.

Категория — purpose axis (**зачем**), namespaced tags — feature/surface axis
(**где/что**), funnel — journey axis. `NULL`/uncategorized и старые plain tags
остаются обратно совместимыми.

Snapshot upload metadata includes viewport and CSS-pixel document dimensions
separately from the validated physical PNG/WebP width and height. Visual queries
match all four layout dimensions before overlaying aggregate coordinates.

Proof gates, actor-link semantics, property trust и точная capability matrix PostHog
описаны в [09-product-decision-loop.md](09-product-decision-loop.md). `observe-agent`
принимается только с внутренним MCP header; это не ручная кнопка завершения. PostHog key
write-only, а Platform API не принимает caller-provided HogQL.

Measurement contract endpoints принимают только versioned declaration. `diff` возвращает
`expected_revision`; изменение существующего контракта требует и эту optimistic revision,
и `confirm_existing_changes: true`. Release registration идемпотентна по
project + env + `idempotency_key`, а сохранённый release содержит frozen contract snapshot.
Evaluate создаёт immutable evidence set и proposal; approve/reject/edit добавляют revision,
но не запускают внешний delivery action.

`explain` сохраняет deterministic correlation hypotheses только по active registry metrics
и trusted target properties; label всегда `hypothesis`, а supporting Query DSL можно
повторить. Action сначала создаётся как `prepared` с exact payload, undo и
`confirmation_fingerprint`. Только отдельный approve может исполнить поддерживаемый action.
Generic webhook сначала попадает в outbox; HTTP не выполняется внутри approve request.
Decision history project-scoped и отмечает stale metric/contract context.

## Feature delivery and experiments

Feature flag хранит обязательный `purpose`, стабильный server-side salt и
variants `{key, rollout_percentage, payload?}`. Проценты не могут превышать
100% и задаются с точностью до 0.01% (basis points); один и тот же
`distinct_id` всегда получает тот же вариант, пока salt не меняется (он
никогда не меняется через API). `draft` и `archived` флаги не доступны
рантайму.

Эксперимент ссылается на один flag и на `active` registry metric типа `count`
или `unique_actors`. Старт возможен только для active flag с распределением
ровно 100%. Результат сопоставляет первый `$feature_flag_called` пользователя в
окне эксперимента с outcome-event **после** exposure. Учитываются только
события exposure, созданные серверным evaluator (публичный ingest не может
подделать assignment). Затем возвращаются `exposed`, `converted`,
`conversion_rate`, `uplift_vs_control`, 95% Beta credible interval и
`probability_best` для primary и всех declared secondary metrics.

`POST /flags/{key}/evaluate` в Platform API создан для MCP/debugging и не
создаёт exposure. Рантайм всегда использует ingest endpoint выше.

## Browser Experience queries

`POST /query` поддерживает `kind: "interaction_map"` с `{surface, date_from,
date_to?, grid?, env?}` и возвращает нормализованные click cells + labelled
totals. `kind: "experience_session"` принимает `{surface, session_id,
date_from?, date_to?, limit?, env?}` и возвращает privacy-safe timeline с
summary. Оба запроса учитывают только события, принятые typed Experience
endpoint; generic `/i/v1/events` с похожим именем не попадает в эти результаты.
Как и любой `pk_` write key, typed endpoint не является anti-fraud границей:
доверяй данным как product telemetry, а не как доказательству действий пользователя.

`kind: "visual_experience"` requires the exact
`{surface,route,version,device,date_from,date_to?,grid?,env}` tuple and returns
snapshot metadata, click cells/labels, scroll coverage, named-section
reach/drop-off, counts, percentages and a causality caveat.
`kind: "visual_experience_compare"` compares two device/version/period cohorts
and returns count and percentage-point deltas. Snapshot upload is raw PNG/WebP;
the API never fetches a caller-supplied URL.

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
  "filters": [{ "property": "$utm_source", "op": "eq", "value": "newsletter" }],
  "breakdown": { "property": "$utm_source" }, // опционально, топ-10 значений + other
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

`$utm_source`, `$utm_medium`, `$utm_campaign`, `$utm_term`, `$utm_content` —
зарезервированные event properties browser-attribution entrypoint. Перед
filter/breakdown вызови `POST .../properties/acquisition-attribution`: он
идемпотентно создаёт пять native string definitions со статусом `proposed`.
`meta.note` такого trend явно говорит **Session landing attribution**: это связь
с tagged landing в этой browser session, не causal credit кампании.

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

- Каждый API-процесс применяет атомарные token buckets одновременно к ключу и
  проекту. Ingest тарифицируется количеством элементов в `events`/`entities`,
  Platform API (включая HTTP-вызовы MCP) — запросами. Запрос записывается только
  если хватает обоих бюджетов; отказ одного ключа не расходует общий остаток
  проекта. `sk_`, `pt_` и hosted user для одного `:slug` используют один
  канонический project id; ротация ключей не сбрасывает проектную квоту.
  Ingest/API имеют отдельные bounded stores, а admission дополнительно ограничен
  на организацию. Idle bucket удаляется только после полного refill, поэтому
  cache eviction не восстанавливает burst досрочно.
- До разрешения `:slug` отдельный per-credential + shared-org attempt budget
  ограничивает ошибочные/несуществующие project lookup. Такие попытки не
  расходуют analytics budget реального проекта, но ротация ключей не умножает
  нагрузку на Postgres.
- Дефолты на процесс: ingest `50 000 events/s`, burst `100 000` на ключ и
  `200 000 events/s`, burst `400 000` на проект; Platform API `3 000 rps`, burst
  `6 000` на ключ и `10 000 rps`, burst `20 000` на проект. Это защитные
  технические пределы, не тарифные квоты. Все значения настраиваются env.
- Успешный ответ содержит `X-RateLimit-Limit` и `X-RateLimit-Remaining`. Отказ —
  `429 rate_limited` с `Retry-After` и agent-facing `hint`. Батч, который больше
  configured burst и потому никогда не сможет пройти, получает постоянную
  `413 rate_limit_batch_too_large` без `Retry-After`.
- В Cloud несколько API-инстансов дополнительно требуют общего edge/Redis
  лимитера для глобальной квоты. Локальный слой остаётся обязательной защитой
  каждого процесса при сбое shared limiter.
- Формат ошибок единый: `{ "error": { "code": "metric_key_taken", "message": "…", "hint": "…" } }` — `hint` пишется для агента-читателя.
Для privacy-bounded web traffic используйте Query DSL
`kind: "web_analytics"` с registry metric key, периодом и bounded dimensions
`country|device|browser|os|language|timezone|source`. Ответ отдельно возвращает
`visitors`, `sessions`, `page_views`, counts и page-view percentages; определения
и privacy caveats входят в `meta`.
