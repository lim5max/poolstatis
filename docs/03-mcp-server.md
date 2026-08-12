# MCP-сервер

Точка входа для агентов. Тонкая обёртка над Platform API: никакой бизнес-логики в самом MCP — он маппит тулы на REST-вызовы и отдаёт ресурсы. Авторизация: personal token (`pt_…`) в конфиге MCP, скоуп — один или несколько проектов.

Два режима использования одним и тем же сервером:

- **Design-time** (агент инструментирует продукт): читает стандарт, регистрирует метрики и воронки.
- **Analysis-time** (агент отвечает на вопросы владельца): выполняет запросы, строит дашборды у себя, читает инсайты.

## Ресурсы (MCP resources)

| URI | Содержание |
|-----|------------|
| `poolstatis://standard/instrumentation` | Стандарт инструментации: именование событий, обязательные свойства, какие метрики ставить по типу продукта. Версионируется. (Контент — этап 2.) |
| `poolstatis://standard/browser-analytics` | Нормативные определения Visitors / Sessions / Page views и payload/GeoIP границы browser-модуля. |
| `poolstatis://{project}/schema` | Живая схема проекта: метрики реестра, воронки, типы сущностей, фактические имена событий за 30 дней с пометкой registered/unregistered. |

Схема как ресурс — ключевой UX-ход: агент получает полный контекст проекта одним чтением, без цепочки list-вызовов.

## Тулы

### Контекст

```
list_projects()                      → bootstrap project list and all-environment event health
get_project_portfolio(env?)          → env-scoped health plus current-cycle accepted usage
get_account_mode()                   → deployment, credential scope, role, capabilities
get_project_schema(project)          → то же, что ресурс schema (для клиентов без resources)
compare_projects({metric_key, projects[2..8], environment, window})
  → ready + values или unavailable + причины без значений
```

### Historical data and corrections

```
preview_event_backfill(project, {env, events})
import_historical_events(project, {
  env, batch_id, reason, expected_payload_sha256, events
})
list_event_backfills(project, {env?, limit?})

preview_event_revision(project, {event_id, env?, patch})
revise_event(project, {
  event_id, env?, patch, expected_revision, expected_preview_sha256, reason
})
get_event_history(project, {event_id, env?})
```

Backfill используется только для восстановления уже существующих фактов из
trusted product database. Сначала агент обязан показать preview; commit
all-or-nothing сохраняет исходные даты и permanent idempotency key. Для больших
выгрузок агент делит источник на стабильные chunks до 500 событий и не меняет
`batch_id` при retry. Correction сначала показывает before/after и
`preview_sha256`; commit принимает fingerprint ровно этого patch и никогда не
перезаписывает событие без append-only audit revision.

### Реестр (design-time)

