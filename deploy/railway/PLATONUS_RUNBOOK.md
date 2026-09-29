# Launch Platonus grade alerts from Windows PowerShell

Run these commands from the repository root. The existing backend remains in
its current Railway service. Establish the baseline and verify an unchanged
dry-run before starting either new service. Do not use `railway variable list --kv` or copy secret values into
the terminal history.

## 1. Establish and verify the baseline locally

Run a live dry-run first and confirm it shows 12 grades and
`baseline_not_established`. Then enter credentials at the prompts and run both
the one-time baseline and the read-only comparison in the same PowerShell
session:

```powershell
$env:PLATONUS_USERNAME = Read-Host 'Platonus login'
$secure = Read-Host 'Platonus password' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:PLATONUS_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Variable secure,ptr -ErrorAction SilentlyContinue
}
try {
    py -3 .\workers\university-sync\platonus\local_baseline.py --expected-grades 12
    if ($LASTEXITCODE -ne 0) { throw 'Baseline failed' }
    py -3 .\workers\university-sync\platonus\local_dry_run.py
    if ($LASTEXITCODE -ne 0) { throw 'Dry-run failed' }
} finally {
    Remove-Item Env:\PLATONUS_USERNAME,Env:\PLATONUS_PASSWORD -ErrorAction SilentlyContinue
}
```

The baseline result must report `grades_seen: 12`,
`unchanged_after_save: 12`, and `notifications_queued: 0`. The second dry-run
must report `status: "compared"`, `unchanged: 12`, and `would_send: []`.
`example_message_preview_only` is an illustration, never an outgoing alert.
Stop here if either result differs.

## 2. Create and configure private services

```powershell
npm i -g @railway/cli
railway login
railway link
railway environment
railway service list
$backend = Read-Host 'Name of the existing backend Railway service'
railway add --service lifeos-platonus-worker
railway add --service lifeos-reminder-worker

$urlRef = '${{' + $backend + '.SUPABASE_URL}}'
$keyRef = '${{' + $backend + '.SUPABASE_SERVICE_ROLE_KEY}}'
$botRef = '${{' + $backend + '.TELEGRAM_BOT_TOKEN}}'

railway variable set RAILWAY_DOCKERFILE_PATH=deploy/railway/platonus-worker.Dockerfile LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC=true PLATONUS_SYNC_POLL_SECONDS=900 PLATONUS_SYNC_MOCK_MODE=false -s lifeos-platonus-worker --skip-deploys
railway variable set "SUPABASE_URL=$urlRef" "SUPABASE_SERVICE_ROLE_KEY=$keyRef" -s lifeos-platonus-worker --skip-deploys

$ownerId = py -3 .\workers\university-sync\platonus\local_dry_run.py --owner-id
if ($LASTEXITCODE -ne 0 -or $ownerId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Could not resolve the LifeOS owner ID' }
$ownerId | railway variable set LIFEOS_DEFAULT_USER_ID --stdin -s lifeos-platonus-worker --skip-deploys
Remove-Variable ownerId

$login = Read-Host 'Platonus login'
$login | railway variable set PLATONUS_USERNAME --stdin -s lifeos-platonus-worker --skip-deploys
Remove-Variable login
$secure = Read-Host 'Platonus password' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $plain | railway variable set PLATONUS_PASSWORD --stdin -s lifeos-platonus-worker --skip-deploys
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Variable secure,ptr,plain -ErrorAction SilentlyContinue
}

railway variable set RAILWAY_DOCKERFILE_PATH=deploy/railway/reminder-worker.Dockerfile REMINDER_WORKER_POLL_SECONDS=30 REMINDER_WORKER_BATCH_SIZE=20 REMINDER_WORKER_ONLY_POLICY_KEY=platonus_grade APP_TIMEZONE=Asia/Qyzylorda -s lifeos-reminder-worker --skip-deploys
railway variable set "SUPABASE_URL=$urlRef" "SUPABASE_SERVICE_ROLE_KEY=$keyRef" "TELEGRAM_BOT_TOKEN=$botRef" -s lifeos-reminder-worker --skip-deploys
Remove-Variable backend,urlRef,keyRef,botRef -ErrorAction SilentlyContinue
```

Set both services to one replica and leave them without public domains or HTTP
healthchecks in Railway. The reference variables point to the existing backend
service in the same Railway project and environment.

## 3. Start the Platonus poller

```powershell
railway up --service lifeos-platonus-worker
railway logs --service lifeos-platonus-worker --lines 30
```

Confirm the log contains `platonus_sync complete` and `seen=12` (or the new
current count) with `reminders_created=0`. If a mark changed since the local
baseline, review the queued notification before starting the sender.

## 4. Start the Platonus-only Telegram sender

```powershell
railway up --service lifeos-reminder-worker
railway logs --service lifeos-reminder-worker --lines 30
```

`REMINDER_WORKER_ONLY_POLICY_KEY=platonus_grade` keeps unrelated pending
reminders untouched. A later changed grade is queued in Supabase by the
Platonus poller and sent to the linked active Telegram profile by this sender.
