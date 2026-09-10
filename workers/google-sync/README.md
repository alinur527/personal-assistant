# Google Sync Worker

Trusted local worker for read-only, per-user Google Calendar and Google Tasks
sync. It reads connected rows from `public.user_oauth_connections`, refreshes
encrypted OAuth tokens, and writes user-scoped normalized source events,
sync-runs, life entities, and reminders to Supabase.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python google_sync.py sync-once
.venv/bin/python google_sync.py run-loop
```

Never commit `.env`, OAuth client credentials, or a legacy `token.json`.
Google Tasks due dates have no reliable time component, so LifeOS anchors them
at 18:00 in `APP_TIMEZONE` for reminder policy calculation.

## Production Multi-user Configuration

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, and `LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY` in `.env`.
The Google client and encryption key must match the bot's OAuth configuration.
Keep `LIFEOS_ENABLE_LEGACY_SINGLE_USER_GOOGLE_SYNC=false` (the default).

## Railway Deployment

The worker imports `workers/common/lifeos_sync.py`, so the Railway service
Root Directory must be `/workers` (not `/workers/google-sync`).

| Setting | Value |
|---|---|
| Root Directory | `/workers` |
| Builder | Railpack (auto-detects `requirements.txt`) |
| Build Command | *(leave empty — Railpack installs from `requirements.txt`)* |
| Start Command | `python google-sync/google_sync.py sync-once` |

For a continuous polling service use `python google-sync/google_sync.py run-loop`
as the Start Command instead.

Set all production env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY`, `APP_TIMEZONE`) in the Railway service
Variables tab. Never add secrets to the repository.

See [`docs/GOOGLE_SYNC.md`](../../docs/GOOGLE_SYNC.md) for operations,
verification, and the local-dev-only legacy OAuth option.
