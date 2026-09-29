# Railway Backend Deploy

This deploy target runs `apps/bot` as the LifeOS backend.

## Configure

In Railway, create a service from the repo and set the Dockerfile path:

```text
deploy/railway/Dockerfile
```

Set healthcheck path:

```text
/healthz
```

## Variables

```bash
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=replace-with-anon-key
SUPABASE_SERVICE_ROLE_KEY=replace-with-service-role-key
TELEGRAM_BOT_TOKEN=replace-with-telegram-token
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=replace-with-random-secret
TMA_URL=https://YOUR_TMA_HOST
LIFEOS_HEALTH_INGEST_JWT_SECRET=replace-with-random-health-jwt-secret
LIFEOS_ADMIN_TELEGRAM_IDS=123456789
LIFEOS_SIGNUP_MODE=pending_approval
# Legacy/dev bootstrap only:
LIFEOS_DEFAULT_USER_ID=your-auth-user-uuid
LIFEOS_DEFAULT_TELEGRAM_USER_ID=your-telegram-user-id
ALLOW_UNSAFE_TMA_DEV_AUTH=false
```

## Deploy

```bash
railway login
railway link
railway up
railway logs
```

After deployment, configure Telegram:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_RAILWAY_DOMAIN/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Private Python workers

For the exact Windows PowerShell setup and staged launch commands, see
`deploy/railway/PLATONUS_RUNBOOK.md`.

Create two additional empty services in the same Railway project, with the
repository root as each build context:

| Service | Custom Dockerfile path | Purpose |
| --- | --- | --- |
| `lifeos-platonus-worker` | `deploy/railway/platonus-worker.Dockerfile` | Poll and compare Platonus grades |
| `lifeos-reminder-worker` | `deploy/railway/reminder-worker.Dockerfile` | Send due Supabase reminders to Telegram |

Set `RAILWAY_DOCKERFILE_PATH` in each service's Variables to its path above.
The images run their `run-loop` commands by default. Keep both as private,
single-replica persistent services without public domains or HTTP healthchecks.
Set the required runtime variables in each service's Railway Variables:

For `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `TELEGRAM_BOT_TOKEN`, use
Railway reference variables pointing at the existing backend service's
Variables. Store `PLATONUS_USERNAME` and `PLATONUS_PASSWORD` only on the new
Platonus service.

- Platonus: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `LIFEOS_DEFAULT_USER_ID`,
  `LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC=true`,
  `PLATONUS_USERNAME`, `PLATONUS_PASSWORD`,
  `PLATONUS_SYNC_POLL_SECONDS=900`, `PLATONUS_SYNC_MOCK_MODE=false`.
- Reminder: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `TELEGRAM_BOT_TOKEN`, `REMINDER_WORKER_POLL_SECONDS=30`,
  `REMINDER_WORKER_BATCH_SIZE=20`, `APP_TIMEZONE=Asia/Qyzylorda`,
  `REMINDER_WORKER_ONLY_POLICY_KEY=platonus_grade`.

The policy filter is required for this rollout: the existing Supabase queue
contains an older general reminder. The dedicated sender must leave it alone.

Before deployment, establish the baseline locally with
`local_baseline.py --expected-grades 12` as described in
`deploy/railway/PLATONUS_RUNBOOK.md`. Run the read-only dry-run again and
confirm the current grades are unchanged with `would_send: []`. Then start
the two Railway services.

`railway up --service lifeos-platonus-worker` and
`railway up --service lifeos-reminder-worker` upload local code. `.railwayignore` and `.dockerignore` exclude local
credentials and HAR captures. Do not use `--no-gitignore`.
