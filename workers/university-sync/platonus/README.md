# Platonus grade notifications

The Platonus worker writes grades to `academic_records`. After one successful
baseline sync, it queues a Telegram notification when an assessment appears or
its numeric grade changes. The reminder worker sends the notification to the
active Telegram profile linked to the same LifeOS `user_id`. The message includes
the subject, assessment, grade, and teacher when the portal supplies one.

`gradebook_html.py` parses a saved student current-progress journal. It was
checked against an authenticated HTML export: the page exposes numeric weekly
marks, course names, streams, and a teacher per stream. It does not identify the
person who actually entered each mark, so the message labels this field as the
course teacher. Derived totals are ignored to avoid a burst of alerts when one
weekly mark changes.

`PlatonusClient` now follows the routes recovered from the local captures and
login script: it opens `/index`, posts JSON to `/rest/api/login` using a cookie
jar, then reads `/current_progress_gradebook_student` and parses the HTML.
The worker queues changes against the last Supabase grade state; its first
successful run establishes a baseline. A failed sign-in, verification step, or
unrecognized journal page stops the run without creating grade alerts. Mock
grades require explicit opt-in and never trigger grade notifications.

Local `diagnose` returned HTTP 200 for `/index`, `/rest/api/login`, and
`/current_progress_gradebook_student`, and parsed 12 grades in 4 courses on
2026-09-29. That confirms the sign-in and parsing flow on the development
machine. Railway outbound access and database writes still need separate
verification before relying on production alerts.

The September 29 capture contained one successful authenticated
`GET /current_progress_gradebook_student` with a Cookie header. It confirmed
the gradebook URL and a form with `studentID`, `year`, and `term`, but contained
no login requests or redirects. Local `diagnose` subsequently verified the
login flow. Keep raw HAR files and cookies outside the repository.
`sanitize_har.py` creates a
structural `platonus_clean.har` copy before anyone inspects a capture:

```bash
python workers/university-sync/platonus/sanitize_har.py RAW.har platonus_clean.har
```

A second capture of the login page contained only GET requests. Its redacted
HTML structure exposed `login` and `password` input names, and its redacted
script route list included `rest/api/login` and `rest/api/verifyCode`. The
third capture also contained only login page GETs. These did not capture a
submitted login, response, session cookie issuance, or post-login redirect.

For local development, use `.env.example` only as a template and keep `.env`
out of Git. In Railway, set variables on the private service. Establish the
baseline locally and verify an unchanged dry-run before deployment; subsequent
`run-loop` iterations poll at an interval such as 900 seconds. The reminder
worker must also run with its own Supabase and Telegram bot settings. The
polling interval plus reminder interval sets the normal alert delay. Check
`sync_runs` for failures before relying on alerts.

The multi-user `lms_grades_worker.py` can use encrypted rows in
`user_lms_settings` instead; its `ENCRYPTION_KEY` must match the key used to
encrypt the password. The first successful sync for each account is a baseline
and does not send old grades.

## Local diagnostic (PowerShell)

`diagnose` needs only `PLATONUS_USERNAME` and `PLATONUS_PASSWORD` in the
current process environment. It does not read `.env`, connect to Supabase,
write grades, or send Telegram messages. Enter values at the prompts so they
are not stored in the command history:

```powershell
$env:PLATONUS_USERNAME = Read-Host 'Platonus login'
$platonusSecure = Read-Host 'Platonus password' -AsSecureString
$platonusPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($platonusSecure)
try {
    $env:PLATONUS_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($platonusPtr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($platonusPtr)
    Remove-Variable platonusSecure,platonusPtr -ErrorAction SilentlyContinue
}
py -3 .\workers\university-sync\platonus\platonus_sync.py diagnose
Remove-Item Env:\PLATONUS_USERNAME,Env:\PLATONUS_PASSWORD -ErrorAction SilentlyContinue
```

Run the commands from the repository root. Success reports the number of
parsed grades and courses plus sanitized request status and redirects. Failure
prints only HTTP status, sanitized URL, sanitized redirect, and a fixed reason
code. It never prints the request or response body, Cookie, token, or password.

## Read-only notification dry-run

`dry-run` signs in, fetches the current journal, and compares each grade with
the user's saved Supabase `source_events` and `academic_records`. It also checks
the reminder dedup key and renders each proposed message through the real
reminder worker formatter. It makes only `GET` requests to Supabase: no sync
run, grade, reminder, or Telegram message is created. If there has not been a
successful baseline sync, it reports `baseline_not_established` and proposes no
messages. `example_message_preview_only` shows the format of one current grade
even before the baseline; it is never queued. If all grades match,
`would_send` is empty.

The command requires the Platonus variables above plus `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `LIFEOS_DEFAULT_USER_ID`, and
`LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC=true` in the process environment.
Run `python workers/university-sync/platonus/platonus_sync.py dry-run` from the
repository root. Never paste credential values into a command or terminal log.

On the development Windows machine, `local_dry_run.py` reads the existing,
ignored `apps/bot/.env`, resolves the single active admin profile to its
`user_id` if needed, then invokes the same read-only dry-run. It does not save
Platonus credentials. With the Platonus variables set by the PowerShell prompt
above, run:

```powershell
py -3 .\workers\university-sync\platonus\local_dry_run.py
```

For deployment setup, `local_dry_run.py --owner-id` prints only the resolved
Supabase user UUID. It does not contact Platonus or require its credentials.

When the baseline has not been saved yet, a real first `sync-once` will create
it without grade notifications. Run the dry-run again afterward to confirm
`would_send` stays empty for unchanged marks.

For the one-time local baseline step, use `local_baseline.py` after a successful
live dry-run. It rejects an existing successful baseline, mock data, a grade
count different from `--expected-grades`, unrelated records under the
university source, or pending Platonus notifications. It bypasses the generic
reminder scheduler, writes the live grades to Supabase, and reads them back to
confirm they are unchanged. It never calls Telegram. With Platonus credentials
set in the current PowerShell process, run:

```powershell
py -3 .\workers\university-sync\platonus\local_baseline.py --expected-grades 12
```

Expected output includes `status: "baseline_established"`,
`grades_seen: 12`, `unchanged_after_save: 12`, and
`notifications_queued: 0`. Clear both Platonus environment variables after
the command, then repeat the local dry-run with fresh credentials.

## Railway worker

Run the standalone Platonus worker as a separate private Railway service from
the repository root. Select `deploy/railway/platonus-worker.Dockerfile` as its
Dockerfile path. Its default command is `platonus_sync.py run-loop`; it polls
every `PLATONUS_SYNC_POLL_SECONDS` (900 seconds in `.env.example`). Store all
credentials in that Railway service's Variables, never in source files, Docker
build arguments, or a public domain. Required variables are:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LIFEOS_DEFAULT_USER_ID`
- `LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC=true`
- `PLATONUS_USERNAME`, `PLATONUS_PASSWORD`
- `PLATONUS_SYNC_POLL_SECONDS=900`, `PLATONUS_SYNC_MOCK_MODE=false`

The repository's `.railwayignore` and `.dockerignore` exclude local `.env`
files, HAR files, and `secrets/` from uploads and Docker build context. Run
only one Platonus poller for this user. The reminder worker must also be
running to deliver pending notifications to Telegram. Its Railway Dockerfile is
`deploy/railway/reminder-worker.Dockerfile`.
