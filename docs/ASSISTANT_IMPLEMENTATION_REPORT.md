# IMPLEMENTED

Реализован фундамент Assistant Brain + Intent Router + Runtime Tools +
Supabase memory в ветке `codex/assistant-foundation`. Изменения локальные;
production, удалённая БД и GitHub не изменялись. Новых зависимостей нет.

Поддерживаются запросы о сегодняшнем/завтрашнем расписании, следующей паре,
недельном расписании, окнах свободного времени, событиях после занятий,
календаре, задачах, оценках и изменениях Platonus, напоминаниях и памяти.
Неоднозначное время напоминания требует уточнения; запись не создаётся.

# ARCHITECTURE

`Telegram → active user → AssistantBrain.handle → router/context → registry
validation + authorization → existing service/store → Supabase`.

- Чистые схемы, правила и контракты: `packages/core/src/assistant/`.
- Orchestration, provider и runtime tools: `apps/bot/src/assistant/`.
- Память/audit: `packages/db/src/assistant-store.ts`.
- Расписание использует существующие `ScheduleService` и formatter.
- Напоминания используют существующий parser, store и worker.
- Google/Platonus читаются из существующих синхронизированных данных.

Полный аудит A–J, схема, allowlist, lifecycle и rollout:
[ASSISTANT_ARCHITECTURE.md](ASSISTANT_ARCHITECTURE.md).

# LIFEOS IDEAS USED