```
register_metric(project, {key, name, purpose, category, tags?, type, source})
  → {id, status: 'proposed'}
  // category = зачем; namespaced tags = где/что; funnel = путь
  // category берётся из definitions проекта; NULL остаётся совместимым uncategorized

list_metric_categories(project)
create_metric_category(project, {key, name, description, domain:'custom', color})
update_metric_category(project, key, {name?, description?, color?})
delete_metric_category(project, key)
  // system definitions locked; referenced custom category returns 409

update_metric(project, key, patch)   // name/category/tags/status; включая {status:'active'}
get_metric_definition(project, key)
  // fingerprint + append-only revision history + bounded dependency impact
preview_metric_definition(project, key, {expected_revision?, definition:{purpose,source}})
  // read-only preview; semantic apply остаётся подтверждаемым действием в admin UI/REST
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

### Browser acquisition attribution

```
propose_acquisition_properties(project)
assess_measurement_trust(project, input)
```

Идемпотентно создаёт предложенные definitions для `$utm_source`, `$utm_medium`,
`$utm_campaign`, `$utm_term`, `$utm_content`. `list_properties` возвращает те же
name/purpose/type/trust state, что Platform API и admin. Перед decision contract
owner отдельно переводит нужное property в `trusted`. Для analysis используй
обычный `query_trend` с `filters`/`breakdown`; ответ маркирует результат как
session landing attribution, а не causal campaign impact.
`assess_measurement_trust` с UTM `target_filters` возвращает его coverage и
trust state для конкретной зарегистрированной метрики.

### Web engagement (browser-tab sessions)

```
get_web_overview(project, {metric, key_metric?, date_from, date_to?, dimensions?, filters?, env?})
list_web_sessions(project, {metric, key_metric?, date_from, date_to?, filters?, limit?, env?})
get_web_session(project, {metric, key_metric?, actor_id?, session_id, date_from, date_to?, filters?, page_limit?, env?})
get_session_engagement(project, {metric, key_metric?, actor_id?, session_id, date_from, date_to?, filters?, env?})
get_page_engagement(project, {metric, actor_id?, page_view_id, date_from, date_to?, filters?, env?})
get_click_map(project, {surface, route, version, device, date_from, date_to?, grid?, env?})
get_scroll_map(project, {surface, route, version, device, date_from, date_to?, grid?, env?})
```

Session tools read cumulative `page.engagement` snapshots and deduplicate them
by actor and the highest sequence per page. They keep visible/focused foreground
time separate from wall span. Positive evidence classifies engagement
immediately; a complete negative classifies a bounce, while unresolved sessions
return nullable engagement and bounce. Overview rates use measured sessions,
not all sessions, as their denominator. A missing exit snapshot is not a zero.
When the same session or page id exists for more than one actor, omitting
`actor_id` fails closed; first call `list_web_sessions` and reuse its exact
`actor_id`.
Click/scroll maps require an exact
surface/version/route/device cohort and default to unique-session aggregation;
event counts remain secondary. All responses are project/environment isolated
and bounded, with sample size, truncation and no-data reasons. These tools never
return DOM/video replay.

### Browser Experience (session → interaction evidence)

```
create_experience_surface(project, {key, name, purpose})
list_experience_surfaces(project)
archive_experience_surface(project, key)
query_interaction_map(project, {surface, date_from, date_to?, grid?, env?})
get_experience_session(project, {surface, session_id, actor_id?, date_from?, date_to?, limit?, env?})
register_experience_route(project, {surface, route:{key,name,path_pattern}})
list_visual_experience_versions(project, {surface?, route?, env?})
get_visual_experience_map(project, {surface, route, version, device, date_from, date_to?, grid?, env?})
compare_visual_experience(project, {surface, route, baseline, comparison, grid?, env?})
```

Surface обязана иметь реальный `purpose`; без active surface SDK не примет
capture. Карта показывает нормализованные **клики**, а не взгляд или курсор.
Timeline содержит только developer-provided stable route key, stable label,
координаты, scroll depth и тип клиентской ошибки — DOM, URL/path, текст, input
values, stacks и network data в Poolstatis не отправляются.
Если один `session_id` использован несколькими акторами в том же tenant/env/
surface/window, чтение без `actor_id` завершается typed ambiguity error.
Ответ всегда содержит canonical actor identity и active-link provenance.

Visual map tools additionally return an agent-ready `agent_context`: the
purpose-tagged scope, sample sizes, ordered section labels, counts and
percentages, largest adjacent-section aggregate reach decreases, safe-label click concentration,
scroll reach, snapshot freshness/coverage, evidence references, explicit
data-quality caveats and deterministic next actions. Comparison includes count
and section percentage-point deltas plus exact follow-up map queries for both
cohorts using resolved ISO periods. Renamed/missing section labels are reported
as taxonomy mismatches with no behavioral delta; top-100 click-label and
200-section truncation is explicit. MCP never returns DOM, page text, form values, image bytes or PII and
never invents a cause; comparison output is explicitly descriptive and
non-causal.

### Запросы (analysis-time)

Все запросы — Query DSL за `EventStore` (см. [04-http-api.md](04-http-api.md)):

```
query_trend(project, {metric, date_from, date_to?, interval, breakdown?, env?})
query_web_analytics(project, {metric, date_from, date_to?, dimensions?, filters?, env?})
  // доступные dimensions возвращаются вместе; недоступные перечислены в
  // meta.unavailable_dimensions и не скрывают headline traffic
get_web_overview(project, {metric, key_metric?, date_from, date_to?, dimensions?, filters?, env?})
list_web_sessions(project, {metric, key_metric?, date_from, date_to?, filters?, limit?, env?})
get_web_session(project, {metric, key_metric?, actor_id?, session_id, date_from, date_to?, filters?, page_limit?, env?})
get_page_engagement(project, {metric, actor_id?, page_view_id, date_from, date_to?, filters?, env?})
query_funnel(project, {funnel | steps | conversion_metric, date_from, date_to?, env?})
  // каждый step возвращает metric_key, purpose, category, actors и conversion_*
