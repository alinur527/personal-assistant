# Assistant Foundation

## Scope and audited baseline

Product: `alinur527/personal-assistant`, baseline `f192264` (2026-09-29).
Reference only: `danielmiessler/LifeOS`, inspected at
`5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c`. No reference code, dependencies,
install scripts, agents, hooks or infrastructure were installed into the product.
The pre-change baseline passed `pnpm typecheck`, 228 Vitest tests and 85 worker
tests. The architecture audit was presented before implementation.

### A. Current personal-assistant architecture

- `apps/bot/src/server.ts`: Node HTTP, webhook validation, TMA initData,
  active-profile resolution, Google OAuth and health ingest boundaries.
- `apps/bot/src/telegram/commands.ts`: existing command registry. Plain text
  defaults to capture, with quick-finance/question overrides.
- `packages/core/src/schedule/{service,static-provider,formatter}.ts`:
  owner-specific university timetable, current group 25-04/subgroup A.
- `packages/core/src/{modes,focus,source-events,parsers}.ts`: reusable domain
  rules; `packages/core/src/finance.ts` already contains finance-specific
  OpenRouter calls, but no generic model-provider interface. That existing
  boundary debt is not expanded or refactored in this change.
- `packages/db/src/lifeos-store.ts`: typed operational store and identity
  resolution. `packages/db/src/types.ts`: hand-maintained Supabase contracts.
- `supabase/migrations/`: additive ordered SQL; `auth.users.id` is `user_id`,
  linked through `profiles.telegram_user_id`. Service role bypasses RLS, so
  application scoping is essential as well as policies.
- `workers/google-sync/google_sync.py`: read-only, user-scoped Calendar/Tasks
  ingestion into source events, normalized entities and reminders.
- `workers/university-sync/platonus/platonus_sync.py`: guarded single-user
  grade ingestion, baseline suppression, deduplicated change notifications.
- `workers/reminder-worker/reminder_worker.py`: claims/delivers stored reminders.
- `workers/obsidian-mirror/obsidian_mirror.py`: user-scoped read mirror; no
  independent source of truth.
- `apps/tma/src/api/client.ts`: authenticated backend calls. `apps/web/app/`:
  Next.js dashboard; production web auth remains outside this phase.
- `deploy/railway/{Dockerfile,platonus-worker.Dockerfile,reminder-worker.Dockerfile}`:
  existing deployment boundaries; other workers retain their current hosting.
- Tests: colocated Vitest; `workers/test_worker_suite.py` aggregates Python tests.
  Root typecheck excludes frontends, which require their own checks.

### B. LifeOS relevant architecture

The inspected implementation, rather than only its README, informed the design:

