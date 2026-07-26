# MCP-сервер

Точка входа для агентов. Тонкая обёртка над Platform API: никакой бизнес-логики в самом MCP — он маппит тулы на REST-вызовы и отдаёт ресурсы. Авторизация: personal token (`pt_…`) в конфиге MCP, скоуп — один или несколько проектов.

Два режима использования одним и тем же сервером:

- **Design-time** (агент инструментирует продукт): читает стандарт, регистрирует метрики и воронки.
- **Analysis-time** (агент отвечает на вопросы владельца): выполняет запросы, строит дашборды у себя, читает инсайты.

## Ресурсы (MCP resources)

| URI | Содержание |
|-----|------------|
| `poolstatis://standard/instrumentation` | Стандарт инструментации: именование событий, обязательные свойства, какие метрики ставить по типу продукта. Версионируется. (Контент — этап 2.) |
| `poolstatis://{project}/schema` | Живая схема проекта: метрики реестра, воронки, типы сущностей, фактические имена событий за 30 дней с пометкой registered/unregistered. |

Схема как ресурс — ключевой UX-ход: агент получает полный контекст проекта одним чтением, без цепочки list-вызовов.

## Тулы

### Контекст

```
list_projects()                      → [{slug, name, env_list, events_30d}]
get_project_schema(project)          → то же, что ресурс schema (для клиентов без resources)
```

### Реестр (design-time)

```
register_metric(project, {key, name, purpose, category, tags?, type, source})
  → {id, status: 'proposed'}
  // purpose обязателен; tags — свободные метки (фича/north-star), нормализуются (lowercase, dedupe)

update_metric(project, key, patch)   // включая активацию {status:'active'} и tags
deprecate_metric(project, key, reason)
explain_metric_usage(project, key, {env?, since_days?})
delete_metric(project, key)          // hard delete; отказ, если на метрику ссылается воронка
list_metrics(project, {status?, category?})

register_entity_type(project, {name, description, prop_schema?})

define_funnel(project, {key, name, goal, steps: [{metric_key, label}], window_seconds})
list_funnels(project)
delete_funnel(project, key)
```

### Feature delivery (ship → measure → decide)

```
create_feature_flag(project, {key, name, purpose, variants, status?})
list_feature_flags(project)
update_feature_flag(project, key, patch)
archive_feature_flag(project, key)             // отказ, если есть running experiment
evaluate_feature_flag(project, key, {distinct_id, session_id?})
  // inspect-only: не записывает exposure, поэтому безопасен для debug

create_experiment(project, {key, name, hypothesis, flag_key, primary_metric_key, secondary_metric_keys?})
list_experiments(project)
update_experiment(project, key, patch)         // только draft
start_experiment(project, key)                  // active flag + 100% allocation + active metrics
conclude_experiment(project, key, {decision?})
get_experiment_results(project, key, {env?})
  // exposure, conversion, uplift, credible interval, probability_best по variant
```

### Product decision loop

```
validate_measurement_contracts(project, declaration)
diff_measurement_contracts(project, declaration)
apply_measurement_contracts(project, declaration, {expected_revision?, confirm_existing_changes?})
list_measurement_contracts(project)
get_measurement_contract(project, key)
export_measurement_contracts(project)

register_release(project, release)
list_releases(project, {env?, status?})
get_release(project, id)
evaluate_release(project, id)

list_decisions(project, {status?, release_id?})
get_decision(project, id)
approve_decision(project, id, rationale)
reject_decision(project, id, rationale)
edit_decision(project, id, outcome, rationale)
explain_outcome(project, id)
prepare_action(project, decision_id, action)
approve_action(project, id, confirmation_fingerprint)
get_decision_inbox(project)
search_decision_history(project, filters)
find_similar_changes(project, declaration)

configure_webhook(project, destination)
verify_webhook(project, id)
```

Contract apply использует optimistic revision из diff. Release содержит frozen contract
revision и факты deploy. Evaluate сохраняет facts и proposal, но только явный human review
меняет accepted outcome. Action сначала создаётся как prepared exact payload с undo и
fingerprint; исполнение требует отдельного human approval. Webhook идёт через durable outbox.

