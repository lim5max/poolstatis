# Хранилище

## Два контура

| Контур | Данные | Профиль нагрузки | БД |
|--------|--------|------------------|----|
| Metadata plane | проекты, ключи, реестр метрик, воронки, сущности | мало строк, OLTP, важна консистентность и FK | Postgres (всегда) |
| Data plane | события | append-only, миллионы строк, агрегации по времени | Postgres (MVP) → ClickHouse (этап 3) |

Сущности (entities) живут в metadata plane несмотря на потенциальный объём: они изменяемые (upsert), а колоночные БД плохо переносят update-нагрузку.

## Интерфейс EventStore

Весь код платформы работает с событиями только через адаптер:

```ts
interface EventStore {
  append(events: IngestEvent[]): Promise<void>;

  // Структурированные запросы — ровно те, что нужны Query DSL.
  // Никакого "выполни произвольный SQL" в интерфейсе.
  trend(q: TrendQuery): Promise<TrendResult>;        // временной ряд по метрике
  funnel(q: FunnelQuery): Promise<FunnelResult>;     // конверсии по шагам
  sample(q: SampleQuery): Promise<RawEvent[]>;       // последние N событий (отладка)
  eventNames(projectId: string, env: string): Promise<EventNameStat[]>; // живая схема
}
```

Узкий интерфейс — осознанно: каждый метод реализуем эффективно и в Postgres, и в ClickHouse, и миграция не требует менять ни Platform API, ни MCP.

## MVP: PostgresEventStore

```sql
CREATE TABLE events (
  project_id   uuid NOT NULL,
  env          text NOT NULL,
  event        text NOT NULL,
  timestamp    timestamptz NOT NULL,
  distinct_id  text NOT NULL,
  session_id   text,
  properties   jsonb NOT NULL DEFAULT '{}',
  registered   boolean NOT NULL DEFAULT false,
  ingested_at  timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (timestamp);
-- партиции по месяцу создаются заранее фоновым джобом

CREATE INDEX events_main_idx ON events (project_id, env, event, timestamp);
CREATE INDEX events_actor_idx ON events (project_id, distinct_id, timestamp);
```

Почему этого хватит надолго: один Postgres спокойно держит десятки миллионов событий с такими индексами, а наша ранняя аудитория — вайб-кодед продукты с трафиком, далёким от энтерпрайза. Партиционирование по месяцу даёт дешёвый ретеншн (DROP PARTITION) и не даёт индексам распухнуть.

Воронки в Postgres считаются оконными функциями (первое достижение каждого шага per distinct_id в окне) — для MVP-объёмов это секунды.

## Этап 3: ClickHouseEventStore

```sql
CREATE TABLE events (
  project_id   UUID,
  env          LowCardinality(String),
  event        LowCardinality(String),
  timestamp    DateTime64(3),
  distinct_id  String,
  session_id   Nullable(String),
  properties   String,                -- JSON-строка, доступ через JSONExtract
  registered   UInt8,
  ingested_at  DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, env, event, timestamp);
```

Триггер миграции — не дата, а симптомы: p95 запроса trend > 2с или таблица событий > ~100 ГБ. Перенос: двойная запись в оба стора → бэкфил партиций → переключение чтения → отключение PG-стора.

## Ингест-путь

MVP: Ingest API принимает до 500 событий за запрос. Запросы без `batch_id`
объединяются в короткие физические Postgres-батчи; идемпотентные запросы нельзя
безопасно объединить в одну транзакцию, поэтому они проходят через отдельный
bounded semaphore до `pg.Pool`. Общий admission учитывает ожидающие и уже
записываемые события: при перегрузке он возвращает управляемый `503`, а не
бесконтрольно расходует память. Физический append ограничен 6500 событиями,
чтобы не превышать лимит PostgreSQL в 65 535 bind-параметров.

Очередь (Kafka/Redpanda) сознательно **не** ставим без измеренного основания. Точка расширения зафиксирована — `append()` атомарен, а claim клиентского `batch_id`, запись событий и отметка `completed` выполняются одной транзакцией. Повтор после потерянного HTTP-ответа не дублирует события; дедупликация обычного ingest действует 24 часа.

Перед буфером действует tenant-aware token bucket: одновременно проверяются
лимиты API-ключа и проекта, а стоимость ingest-запроса равна числу элементов.
Поэтому один шумный публичный ключ не может бесконечно занимать admission queue
или потратить project budget повторными отклонёнными запросами. В Cloud этот
per-process слой дополняется shared edge/Redis лимитером; сам по себе он не
является глобальной тарифной квотой между инстансами.

## Быстрые чтения и проверка предела