- [Cortex.ts](https://github.com/danielmiessler/LifeOS/blob/5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c/LifeOS/install/LIFEOS/TOOLS/Cortex.ts)
  provides a versioned memory envelope, provenance, bounded reads and distinct
  propose/remember operations over a canonical filesystem corpus.
- [Cortex SKILL.md](https://github.com/danielmiessler/LifeOS/blob/5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c/LifeOS/install/skills/Cortex/SKILL.md)
  uses trigger descriptions and a subcommand workflow table for typed knowledge,
  recall, contradictions, retrieval and distillation.
- [MemoryRetriever.ts](https://github.com/danielmiessler/LifeOS/blob/5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c/LifeOS/install/LIFEOS/TOOLS/MemoryRetriever.ts)
  ranks keywords/tags with BM25-style scoring and limits returned context;
  embeddings are not required for a useful first version.
- [MemoryTurnStart.hook.ts](https://github.com/danielmiessler/LifeOS/blob/5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c/LifeOS/install/hooks/MemoryTurnStart.hook.ts)
  combines hot memory and query-specific retrieval. `LoadContext.hook.ts`
  separates static rules from dynamic relationship, learning and active-work data.
- [KnowledgeDistill.ts](https://github.com/danielmiessler/LifeOS/blob/5e2f2e8c0abde612da0e99c16c0d07d4ec21b88c/LifeOS/install/LIFEOS/TOOLS/KnowledgeDistill.ts)
  gathers recent knowledge, deduplicates previously surfaced items and routes a
  cited digest into existing destination systems. It does not rewrite the
  knowledge archive itself; distillation is not simply “summarize all memories.”
- `LIFEOS/DOCUMENTATION/Synapse/SynapseSystem.md`: capture → journal → grade →
  route → resurface. This is an input/knowledge routing concept, not a ready-made
  Telegram intent classifier.
- `LIFEOS/ALGORITHM/v8.20.2.md`: evidence-based verification and learning. Its
  full agent workflow is unnecessary for a bounded personal-data request.
- `hooks/PreToolGuard.hook.ts`: isolated execution checks, with mixed fail-open
  policies. This product uses fail-closed validation/authorization instead.
- `LIFEOS/DOCUMENTATION/Pulse/PulseSystem.md`: a separate local daemon/dashboard.
  Parts of its private Assistant runtime are not in the public repository.

### C. Gap analysis

There was no common assistant entry point, tool allowlist, persistent personal
memory, bounded memory retrieval or generic assistant action ledger. Existing
profiles/user settings are configuration, and life captures/source events are
operational data: reusing them as semantic memory would conflate responsibilities.
Finance telemetry is domain-specific and retains different payloads, so the
assistant receives a separate minimal audit table.

### D. Reuse / adapt / skip

| Decision    | Application                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Reuse       | ScheduleService/formatter, existing store methods, auth, Luxon, all workers                             |
| Adapt now   | Cortex memory lifecycle, bounded retrieval, provenance, stable contracts, execution checks              |
| Adapt later | Retrieval ranking/embeddings, reviewed memory consolidation, source freshness-aware planning            |
| Skip        | Pulse, filesystem memory, CLI hooks, full Algorithm, swarm, unrestricted model tools, self-modification |

### E. Proposed architecture, now implemented

```text
Private Telegram text
  -> existing webhook + active profile resolution
  -> AssistantBrain.handle(server-issued principal, message, source, request ID)
  -> deterministic router -> optional read-only model classifier
  -> request context (time, timezone, locale, bounded relevant memories)
  -> registry: schema validation -> permissions/effect -> tool -> output schema
  -> existing ScheduleService / LifeOSStore -> Supabase

/schedule and /tomorrow -> same ScheduleService + formatter
/remind and reminder.create -> same reminder parser + LifeOSStore.createReminder
```

`packages/core/src/assistant` contains only pure rules, schemas and contracts.
I/O and orchestration live in `apps/bot/src/assistant`; persistence lives in
`packages/db/src/assistant-store.ts`. Development `skills/` are untouched and
are never used as runtime capabilities. No new package or dependency is needed.

### F. Files created

- `packages/core/src/assistant/{schema,contracts,router,memory,availability,index}.ts`
- `packages/core/src/assistant/assistant.test.ts`
- `apps/bot/src/assistant/{brain,context,registry,tools,schedule-tools,reminder-input,provider,create}.ts`
- `apps/bot/src/assistant/{brain,registry,provider,tools,telegram}.test.ts`
- `apps/bot/src/assistant/test-helpers.ts` (test-only imports)
- `packages/db/src/{assistant-store,assistant-tables}.ts`
- `packages/db/src/assistant-store.test.ts`
- `supabase/migrations/20260929000200_assistant_foundation.sql`
- `supabase/tests/assistant_foundation.sql`
- `scripts/test-assistant-db.mjs`
- This document and `docs/ASSISTANT_IMPLEMENTATION_REPORT.md`

### G. Files modified

- `apps/bot/src/{config,index,server}.ts`: config and dependency injection.
- `apps/bot/src/telegram/{commands,types}.ts`: authenticated text gateway,
  help examples and export of the existing reminder parser.
- `apps/bot/src/telegram/commands.test.ts`: enabled-assistant finance regression.
- `packages/core/src/index.ts`, `packages/db/src/index.ts`: public exports.
- `packages/db/src/types.ts`: assistant table contracts.
- `packages/db/src/lifeos-store.ts`: scoped grade-change reads, optional grade
  source filtering, overlapping calendar events and date-bounded task queries.
- `apps/bot/.env.example`, `README.md`, `docs/{ARCHITECTURE,DATABASE,BOT_UX,SECURITY}.md`.

### H. Database changes

Two additive tables, no altered operational data:

| Table                | Identity / behavior                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `assistant_memories` | Unique `(user_id, memory_key)`, five types, content, confidence/importance, source, revision, timestamps, archive |
| `assistant_actions`  | Unique `(user_id, request_id)`, conversation/source, message length, intent/tool, status, duration, error code    |

Both have RLS, user-oriented indexes and owner-only authenticated SELECT.
Client writes are revoked. Backend service role has access, with explicit owner
predicates on every read/update. No free-form `structured_data` bag is provided
until a validated use case needs it; this avoids another secret/PII storage path.

### I. Risks and handling

- **Owner timetable leakage:** server derives `schedule.read`; groups never reach
  the Brain. Model arguments cannot supply identity or permissions.
- **Finance/capture regression:** explicit commands and ordinary finance keep
  their paths. Explicit assistant intents win over broad finance keywords.
- **Duplicate writes:** persist an atomic audit claim before execution. A
  duplicate receives an acknowledgement without re-execution, including after
  a crash. This is at-most-once execution: a crash between claim and write can
  leave an unexecuted request. Inspect `/reminders`/memory before a fresh request.
  `running` audit rows require operator review, not an automatic replay.
- **Stale data:** tools say they use saved/synced data. “New grades” means the
  worker's recorded changes within seven days, including delivered notifications.
  It does not mark notifications read or make a live Platonus request.
- **Ambiguous writes:** reminder times need an explicit time. A request with only
  “tomorrow”/“evening” asks for a complete clarified request, with no mutation.
- **Model injection:** schema + allowlist + permission + effect validation;
  model can only select authorized reads. No model prose is rendered as an answer.
- **Unavailable persistence:** assistant actions fail closed; slash commands
  retain their paths. Enable the feature only after migration.

### J. Implementation / rollout plan

The implemented order was core contracts/policy → persistence/migration →
registry/tools/Brain/provider → Telegram → regression/security/DB verification.

1. Apply migrations through the normal Supabase release process. Never run the
   local test script against a hosted DB; it has no hosted-connection option.
2. Deploy the backend code, then set `ASSISTANT_ENABLED=true`.
3. Keep `ASSISTANT_MODEL_ENABLED=false` for deterministic-only operation.
4. Optionally set `ASSISTANT_MODEL_ENABLED=true`, `ASSISTANT_MODEL` and the
   server-only `OPENROUTER_API_KEY`. Choose an endpoint supporting strict JSON
   schemas. Provider requests set `require_parameters=true`, have an eight-second
   timeout, and use [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
5. Check private Telegram parity for `/tomorrow` and «Что завтра?», then a dated
   reminder and explicit memory write/list/archive. Existing reminder delivery
   still requires a running reminder worker. A Railway sender restricted to
   `platonus_grade` will not deliver general reminders; retain/configure the
   existing general reminder worker for those rows.
6. Roll back by disabling `ASSISTANT_ENABLED`; additive tables can remain.

## Runtime tool allowlist

| Tools                                                                          | Effect and scope                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `schedule.get_today/get_tomorrow/get_next/get_week/free_time/after_university` | READ, owner timetable permission                                 |
| `calendar.list_events`                                                         | READ, today's synced Google events, includes overlaps            |
| `tasks.list`                                                                   | READ, `period=today/open`; local tasks + synced Google Tasks     |
| `platonus.get_grades/get_new_grades`                                           | READ, stored grades / actual change ledger                       |
| `reminder.list`                                                                | READ, next ten pending reminders                                 |
| `reminder.create`                                                              | WRITE, explicit request, future timestamp, existing store/worker |
| `memory.list`                                                                  | READ, twenty active memories at most                             |
| `memory.remember/archive`                                                      | WRITE, explicit validated save or reversible archive             |

The registry supports READ/WRITE/DESTRUCTIVE/SENSITIVE classifications. The last
two are denied in this phase. Writes are absent from model descriptors and need
the exact deterministic request arguments, not just a model confidence score.
Health/finance continue through their established flows; calendar/task creation
and destructive actions are not offered to the assistant.

## Memory lifecycle

```text
Explicit user message
 -> candidate extraction (known fact key, or explicit type/key syntax)
 -> strict schema + shouldRemember policy
 -> atomic user/key upsert (revision, source, timestamps)
 -> bounded active retrieval (types, keywords, importance, recency)
 -> optional future reviewed consolidation
```

Types: preference, fact, goal, constraint, learning. Source-of-truth schedule,
tasks, calendar, grades, health and money remain in their operational services.
Questions, transient date/time assertions and secret-shaped content are rejected.
This conservative filter is not a universal semantic classifier or a credential
detector for arbitrary unlabeled strings: do not deliberately store credentials.

Examples:

```text
Запомни: предпочитаю краткие ответы
Запомни: дорога из университета занимает час
Запомни: теперь дорога занимает 40 минут
Запомни: goal fitness.goal: Хочу регулярно заниматься спортом
Запомни: learning study.review: Мне помогает повторение утром
Забудь commute.duration
```

The commute examples share `commute.duration`, so there is one active row and
its revision advances. The original text is not retained as a second active
fact. For other subjects, use the same explicit key for corrections. Ambiguous
follow-ups such as “now 40 minutes” are not guessed; restate the subject with
“Запомни”. Semantically equivalent arbitrary keys are not automatically merged.
Archive removes a record from retrieval, but is not physical erasure.

`AssistantMemoryStore.retrieve(userId, MemoryQuery)` is the replaceable retrieval
port. The first implementation uses sanitized keyword filters, type filters,
importance/recency ordering and a database LIMIT (maximum twenty, four for model
context). Fixed deterministic reads need no memory query. Access touches are
owner-scoped and do not refresh the fact's semantic `updated_at` timestamp.
No transcript or whole-database load is sent to a model.

## Future consolidation boundary

Do not run an autonomous consolidation worker in this phase. A future worker can
read a bounded owner/type/window slice through the memory port, propose merge
candidates with source IDs and observed revisions, then apply the same policy.
Before applying, compare revisions; changed records require re-review. Preserve
source provenance, archive superseded keys transactionally and track a unique
batch key in a worker-specific ledger. Contradictions requiring interpretation
must go through user review. Model-produced merges are proposals, never direct
store writes. Do not distill operational app records into parallel “truth”.

## Verification and limitations

See [Implementation Report](ASSISTANT_IMPLEMENTATION_REPORT.md) for executed
commands/results. Tests cover router, candidate policy, registry authorization,
model output validation, memory scope, SQL lifecycle/RLS, actual HTTP webhook,
duplicate updates, command parity, capture and finance regressions.

No new public TMA/web assistant endpoint or UI was added: the entry point is
ready for a future authenticated adapter. The initial router handles a small
Russian vocabulary; unsupported wording needs the optional model or an existing
command. It executes one bounded tool per request, not a multi-step planner.
Free time uses today's timetable plus saved Google events between 08:00–22:00,
ignores travel and unscheduled tasks, and refuses incomplete/overflowing event
data. It is not a guarantee that the user is available. No live provider,
Telegram-send, university or hosted-database action is part of local tests.
