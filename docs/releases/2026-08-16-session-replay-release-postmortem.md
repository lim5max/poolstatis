# Postmortem релиза privacy-safe Session Replay

**Дата релиза:** 15–16 августа 2026
**Статус:** Core, Cloud, npm-пакеты и public site выпущены; потери данных и
небезопасной production-мутации не было.

## Краткий ответ

Релиз действительно занял заметно больше обычного. По публичному git-таймлайну
между первым feature-коммитом в 19:01 и последним site merge в 02:04 прошло не
меньше семи часов. Это нижняя граница по коммитам: она не включает реализацию до
первого коммита и уборку после последнего merge; registry, production deploy и
большая часть read-back происходили внутри этого окна.

Причины были трёх разных типов, и смешивать их под словом «ошибки» неправильно:

1. **Неизбежный объём и полезные security-находки.** Настоящий replay затронул
   73 файла и добавил 7 149 строк: recorder, privacy sanitizer, object storage,
   ingest/read API, MCP, SDK, player, admin UI, три миграции и реальный browser
   E2E. Независимые проверки нашли проблемы, которые нельзя было безопасно
   оставить до production.
2. **Менявшийся по ходу release scope.** После основной реализации в тот же
   выпуск вошли MCP 0.7.0, три funnel tools, SDK 0.4.0, два Trusted Publisher
   workflow, Cloud storage/backup/rollback и четыре последовательных обновления
   public truth.
3. **Предотвратимая операционная работа.** Я начал ветку не в выделенном
   worktree, сделал несколько предположений о production schema/path, дважды
   неправильно подготовил npm publish workflow, поздно проверил mobile layout и
   сначала подал site deploy устаревший artifact. Это моя часть задержки.

Scope расширялся по явным решениям — сначала полный Core, затем MCP, SDK,
production Core и site. Само расширение было нормальным, но я должен был каждый
раз явно переформировать финиш и показывать `готово / сейчас / осталось`, а не
оставлять всё одним бесконечным потоком.

Итог: проверки не были «лишними», но порядок был недостаточно собран. Защитные
гейты сработали fail-closed: неготовые package/site artifacts не были
опубликованы или переключены, а production data fingerprint после релиза
остался совместимым с pre-release evidence.

## Проверяемый масштаб

| Поверхность | Фактический результат |
| --- | --- |
| Core | `b76b0fe728cf42f53b8aae627dfc2d2291aacfd9` |
| Cloud | `827609e600d1fe6e40a7d7cd2d88ba7f08014807` |
| Site | `451211db33ddf4e4fedc4b13bf28389e3123f07b`; обновлена public truth, recorder runtime не включён |
| MCP | `@poolstatis/mcp@0.7.0`, 145 public tools |
| SDK | `@poolstatis/sdk@0.4.0`, отдельный opt-in replay entrypoint |
| Production Core image | `sha256:57584cddf0137664a5592666dfeddcdf6c401067d541694511ddb7f4a5aa11ad` |
| Data/storage | migrations 042–044, отдельный replay volume, encrypted backup и isolated restore |

