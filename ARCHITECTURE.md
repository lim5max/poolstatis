# Архитектура Poolstatis

## Принципы

1. **Agent-native.** Основной программируемый интерфейс платформы — MCP и HTTP API.
   Human UI остаётся review и answer-first analysis workspace: Web, Product, Funnels,
   Saved, People и Browser Experience дают графики, таблицы, session evidence,
   настройку, trust-аудит и human approval. Это не general dashboard builder.
2. **Семантика обязательна.** Метрика не может существовать без `purpose`, воронка — без
   `goal`, measurement contract — без бизнес-гипотезы и владельца решения.
3. **Schema-on-write с мягкой валидацией.** Ингест принимает любые события, но помечает,
   соответствуют ли они активному реестру. Незарегистрированные события сохраняются как
   сигнал drift, а не теряются.
4. **Хранилище за интерфейсом.** Все event reads/writes идут через `EventStore`. MVP
   использует Postgres; будущий ClickHouse adapter не меняет внешний Query DSL.
5. **Никакого raw SQL наружу.** Typed Query DSL сохраняет registry semantics, изоляцию
   тенантов и независимость клиентов от диалекта БД.
6. **Факты отдельно от интерпретации.** Release provenance и evidence append-only;
   proposal, human decision и approval-gated action имеют отдельную audit history.

## Компоненты

```text
Product SDK ── /i/v1/* ──► Ingest API ──► EventStore (Postgres adapter)
                                              ▲
Agent ── MCP ──► MCP Server ──► Platform API ──┤
Analysis/admin UI ── HTTP ─────────────────────┘
                                      │
                                      ├──► Metadata + audit (Postgres)
                                      ├──► ReplayObjectStore (bounded rrweb bytes)
                                      ├──► Release monitor (bounded, restart-safe)
                                      └──► Webhook outbox (encrypted destinations + retries)
```

- **Ingest API** — приём событий и upsert сущностей по write-only `pk_`; сверяет события с
  реестром, записывает `registered` и ingest warnings.
- **Platform API** — registry/data CRUD, Query DSL, onboarding proof, measurement trust,
  contracts, releases, evidence, decisions, actions и delivery audit.
- **MCP Server** — typed agent surface над Platform API и нормативные instrumentation
  resources. Реальный MCP-вызов также является server-derived onboarding evidence.
- **EventStore** — узкий storage seam для append-only событий и typed аналитических reads.
- **ReplayObjectStore** — отдельный seam для consented, masked, checksum-verified
  rrweb chunks; replay bytes не попадают в EventStore/Postgres metadata tables.
- **Metadata + audit DB** — проекты, ключи, entities, registry, actor links, historical
  import batches, append-only event revisions, contracts, releases, evidence, decisions,
  actions, attempts и delivery history.
- **Release monitor** — обрабатывает due releases по фиксированным окнам, сохраняет
  immutable evidence и proposal, повторяет сбои с bounded backoff.
- **Webhook outbox** — доставляет только явно одобренные sanitized payloads;
  URL/Authorization зашифрованы, все попытки аудируются.

## Тенантность и ключи

```text
Organization ──► Project ──► env (prod | dev | staging)
```

Project — единица изоляции data plane, metadata, decision memory и workers. `env` — атрибут
ключа, события и audit-объекта, а не отдельная сущность. Реестр метрик общий для проекта.

| Ключ | Префикс | Права | Где живёт |
|------|---------|-------|-----------|
| Ingest key | `pk_` | только запись событий/сущностей | клиентский код продукта |
| Secret key | `sk_` | read/manage одного проекта | сервер продукта, CI |
| Personal token | `pt_` | read/manage проектов организации | MCP-конфиг агента |

## Данные и семантика

| Примитив | Природа | Хранилище |
|----------|---------|-----------|
| **Event** | неизменяемый факт «что произошло» | EventStore |
| **Entity** | изменяемое текущее состояние user/account/… | Metadata DB |
| **Metric** | registry declaration: что считаем и зачем | Metadata DB |
| **Funnel / Insight** | цель, последовательность метрик и воспроизводимая находка | Metadata DB |

Product Decision Loop добавляет составные audit-объекты: measurement contract, release,
evidence set, decision revision, explanation hypothesis и prepared action. Они не заменяют
четыре аналитических примитива, а связывают их с конкретным изменением продукта.

Подробные схемы: [docs/01-data-model.md](docs/01-data-model.md). Полный workflow:
[docs/09-product-decision-loop.md](docs/09-product-decision-loop.md).

## Текущие границы

- Runtime остаётся single-Postgres; process-local quota и workers не дают глобальной
  координации между несколькими API replicas.
- PostHog adapter read-only и bounded: он не мигрирует данные автоматически и не
  открывает caller-provided HogQL. Для собственного event contract отдельно shipped
  previewed/idempotent historical backfill и append-only revision history.
- Static/dynamic cohorts и semantic materialized rollups ещё не реализованы.
- ClickHouse/очередь вводятся только после измеренного превышения Postgres ceiling.

Актуальные приоритеты: [docs/05-gap-analysis.md](docs/05-gap-analysis.md).
