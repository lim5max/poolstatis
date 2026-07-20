# Product decision loop

Poolstatis связывает продуктовую гипотезу, измерение, конкретный релиз и решение. Сырые
события остаются неизменяемыми; семантика, provenance и audit facts хранятся отдельно.

## Trust foundation

### Proof-gated setup

`GET /api/v1/projects/{slug}/onboarding/status?env=prod` вычисляет прогресс из серверных
фактов. Клиент не может передать `complete: true`. Проверяются существование проекта,
реальный MCP-вызов, источник, первое наблюдение, активная метрика с данными, data quality,
успешный Query DSL run и сохранённый insight/decision. Незакрытый gate возвращает `blocker`
и `next_action`.

MCP tool `get_onboarding_status` сначала вызывает защищённый observation endpoint с
`x-poolstatis-client: mcp`, затем читает gates. Поэтому скопированный config без запуска
агента не считается подключением. `pk_`, `sk_`, `pt_` и PostHog credentials не входят в
gate evidence или query-run summaries.

### Actor identity

Identity link направлен от временного или устаревшего `distinct_id` к стабильному:

```text
anonymous-browser-42 -> user-17
```

Link ограничен project + env, проверяется на конфликт и цикл, и может быть отозван.
Создание и отзыв добавляются в append-only audit. Events не переписываются: canonical
actor вычисляется при чтении. Поэтому отзыв или исправление link меняет последующие
trend/funnel/retention results, сохраняя исходные события и историю оператора.

### Property meanings and measurement trust

Property definition содержит `scope`, `value_type`, обязательный `purpose`, status
`proposed | trusted | untrusted` и источник. Trust check для метрики возвращает фактическое
число наблюдений/акторов, registered coverage, `distinct_id` coverage, coverage целевых
properties и конкретные blockers/warnings. Property без явно принятого смысла нельзя
использовать как надёжный decision filter.

Project schema включает те же metric category/tags, property meanings, identity summary и
source status, которые видят REST, MCP и headless admin.

## PostHog source

Это ограниченный read-only adapter, не connector marketplace и не bulk export.

| Возможность | Статус |
|---|---|
| Schema discovery: events/properties | поддерживается, до 100 definitions за read |
| Sample verification | поддерживается, максимум 100 events |
| Trend | count и unique actors; без breakdown |
| Funnel | последовательные event steps из одного connection |
| Retention | basic event retention из одного connection |
| Value metrics | не поддерживаются в P0 adapter |
| Lifecycle / stickiness | не поддерживаются в P0 adapter |
| Write/import raw events | отсутствует |

Poolstatis генерирует bounded HogQL сам и не принимает raw SQL/HogQL от клиента. Для
private PostHog API нужен personal API key `phx_` с минимальными read permissions. Secret
шифруется AES-256-GCM с `POOLSTATIS_CONNECTOR_ENCRYPTION_KEY`, не возвращается после
создания и не попадает в schema/status response. HTTP разрешён только для loopback в
контролируемых локальных тестах; удалённый origin обязан быть HTTPS. Unsupported query
возвращает `posthog_capability_unsupported`, а не приближённое число.

## Repository declaration

Имя versioned declaration зафиксировано как `poolstatis.yml`. Runtime source of truth —
Postgres. Файл описывает measurement contracts и проходит deterministic
`validate -> diff -> confirmed apply`; он не хранит ключи или вычисленные результаты.

```yaml
version: 1
contracts:
  - key: shorter_onboarding
    name: Shorter onboarding
    business_hypothesis: Removing one setup step should increase first activation.
    decision_owner: growth-team
    primary_metric_key: activation_completed
    guardrail_metric_keys: [invite_completed]
    target_filters:
      - property: plan
        op: eq
        value: pro
    baseline_window_days: 7
    observation_window_days: 7
    minimum_sample_size: 100
    expected_direction: increase
    minimum_meaningful_effect: 0.1
    references:
      issue_url: https://example.com/issues/42
    status: active
```