create_funnel_investigation(project, {idempotency_key, funnel, env, date_from,
  date_to, from_step, to_step})
  // сервер повторяет saved-funnel query и сохраняет immutable result/evidence lineage
list_funnel_investigations(project, {env?, funnel?, limit?})
get_funnel_investigation(project, id)
  // artifact descriptive, not causal; его id нужно явно передать в последующую работу
query_retention(project, {start_metric, return_metric?, interval, periods, date_from, env?})
query_lifecycle(project, {metric, interval, date_from, env?})   // new/returning/resurrecting/dormant
query_stickiness(project, {metric, interval, date_from, env?})
query_entities(project, {entity_type, filters?, limit, order_by?})
list_actors(project, {env?, from?, to?, limit?, cursor?, order?, search?,
  propertyFilters?, activityMetric?})

propose_browser_analytics(project, route_keys[]) // finite reviewed vocabulary; atomic
get_person(project, {distinct_id, env?, from?, to?, limit?, cursor?})
  // distinct_id≤200; canonical ID + bounded raw IDs/links + registered-only masked activity
sample_events(project, {event?, registered?, distinct_id?, limit≤100})  // отладка ингеста
list_ingest_warnings(project, {env?, kind?})   // rejected/unregistered/clock_skew (лог ошибок)
list_data_quality_issues(project, {env?, limit?, since_days?})
  // semantic conflicts: e.g. brief.completed exists, but entity status is still "new"
```

Три `*_funnel_investigation` tools доступны в Core source/local runner и
зарезервированы для следующего MCP package release. Опубликованный
`@poolstatis/mcp@0.6.0` их ещё не содержит; до отдельного publish gate используйте
REST endpoints. Номер в `packages/mcp/package.json` сам по себе не является
свидетельством публикации.

MCP tools expose structured JSON output (`structuredContent`) with a text JSON fallback for older clients.
Web tools используют только typed Query DSL и registry metric keys: raw SQL и
raw event-name escape hatch отсутствуют. Полный контракт:
[13-browser-analytics.md](13-browser-analytics.md).
Контракт Actors/Person доступен агенту как
`poolstatis://standard/actors`.

### Инсайты

```
list_insights(project, {status?, kind?})
create_insight(project, {title, body, query?})        // kind='manual'
resolve_insight(project, id, {status: 'ack'|'resolved'})
```

## Принципы дизайна тулов

1. **Тул = одно намерение агента.** Не «универсальный query endpoint с 20 параметрами», а отдельные тулы под trend/funnel/entities — так агент реже ошибается в параметрах, а описания тулов короче.
2. **Ошибки учат.** Ответ на невалидный вызов содержит исправление: `register_metric` с занятым key возвращает существующую метрику и подсказку «используй update_metric или другой key». Агент — основной пользователь, и сообщение об ошибке — это его документация.
3. **Runtime-ингеста в MCP нет.** События шлёт продукт по HTTP. Узкое исключение —
   previewed historical backfill из доверенной базы продукта; это не замена SDK
   и не способ генерировать текущий трафик из чата.
4. **Запись метаданных безопасна по умолчанию.** Всё, что создаёт агент, рождается `proposed`; активация — отдельное действие, которое владелец может оставить за собой. Retirement идёт через `deprecate_metric(reason)`, чтобы следующий агент видел, почему метрика больше не используется.
5. **Семантическое изменение сначала объясняется.** MCP может прочитать историю и
   подготовить preview purpose/source с dependency impact, но не содержит
   `apply_metric_definition`. Подтверждение и optimistic apply остаются в
   авторизованном human admin flow. Legacy REST PATCH сохраняется для
   совместимости и всё равно пишет `legacy_update` revision.

## Транспорт

MVP: stdio-сервер и version-pinned npm-пакет `@poolstatis/mcp@0.6.0` (токен только в env). Встроенный `poolstatis://standard/browser-analytics` соответствует production-контракту: сбор начинается сразу после `start()`, маршруты остаются конечными ключами, страна добавляется только серверным trusted-proxy/MMDB resolver, а совместимость старого SDK удаляет небезопасные path-поля без потери целого события. Hosted deploy включает пакет только после fresh-install initialize, полного tool-list и project-scoped read smoke. Поддерживаемые presets: Claude Code, Claude Desktop, Codex, Cursor, Warp, Windsurf, VS Code/Copilot, Cline, Zed, Continue, Replit, OpenCode, Hermes-style launchers и custom MCP host. Streamable HTTP — отдельный этап после hosted-стабилизации.
