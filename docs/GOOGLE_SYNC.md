# Google Calendar And Tasks Sync

`lifeos-google-sync.service` is a multi-user, read-only Google Calendar and
Google Tasks worker. Supabase is the source of truth:

```text
TMA OAuth -> user_oauth_connections -> google-sync worker
         -> source_events / sync_runs / reminders -> TMA Sources and Schedule
```

The TMA starts OAuth at `GET /api/tma/integrations/google/start`; the bot
callback saves encrypted per-user tokens in `public.user_oauth_connections`.
The worker reads only `provider = google, status = connected` rows using the
Supabase service role. It never reads a user's tokens through the browser.

## Worker Environment

Copy `workers/google-sync/.env.example` to `.env` on the worker host. Required
production values are:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for trusted worker DB access.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, matching the bot's
  OAuth client. They are used only for refresh-token grants.
- `LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY`, exactly the same 32-byte key used by the
  bot (`LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY` / the project's encryption-key
  aliases). It decrypts and re-encrypts `enc:v1` AES-256-GCM token values.
- `GOOGLE_SYNC_LOOKAHEAD_DAYS`, `GOOGLE_SYNC_POLL_SECONDS`,
  `GOOGLE_SYNC_CALENDAR_IDS`, and `GOOGLE_SYNC_TASKLIST_IDS` as optional
  operational limits.

Keep `LIFEOS_ENABLE_LEGACY_SINGLE_USER_GOOGLE_SYNC=false` in production. The
worker's scopes are Calendar readonly, Tasks readonly, and userinfo email; they
must stay aligned with the bot's OAuth request.

## Connect And Sync A User

1. An active Telegram user selects **Connect Google** in TMA Home.
2. Google redirects to the bot callback; TMA Home shows the connected email.
3. Run `sync-once`, or wait for the service poll. The worker creates/upserts
   user-scoped `external_sources`, `source_events`, `sync_runs`, normalized life
   entities, and reminders.
4. Open TMA **Sources** and refresh. Google Calendar and Google Tasks show
   `connected` and their actual `lastSyncAt`; Schedule and Reminders contain
   only that Telegram user's records.

Access tokens are refreshed when they are expired or within one minute of
expiry. The worker writes newly encrypted access/refresh token values and
`expires_at` back to the same `(user_id, provider)` row. A missing, malformed,
or rejected credential is never logged; the connection and its two sources are
marked `error` (or `expired` / `revoked` when that is known) and the user must
reconnect from TMA.

## Run And Inspect

```bash
cd /home/zalewko/lifeos/workers/google-sync
.venv/bin/pip install -r requirements.txt
.venv/bin/python google_sync.py status
.venv/bin/python google_sync.py sync-once

sudo systemctl restart lifeos-google-sync.service
systemctl status --no-pager lifeos-google-sync.service
journalctl -u lifeos-google-sync.service -n 100 --no-pager
```

Logs report events/tasks seen and reminders created, updated, and cancelled.
`status` deliberately reports only an aggregate connection count; it does not
print account emails or tokens. Per-user source/run detail belongs in that
user's authenticated TMA Sources screen or in Supabase service-role operations.

## Verify A Google Task

1. Create a Google Task with a due date.
2. Run `.venv/bin/python google_sync.py sync-once`.
3. Send `/reminders` in Telegram or open the TMA Reminders screen.
4. Confirm the task appears with the `Google Tasks` source label.
5. Complete the Google Task and run sync again.
6. Confirm its future pending reminders are cancelled.

A Google Task due date has no reliable time component. LifeOS anchors it at
18:00 in `APP_TIMEZONE` (`Asia/Qyzylorda` in production).

## Troubleshooting

- TMA Home connected but Sources says `disconnected / never`: ensure the worker
  has run with the production environment above, then refresh Sources.
- A source shows `error`: inspect the worker journal. Reconnect Google if the
  OAuth connection is marked `error`, `expired`, or `revoked`.
- No active connections in `status`: verify this host uses the same Supabase
  project and service-role key as the bot, and the user has completed OAuth.
- Task visible but no reminder: confirm it has a due date and the due date is
  still in the future.
- Duplicate concern: run `sync-once` twice; the second run should log zero
  reminder creates for unchanged events.
- Wrong local time: confirm `APP_TIMEZONE=Asia/Qyzylorda` in the worker env.

## Legacy Local OAuth

For isolated development only, set
`LIFEOS_ENABLE_LEGACY_SINGLE_USER_GOOGLE_SYNC=true` and provide
`GOOGLE_CLIENT_SECRETS_FILE`, `GOOGLE_TOKEN_FILE`, and
`LIFEOS_DEFAULT_USER_ID`. This re-enables the old `google_sync.py auth` flow.
It is not a production multi-user path and must not be enabled on the shared
worker service.