Canonicalization сортирует contracts, guardrails, filters и references до hash/export.
`validate` и `diff` ничего не пишут. Apply существующего контракта требует явного
`confirm_existing_changes` и `expected_revision` из свежего diff; stale apply получает 409.
Каждая запись/правка сохраняется в append-only revision history.

## Release provenance from CI

CI регистрирует конкретный deploy, а не PR intention:

```bash
curl -X POST "$POOLSTATIS_URL/api/v1/projects/acme/releases" \
  -H "Authorization: Bearer $POOLSTATIS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "idempotency_key":"prod-deploy-2026-07-19T10:15:00Z",
    "contract_key":"shorter_onboarding",
    "env":"prod",
    "repository":"acme/product",
    "branch":"main",
    "commit_sha":"0123456789abcdef0123456789abcdef01234567",
    "pr_url":"https://github.com/acme/product/pull/42",
    "deployed_at":"2026-07-19T10:15:00Z",
    "status":"deployed"
  }'
```

Повтор того же payload с тем же idempotency key возвращает существующий release; другой
payload с тем же key — 409. Redeploy получает новый key. Release навсегда сохраняет
`contract_revision` и frozen `contract_snapshot`, поэтому последующее изменение YAML не
переписывает ожидания уже развёрнутого кода. Допустимый lifecycle:
`planned -> deployed -> observing -> decided`; non-final release можно отменить.
Follow-up release передаёт `originating_decision_id`; сервер проверяет project scope и
показывает связь в API/MCP и Changes, не меняя исходный decision.

## Evidence and decision policy

Evaluation строит фиксированный baseline перед `deployed_at` и observed window после него,
используя тот же typed Query DSL и native/PostHog adapter. Evidence set неизменяем и хранит:
metric purpose, baseline/observed aggregates, actor sample, guardrails, trust coverage,
blockers, exact query specs и server facts. Интерпретация хранится отдельно.

- `keep`: trusted primary прошёл ожидаемое направление и meaningful-effect threshold,
  guardrails стабильны;
- `rollback`: trusted primary значимо пошёл в противоположную сторону;
- `fix`: evidence trusted, но эффект недостаточен либо guardrail просел;
- `inconclusive`: окно не закрыто, sample мал, metric/property/identity trust недостаточен
  или baseline нельзя сравнить.

Любой blocker запрещает directional keep/fix/rollback. Повторная evaluation создаёт
отдельный immutable evidence snapshot. Proposal не является решением владельца: человек
должен approve, reject или edit с rationale длиной не меньше десяти символов. Все prior,
proposed и accepted значения остаются в `decision_revisions`; одобрение переводит release
в `decided`, но само по себе не вызывает webhook, rollback или flag change.

## Continuous monitor and retries

`ReleaseMonitor` выбирает due releases bounded batch-ами через `FOR UPDATE SKIP LOCKED`.
До завершения fixed observation window он сохраняет waiting attempt и точный blocker. После
окна он вызывает тот же evaluator, которым пользуется REST/MCP. Уникальный window key и
immutable evidence key защищают от дубликатов после restart или двух concurrent workers.
Failure получает capped exponential retry; terminal attempt остаётся видимым, а не исчезает.

Основные переменные:

| Переменная | Default | Назначение |
|---|---:|---|
| `RELEASE_MONITOR_ENABLED` | `true` | включить durable evaluation worker |
| `RELEASE_MONITOR_INTERVAL_MS` | `60000` | частота bounded run |
| `RELEASE_MONITOR_BATCH_SIZE` | `25` | максимум releases за run |
| `RELEASE_MONITOR_MAX_ATTEMPTS` | `8` | terminal retry limit |
| `RELEASE_MONITOR_BASE_RETRY_MS` | `60000` | первый backoff |
| `RELEASE_MONITOR_MAX_RETRY_MS` | `3600000` | cap backoff |
| `RELEASE_MONITOR_LEASE_MS` | `300000` | crash/restart claim lease |

Операционный read-back:

```sql
SELECT release_id, status, attempt_count, reason, error_code, scheduled_at
FROM evaluation_attempts
ORDER BY updated_at DESC
LIMIT 50;
```