Повторяющиеся Query DSL запросы из MCP и кастомных дашбордов объединяются single-flight кешем процесса и кешируются на 1 секунду. Ключ включает project и полный канонический запрос, память ограничена, ошибки не кешируются. Успешная запись в том же процессе немедленно инвалидирует проект; между несколькими инстансами максимальная устарелость равна TTL.

Browser Experience использует отдельные частичные индексы для surface/time click-map и session/surface/time timeline. Проверка `EXPLAIN` закреплена тестом и учитывает дочерние индексы месячных партиций.

`pnpm load:smoke` — воспроизводимый HTTP-тест ingest и trend-read. Он не печатает токены и возвращает JSON с error rate, throughput, p50/p95/p99 и нарушенными SLO. Минимальный запуск:

```bash
POOLSTATIS_INGEST_TOKEN=pk_... \
POOLSTATIS_PLATFORM_TOKEN=sk_... \
POOLSTATIS_PROJECT=my-project \
pnpm load:smoke
```

Локальный baseline 2026-07-16 (Apple M1 Pro, 16 GB RAM, PostgreSQL 17.10 в Docker,
один API-процесс, concurrency 8, batch 100, по 2 секунды на фазу): 95 900
принятых и подтверждённых metric delta событий, 47 779 events/s, ingest p95
30.16 ms; uncached/high-cardinality trend — 233 req/s, p95 51.37 ms;
warm-cache identical trend — 2 542 req/s, p95 5.32 ms; HTTP errors 0. Это
короткий локальный smoke, а не cloud capacity claim.

Перед решением об архитектуре результат фиксируют вместе с железом, размером таблицы, concurrency, batch size и длительностью. Порядок эскалации:

1. durable queue/workers — когда рестарты процесса или устойчивый backpressure нарушают ingest SLO;
2. инкрементальные rollups зарегистрированных метрик — когда raw Query DSL не держит read SLO;
3. ClickHouse — когда репрезентативный датасет после этих шагов всё ещё даёт `trend p95 > 2s` или data plane приближается к 100 ГБ.

## Ретеншн и удаление

- Ретеншн настраивается per project (по умолчанию 12 месяцев). API-процесс каждые
  15 минут запускает bounded worker: singleton advisory lock между инстансами,
  fair round-robin по `retention_checked_at`, `DELETE … LIMIT` через `ctid` и
  `SKIP LOCKED`. Один sweep по умолчанию делает не больше 100 bounded DELETE
  по 5000 строк суммарно для всех таблиц и проектов, максимум 100 000 строк и
  5 секунд wall time. При backlog следующий bounded sweep начинается через
  секунду, но после пяти continuations worker уходит на обычный 15-минутный
  cooldown, чтобы не насыщать WAL/autovacuum непрерывно.
  Каждый DELETE получает `statement_timeout` и `lock_timeout` из оставшегося
  wall-time budget; maintenance использует отдельный pool на одно соединение и
  не забирает request-serving connection.
- `ingest_batches` живут минимум 24 часа. `experience_batches` и ingest warnings
  сохраняются до cutoff проекта, чтобы поздний retry Browser Experience не
  продублировал клики или сессию. Политика перечитывается и блокируется внутри
  каждого DELETE; `retention_months < 1` запрещён CHECK constraint.
- Retention и Browser Experience индексы каждого event partition, а также
  metadata cleanup index, строятся через `CREATE INDEX CONCURRENTLY`; дочерние
  event-индексы attach-ятся к metadata-only parent. API начинает слушать до
  build, а retention worker не стартует, пока read-back не подтвердит valid и
  attached состояние всех partition indexes.
- Ошибка одного проекта записывает `retention_failed_at/retry_at/last_error`,
  отодвигает его на 15 минут и не блокирует следующие tenants.
  Ручной/cron запуск: `pnpm retention:run`; параметры —
  `RETENTION_INTERVAL_MS`, `RETENTION_CONTINUATION_DELAY_MS`,
  `RETENTION_MAX_CONSECUTIVE_CONTINUATIONS`, `RETENTION_BATCH_SIZE`,
  `RETENTION_MAX_BATCHES`, `RETENTION_MAX_ROWS_PER_RUN`,
  `RETENTION_MAX_RUN_MS`, `RETENTION_WORKER_ENABLED`.
- На общем Postgres per-project сроки не позволяют безусловно удалить месячную
  партицию целиком. Cloud может drop-ать партицию только когда cutoff всех
  размещённых в ней проектов прошёл; в ClickHouse это становится TTL/partition
  policy.
- GDPR-удаление: `DELETE WHERE project_id = ? AND distinct_id = ?` — в Postgres тривиально, в CH через lightweight delete. Сущности удаляются строкой из `entities`.