Session Replay дошёл до Core main через PR
[#33](https://github.com/lim5max/poolstatis/pull/33), а product truth — через
[#34](https://github.com/lim5max/poolstatis/pull/34). Package release потребовал
ещё PR [#35](https://github.com/lim5max/poolstatis/pull/35),
[#36](https://github.com/lim5max/poolstatis/pull/36) и
[#37](https://github.com/lim5max/poolstatis/pull/37). Cloud safeguards прошли
через [Cloud #33](https://github.com/lim5max/poolstatis-cloud/pull/33). Public
site менялся четырьмя replay-PR: [#11](https://github.com/lim5max/poolstatis-site/pull/11),
[#12](https://github.com/lim5max/poolstatis-site/pull/12),
[#13](https://github.com/lim5max/poolstatis-site/pull/13) и
[#14](https://github.com/lim5max/poolstatis-site/pull/14). Эти PR обновляли
документацию и product truth; public site не инициализирует replay recorder и не
создаёт replay ingestion runtime.

## Что замедлило релиз оправданно

### Privacy и correctness

Review до production обнаружил реальные классы дефектов:

- транзакция удаления была собрана через `pool.query`, то есть могла выполняться
  на разных соединениях;
- object write/DB insert и object deletion/DB commit имели crash windows;
- masked mode пропускал PII через `aria-*`, `title`, `alt`, `placeholder`,
  `data-*`, generic rrweb strings и style text;
- timestamp overlap, double sanitize и несовпадающий token mapping ломали
  воспроизводимость layout и scroll;
- SDK имел конкурентный `flush()`/`stop()` drain, невосстанавливаемый failed
  start и ненадёжный pagehide delivery;
- read/delete race позволял начатому GET завершиться после withdrawal;
- migration 043 не обновляла реально применённую 042 и могла удалить audit log
  каскадом;
- selector case folding, tombstone retry и response deadline имели обходы;
- Cloud rollback мог вернуть старый Core после появления replay data, а backup
  guard не fail-closed обрабатывал unreadable directory и duplicate tar member.

Все эти findings были исправлены и покрыты regression tests до production. Если
бы мы «ускорились» их пропуском, релиз был бы короче, но не privacy-safe и не
восстанавливаемым.

### Production safety

Новая миграция и новый object volume потребовали больше обычного:

- immutable exact-SHA Core image и provenance;
- encrypted backup production DB/config/replay storage;
- isolated restore на disposable Postgres и сравнение защищённых counts;
- проверку upgrade path 042–044;
- quiesce writers на критической фазе, rollback evidence и повторные probes;
- отдельный exact-SHA deploy public site и desktop/mobile live read-back.

Это обязательная цена релиза с новой durable storage surface, а не случайная
задержка.

## Мои предотвратимые ошибки

### 1. Неправильный checkout

Я создал/переключил replay-ветку в общем checkout
`/Users/maksimstil/Desktop/poolstatis`, хотя задача имела выделенный worktree.
Это временно затронуло пользовательскую ветку `codex/solid-hugeicons`. Изменения
были безопасно возвращены без reset/clean и дальнейшая работа шла в worktree,
но сам инцидент недопустим.

**Цена:** остановка реализации, проверка двух checkout и ручное восстановление
branch ownership.

**Исправление:** обязательный worktree identity gate до первой мутации; shared
Desktop checkout по умолчанию только read-only.

### 2. Production discovery делалась после неудачных probes

Три read-only команды завершились ошибкой, потому что я предположил старые
имена вместо чтения фактической topology:

- `schema_migrations.version`, тогда как реальная колонка — `name`;
- несуществующая `experience_artifacts` вместо фактических `experience_*` tables;
- несуществующий `docker-compose.production.yml` вместо
  `/opt/poolstatis-cloud/compose.cloud.yml`.

Ни одна команда не меняла production. Но эти ошибки были полностью
предотвратимы через `information_schema`, directory inventory и `docker compose
config` до формирования probes.

### 3. Package workflows проверяли package, но не путь передачи artifact

В release-цепочке GitHub Actions было пять failed runs:

- один Core CI run: SDK dependencies `@rrweb/types` и `@rrweb/record` не были
  установлены тем способом, которым CI запускал SDK typecheck;
- два publish runs (MCP и SDK): `actions/upload-artifact` не увидел tarballs в
  скрытой `.release/` директории;
- ещё два publish runs: относительный путь `release/*.tgz` был интерпретирован
  npm как git package spec (`ssh://git@github.com/release/...`).

Это три корневых дефекта, размноженные на два package workflow. Финальный
контракт использует установленный SDK dependency graph, видимый `release/` и
абсолютные tarball paths. Оба exact-SHA Trusted Publisher runs затем завершились
успешно.

**Цена:** два дополнительных hotfix PR и четыре повторных publish workflow.

**Исправление:** publication workflow должен тестироваться как полный artifact
handoff — pack, upload, download, checksum и `npm publish --dry-run`/package-spec
parsing — до первого trusted publish dispatch.

### 4. Site artifact не был привязан к финальному SHA до deploy

Первый site deploy остановился fail-closed: существующий `dist` не содержал
финальный merge SHA. Первая пересборка тоже не прошла exact-SHA assertion,
потому что `VITE_RELEASE_SHA` не был задан явно. Только сборка с зафиксированным
SHA дала корректный artifact.

Ничего неправильного не переключилось в `current`; это хороший deploy guard,
но плохой preflight.

**Исправление:** удалять/отвергать старый `dist`, собирать только после final
merge с явным release SHA и проверять bytes локально до SSH/upload.

### 5. Public truth выпускалась кусками

Site сначала сообщил source-shipped state, затем package-published state, затем
production proof. После live deploy потребовался отдельный truth PR, а после
browser QA — ещё один mobile-wrap PR. Это привело к четырём replay-related site
PR и нескольким полным копированиям immutable assets.

**Исправление:** до production держать формулировки на уровне source/registry
facts, а live claim и окончательный release SHA выпускать одним post-deploy PR.

### 6. Mobile QA была слишком поздней

Финальная проверка на мобильном viewport обнаружила clipping 40-символьного SHA
в compare callout уже после deploy. Исправление было корректным — короткий
видимый SHA плюс ссылка на полный proof — но должно было попасть в predeploy
browser matrix.

### 7. Два мелких operator mistakes

- В zsh loop переменная `path` перезаписала shell `$path`, поэтому следующий
  `curl` стал `command not found`. Probe был локальным и безопасным; повторён с
  именем `route_path`.
- Сразу после открытия PR команда вернула `no checks reported`, потому что
  workflow ещё не зарегистрировался. Это pending state, а не failure; нужен
  bounded poll с ожиданием появления check suite.

### 8. Cleanup был сформулирован слишком широко

Одна объединённая cleanup-команда с `rm`/`rm -rf` была отклонена до запуска.
Затем cleanup выполнен точечно; отдельный `docker rm -v` сначала закономерно не
сработал для работающего test Postgres, после чего ресурс был остановлен и
удалён.

**Исправление:** cleanup manifest с точными путями и порядком stop → remove,
никаких широких комбинированных команд.

### 9. Прогресс был виден хуже, чем техническая активность

В статусах было много конкретных findings и команд, но не хватало стабильной
карты фаз. После каждого нового разрешения — MCP publish, SDK publish, Core VPS,
site — терминальное условие менялось, а пользователю приходилось самому
понимать, насколько отодвинулся финиш. В результате полезные fail-closed
остановки воспринимались как хаотичные повторные ошибки.

**Исправление:** один release ledger и каждый статус в формате
`завершено / текущая фаза / осталось / реальный blocker`. При расширении scope
старое «почти готово» отменяется явно; сырой лог не заменяет ответ о прогрессе.

## Что уже улучшено

- В `AGENTS.md` добавлен обязательный раздел `Release execution guardrails`:
  identity gate, release ledger, topology discovery, exact artifact contract,
  truth-state separation, progress contract, pre/post browser QA, failure
  classification и cleanup manifest.
- Добавлен `docs/releases/RELEASE_LEDGER_TEMPLATE.md`, чтобы exact SHAs, фазы,
  failures, rollback и cleanup фиксировались одним и тем же способом, а не
  собирались заново в каждом длинном релизе.
- npm workflows уже исправлены на видимый artifact directory и абсолютный
  tarball path.
- Cloud release scripts уже закрывают writer-quiesce race, sealed-env TOCTOU,
  unreadable replay directory и duplicate archive members.
- Replay privacy/correctness findings превращены в regression tests, а не
  оставлены как reviewer notes.

## Что ещё стоит автоматизировать

### P0 — следующий production release

1. **Единый release ledger** для Core/Cloud/site: входные SHA, package versions,
   phases, evidence links, rollback и cleanup targets. Оператор не переходит к
   следующей фазе без заполненного результата текущей.
2. **Site exact-artifact preflight:** clean build после final merge, обязательный
   `VITE_RELEASE_SHA`, byte assertion и desktop/mobile Playwright до SSH.
3. **Package workflow contract test:** один reusable workflow для MCP/SDK,
   проверяющий artifact upload/download и абсолютный publish target без npm
   mutation.
4. **Production inventory command:** read-only скрипт, который выводит реальные
   Compose path/services, current/previous release, schema migration column и
   storage mounts в machine-readable JSON.

### P1 — уменьшение wall-clock без ослабления safety

1. Запускать независимые Core, SDK, MCP и Cloud test groups параллельно после
   локальных targeted tests.
2. Не копировать заново сотни неизменившихся site assets при каждом release;
   использовать content-addressed reuse при сохранении immutable release dirs.
3. Ввести автоматический CI registration poll и единый вывод failed step/root
   cause вместо ручного чтения каждого run.
4. После любого релиза в несколько репозиториев автоматически создавать этот
   postmortem skeleton из release ledger.

## Критерий улучшения для следующего релиза

Следующий сопоставимый релиз считается процессно лучше, если:

- нет мутаций в shared checkout;
- нет команд с угаданными production path/schema identifiers;
- первый publish dispatch получает правильный artifact;
- первый site deploy получает exact-SHA `dist`;
- desktop/mobile defects найдены до первого deploy;
- live truth требует не более одного post-deploy PR;
- каждый failed command сразу классифицирован и не повторяется вслепую;
  transient read-only probes имеют явные backoff, лимит и stop condition;
- при расширении scope пользователь сразу видит новый terminal state и остаток
  фаз.

Цель — убрать повторную работу. Backup/restore, независимый security review,
exact-SHA artifacts, fail-closed deploy и live read-back остаются обязательными:
именно они не дали предотвратимым ошибкам стать production-инцидентом.