Чтобы осознанно повторить terminal release после устранения причины, оператор может
увеличить policy limit и вернуть due time через Platform operation/SQL; evidence не удаляется.

## Explanations, actions and decision memory

Explanation сравнивает только active registered metrics и trusted properties в тех же
baseline/observed windows. Ranking учитывает shared tags/category, достаточность sample и
сходство movement. Это всегда **корреляционная гипотеза**, никогда причинный вывод. Exact
candidates, score и supporting queries сохраняются для audit.

Prepared action содержит target, exact payload, expected effect, undo, evidence/revision
fingerprint и idempotency key. Анализ и prepare не меняют flag, schedule или внешнюю систему.
Отдельный approve записывает approver и fingerprint, затем исполняет только:

- `draft_implementation_prompt` — формирует reviewable draft, не меняет код;
- `prepare_flag_rollback` — меняет variants существующего flag после approval и сохраняет undo;
- `schedule_observation` — назначает новый durable monitor attempt;
- `request_more_data` — сохраняет явный запрос без скрытой автоматики;
- `generic_webhook` — кладёт sanitized impact в outbox.

`create_issue` и `open_draft_pr` остаются prepared с `action_capability_unsupported`, пока
GitHub integration реально не настроена. Ни один action не merge-ит код, не деплоит и не
создаёт новый release автоматически. Decision memory ищет только внутри project и сохраняет
proposal/human disagreement; historical result получает stale reasons, если текущий metric
или contract уже изменился.

## Encrypted webhook outbox

URL и optional Authorization шифруются AES-256-GCM тем же
`POOLSTATIS_CONNECTOR_ENCRYPTION_KEY`; API возвращает только masked URL. HTTP endpoint обязан
быть HTTPS, кроме loopback для контролируемых тестов. Explicit test delivery имеет отдельный
idempotency key; destination становится verified только после HTTP 2xx.

Перед request outbox уже содержит sanitized payload. В нём impact идёт первым: accepted
outcome, metric key/purpose, baseline/observed, relative change, readiness и trust. Raw event,
distinct_id, event properties, source credentials и prepared private payload не отправляются.
Каждый request содержит `x-poolstatis-idempotency-key`; retries bounded и restart-safe.

| Переменная | Default |
|---|---:|
| `WEBHOOK_OUTBOX_ENABLED` | `true` |
| `WEBHOOK_OUTBOX_INTERVAL_MS` | `5000` |
| `WEBHOOK_OUTBOX_BATCH_SIZE` | `25` |
| `WEBHOOK_OUTBOX_MAX_ATTEMPTS` | `8` |
| `WEBHOOK_OUTBOX_BASE_RETRY_MS` | `5000` |
| `WEBHOOK_OUTBOX_MAX_RETRY_MS` | `3600000` |
| `WEBHOOK_OUTBOX_LEASE_MS` | `300000` |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | `10000` |

Recovery начинается с read-only проверки:

```sql
SELECT id, event_type, status, attempt_count, next_attempt_at, last_error
FROM webhook_outbox
ORDER BY updated_at DESC
LIMIT 50;
```

После исправления destination operator может вызвать action retry. Уже delivered row повторно
не claim-ится; receiver всё равно обязан дедуплицировать idempotency header на случай сетевого
обрыва после принятия payload.

## Admin audit surfaces

- **Setup & MCP** показывает server-derived gates, blocker и первое реальное query result.
- **Measurement** показывает trust активных метрик, property meanings, identity-link audit,
  capability/status внешних sources и repository-owned contracts.
- **Changes** показывает expected outcome, what happened, trust, requested decision и
  post-approval state в одном release audit record.
- **Decisions** раскрывает immutable facts, blockers, reproducible Query DSL и human
  revision history, correlation hypotheses, action undo/fingerprint, inbox, delivery retries
  и stale-aware project memory.
- Registry и Data остаются местом для semantic definitions и raw-evidence audit; это не
  dashboard/chart builder.