Из [reference на зафиксированном commit](https://github.com/danielmiessler/LifeOS/tree/5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c/LifeOS/install)
адаптированы единый контракт памяти, явные кандидаты, ограниченный retrieval,
provenance, контекст запроса, deduplication и проверка границы исполнения.
Конкретные изученные файлы и ссылки перечислены в архитектурном документе.

# LIFEOS IDEAS NOT USED

Pulse, локальный daemon, filesystem как источник памяти, swarm, полный Algorithm,
CLI hooks, shell/SQL инструменты модели и self-modification. Runtime продукта
сохранил собственную архитектуру и deployment.

# FILES CREATED

```text
apps/bot/src/assistant/brain.ts
apps/bot/src/assistant/context.ts
apps/bot/src/assistant/create.ts
apps/bot/src/assistant/provider.ts
apps/bot/src/assistant/registry.ts
apps/bot/src/assistant/reminder-input.ts
apps/bot/src/assistant/schedule-tools.ts
apps/bot/src/assistant/tools.ts
apps/bot/src/assistant/brain.test.ts
apps/bot/src/assistant/provider.test.ts
apps/bot/src/assistant/registry.test.ts
apps/bot/src/assistant/telegram.test.ts
apps/bot/src/assistant/tools.test.ts
apps/bot/src/assistant/test-helpers.ts
packages/core/src/assistant/availability.ts
packages/core/src/assistant/contracts.ts
packages/core/src/assistant/index.ts
packages/core/src/assistant/memory.ts
packages/core/src/assistant/router.ts
packages/core/src/assistant/schema.ts
packages/core/src/assistant/assistant.test.ts
packages/db/src/assistant-store.ts
packages/db/src/assistant-tables.ts
packages/db/src/assistant-store.test.ts
supabase/migrations/20260929000200_assistant_foundation.sql
supabase/tests/assistant_foundation.sql
scripts/test-assistant-db.mjs
docs/ASSISTANT_ARCHITECTURE.md
docs/ASSISTANT_IMPLEMENTATION_REPORT.md
```

# FILES MODIFIED

```text
README.md
apps/bot/.env.example
apps/bot/src/config.ts
apps/bot/src/index.ts
apps/bot/src/server.ts
apps/bot/src/telegram/commands.ts
apps/bot/src/telegram/commands.test.ts
apps/bot/src/telegram/types.ts
packages/core/src/index.ts
packages/db/src/index.ts
packages/db/src/lifeos-store.ts
packages/db/src/types.ts
docs/ARCHITECTURE.md
docs/BOT_UX.md
docs/DATABASE.md
docs/SECURITY.md
```

# DATABASE MIGRATIONS

`20260929000200_assistant_foundation.sql` создаёт:

- `assistant_memories`: user/key uniqueness, пять типов, confidence, importance,
  source, revision, timestamps, archive; atomic upsert заменяет активный факт.
- `assistant_actions`: уникальный user/request claim до исполнения, статус,
  intent/tool, длительность и безопасный error code. Текст запроса, аргументы
  tool и ответы не записываются в audit.

Добавлены RLS, owner-read policies, индексы и триггеры. Клиентские записи
запрещены; service-role запросы дополнительно scoped по `user_id`.
Существующие migrations и operational tables не переписаны.

Проверены clean database и upgrade со старой схемой и существующей задачей:
в каждом случае применены все 35 migrations. Тестовый PostgreSQL 17 использует
минимальные auth/storage contracts Supabase, реальные SQL/RLS/privileges и
отдельный контейнер без внешней сети. Hosted Supabase/PostgREST/GoTrue не
вызывались. Временные контейнеры остановлены и автоматически удалены.

# SECURITY

- Только активный профиль и личный Telegram chat достигают Brain.
- Персональное расписание сохраняет owner-only permission.
- Strict schemas отклоняют неизвестные поля, включая подставленный `userId`.
- Модель получает только разрешённые READ descriptors; записи требуют точного
  явного пользовательского запроса, распознанного deterministic router.
- DESTRUCTIVE/SENSITIVE execution запрещён; health/finance/credentials tools нет.
- Модель не получает DB client, keys, user IDs, permissions или raw app records.
- Секреты/временные факты фильтруются перед записью памяти; обычный разговор
  не превращается в memory автоматически.
- Уникальный durable claim предотвращает повторное исполнение записи при retry.
- Errors/audit не содержат исходных сообщений, provider errors или credentials.

# TESTS

Проверки выполнены 2026-09-29. Windows host: Node 25; deployment image: Node
22.23.3. Ниже результаты последних выполнений соответствующих проверок.

| Команда                                                                                                                                                                                   | Результат                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                          | PASS                                                                   |
| `pnpm test`                                                                                                                                                                               | PASS: 318 tests, 29 files; baseline 228 tests                          |
| `py -3 -m unittest workers.test_worker_suite`                                                                                                                                             | PASS: 85 tests                                                         |
| `pnpm --filter @lifeos/tma typecheck`                                                                                                                                                     | PASS                                                                   |
| `pnpm --filter @lifeos/tma build`                                                                                                                                                         | PASS: Vite production build                                            |
| `pnpm --filter @lifeos/web typecheck`                                                                                                                                                     | PASS                                                                   |
| `pnpm --filter @lifeos/web build`                                                                                                                                                         | PASS: Next.js production build                                         |
| `node scripts/test-assistant-db.mjs`                                                                                                                                                      | PASS: clean + upgrade, 35 migrations each, lifecycle/RLS/grants/dedupe |
| `docker build -f deploy/railway/Dockerfile -t lifeos-assistant-verify:20260929 .`                                                                                                         | PASS: existing Railway image                                           |
| `docker run --rm --network none lifeos-assistant-verify:20260929 pnpm typecheck`                                                                                                          | PASS on Node 22                                                        |
| `docker run --rm --network none lifeos-assistant-verify:20260929 pnpm exec vitest run apps/bot/src/assistant packages/core/src/assistant packages/db/src/assistant-store.test.ts`         | PASS: 89 new-layer tests                                               |
| Backend container smoke: `docker run --detach --rm --network none lifeos-assistant-verify:20260929`, followed by `docker exec` running Node fetch against `http://127.0.0.1:3000/healthz` | PASS: HTTP 200, status `ok`, service `lifeos-bot`; container stopped   |
| `git diff --check`                                                                                                                                                                        | PASS                                                                   |
| `pnpm format:check`                                                                                                                                                                       | FAIL: four pre-existing, unchanged files listed below                  |

Pre-existing formatting failures: `apps/tma/wrangler.jsonc`,
`deploy/railway/README.md`, `pnpm-lock.yaml`, `workers/google-sync/README.md`.
`git diff --quiet HEAD -- <these four paths>` confirmed exact baseline content.
Formatting of changed/new supported files is checked separately. There is no
lint/ESLint script in the repository; no separate lint PASS is claimed.

New tests cover routing, invalid/unknown/unauthorized tools, model-output
validation, absent/ambiguous reminder time, owner-only schedule, memory lifecycle,
cross-user retrieval/archival, request dedupe, audit failures, real HTTP webhook
authentication, overlapping events, timezone/DST, provider separation and HTML
escaping. DB adapter tests intercept Supabase requests; SQL tests exercise actual
Postgres security and constraints.

# REGRESSION STATUS

- `/schedule`, `/tomorrow`: existing tests pass; NL parity verified.
- `/remind`, pending reminders and Python reminder worker: tests pass.
- Platonus baseline/change notification/dedupe worker tests: pass.
- Existing finance and capture flows: pass, including assistant-enabled quick
  finance and explicit assistant requests containing finance keywords.
- Google, ICS, Obsidian, monthly review and university workers: suite passes.
- TMA/Web: builds and typechecks pass; no frontend changes.

These results verify local code behavior, not the state of deployed services.

# KNOWN LIMITATIONS

- Feature rollout is opt-in: apply the migration, then set
  `ASSISTANT_ENABLED=true`. It is disabled by default to preserve an unmigrated
  deployment. Deterministic operation requires no model key.
- Optional OpenRouter classifier requires `ASSISTANT_MODEL_ENABLED=true`,
  `ASSISTANT_MODEL` and `OPENROUTER_API_KEY`. No real model request was made.
- No deployment, hosted DB migration, live Telegram send or live Platonus/Google
  call was performed. General reminder delivery needs an existing general worker;
  a sender filtered to `platonus_grade` will not deliver ordinary reminders.
- Router executes one tool per request. TMA/Web adapters and multi-step planning
  are future work; no public API/auth shortcuts were added.
- “New grades” means recorded changes in the last seven days, not unread grades.
- “Evening”/missing times ask for a complete clarified request with an exact time.
- Memory uses explicit opt-in and stable keys, not unrestricted automatic
  extraction. Unnamed corrections require restating the subject; arbitrary keys
  are not semantically merged. Archive is reversible and is not physical deletion.
- Retrieval uses bounded keywords/types/ranking, not embeddings. Background
  distillation has a documented port/design, not an autonomous worker.
- Free-time calculation uses saved schedule/calendar only; excludes travel and
  unscheduled tasks, and cannot establish availability from stale upstream data.
- The audit gives at-most-once execution: a crash after claim and before mutation
  may leave an unexecuted `running` request. Inspect existing data before sending
  a new request; automatic replay is deliberately absent.

# NEXT RECOMMENDED PHASE

Apply the migration through the normal release process and enable deterministic
mode for the owner. Run a live smoke test with the existing general reminder
worker. Then add source freshness and reviewed memory correction/consolidation,
followed by multi-step day planning through the same bounded tool registry.