Флаги оцениваются по переданному `distinct_id`; для аналитики anonymous→authenticated
создай audited actor link, который Query DSL разрешает при чтении. Продуктовый SDK пишет
`$feature_flag_called` при первом evaluation, MCP-tool намеренно этого не
делает.

### Browser Experience (consent → interaction evidence)

```
create_experience_surface(project, {key, name, purpose})
list_experience_surfaces(project)
archive_experience_surface(project, key)
query_interaction_map(project, {surface, date_from, date_to?, grid?, env?})
get_experience_session(project, {surface, session_id, date_from?, date_to?, limit?, env?})
```

Surface обязана иметь реальный `purpose`; без active surface SDK не примет
capture. Карта показывает нормализованные **клики**, а не взгляд или курсор.
Timeline содержит только developer-provided stable route key, stable label,
координаты, scroll depth и тип клиентской ошибки — DOM, URL/path, текст, input
values, stacks и network data в Poolstatis не отправляются.

### Запросы (analysis-time)

Все запросы — Query DSL за `EventStore` (см. [04-http-api.md](04-http-api.md)):

```
query_trend(project, {metric, date_from, date_to?, interval, breakdown?, env?})
query_funnel(project, {funnel | steps, date_from, date_to?, env?})
  // каждый step возвращает metric_key, purpose, category, actors и conversion_*
query_retention(project, {start_metric, return_metric?, interval, periods, date_from, env?})
query_lifecycle(project, {metric, interval, date_from, env?})   // new/returning/resurrecting/dormant
query_stickiness(project, {metric, interval, date_from, env?})
query_entities(project, {entity_type, filters?, limit, order_by?})

get_person(project, {distinct_id, env?})       // engagement summary + identity entity
sample_events(project, {event?, registered?, distinct_id?, limit≤100})  // отладка ингеста
list_ingest_warnings(project, {env?, kind?})   // rejected/unregistered/clock_skew (лог ошибок)
list_data_quality_issues(project, {env?, limit?, since_days?})
  // semantic conflicts: e.g. brief.completed exists, but entity status is still "new"
```

MCP tools expose structured JSON output (`structuredContent`) with a text JSON fallback for older clients.

### Инсайты

```
list_insights(project, {status?, kind?})
create_insight(project, {title, body, query?})        // kind='manual'
resolve_insight(project, id, {status: 'ack'|'resolved'})
```

## Принципы дизайна тулов

1. **Тул = одно намерение агента.** Не «универсальный query endpoint с 20 параметрами», а отдельные тулы под trend/funnel/entities — так агент реже ошибается в параметрах, а описания тулов короче.
2. **Ошибки учат.** Ответ на невалидный вызов содержит исправление: `register_metric` с занятым key возвращает существующую метрику и подсказку «используй update_metric или другой key». Агент — основной пользователь, и сообщение об ошибке — это его документация.
3. **Ингеста в MCP нет.** События шлёт продукт по HTTP в рантайме, а не агент в чате. Единственное исключение — `sample_events` для проверки, что инструментация работает.
4. **Запись метаданных безопасна по умолчанию.** Всё, что создаёт агент, рождается `proposed`; активация — отдельное действие, которое владелец может оставить за собой. Retirement идёт через `deprecate_metric(reason)`, чтобы следующий агент видел, почему метрика больше не используется.

## Транспорт

MVP: stdio-сервер и публичный version-pinned npm-пакет `@poolstatis/mcp@0.1.0` (токен только в env). Пакет прошёл fresh-install initialize/list-tools и project-scoped read smoke, поэтому hosted deploy может включить этот точный pin. Новые версии остаются `publish_pending` до повторения тех же проверок. Поддерживаемые presets: Claude Code, Claude Desktop, Codex, Cursor, Warp, Windsurf, VS Code/Copilot, Cline, Zed, Continue, Replit, OpenCode, Hermes-style launchers и custom MCP host. Streamable HTTP — отдельный этап после hosted-стабилизации.
