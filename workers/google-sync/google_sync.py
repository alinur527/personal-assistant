#!/usr/bin/env python3
"""Sync Google Calendar and Google Tasks into LifeOS."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common.lifeos_sync import (  # noqa: E402
    BaseSettings,
    SOURCE_LABELS,
    SupabaseRestClient,
    SyncError,
    SyncStats,
    getenv_bool,
    getenv_int,
    getenv_required,
    iso_utc,
    load_base_settings,
    load_dotenv,
    stable_checksum,
    timezone_for,
)


SCOPES_DEFAULT = (
    "https://www.googleapis.com/auth/calendar.readonly,"
    "https://www.googleapis.com/auth/tasks.readonly,"
    "https://www.googleapis.com/auth/userinfo.email"
)
OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
OAUTH_AAD_PREFIX = "lifeos:user_oauth_connections"
OAUTH_VERSION_PREFIX = "enc:v1"
OAUTH_KEY_BYTES = 32
OAUTH_IV_BYTES = 12


@dataclass(frozen=True)
class Settings:
    base: BaseSettings
    legacy_enabled: bool
    client_secrets_file: Path | None
    token_file: Path | None
    oauth_client_id: str | None
    oauth_client_secret: str | None
    token_encryption_key: bytes | None
    scopes: tuple[str, ...]
    lookahead_days: int
    poll_seconds: int
    calendar_ids: tuple[str, ...]
    tasklist_ids: tuple[str, ...]


def csv_env(name: str, default: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in os.environ.get(name, default).split(",") if item.strip())


def _base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def parse_encryption_key(raw: str) -> bytes:
    """Parse the same 32-byte key formats accepted by packages/db."""
    value = raw.strip()
    try:
        if len(value) == 64 and all(char in "0123456789abcdefABCDEF" for char in value):
            key = bytes.fromhex(value)
        else:
            decoded = base64.b64decode(value, validate=True)
            key = (
                decoded
                if base64.b64encode(decoded).decode("ascii") == value
                and len(decoded) == OAUTH_KEY_BYTES
                else value.encode("utf-8")
            )
    except (ValueError, binascii.Error):
        key = value.encode("utf-8")
    if len(key) != OAUTH_KEY_BYTES:
        raise SyncError("LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
    return key


def load_oauth_encryption_key() -> bytes:
    raw = next(
        (
            os.environ.get(name, "").strip()
            for name in (
                "ENCRYPTION_KEY",
                "LIFEOS_ENCRYPTION_KEY",
                "LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY",
                "OAUTH_TOKEN_ENCRYPTION_KEY",
            )
            if os.environ.get(name, "").strip()
        ),
        "",
    )
    if not raw:
        raise SyncError(
            "LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY (or an ENCRYPTION_KEY alias) is required"
        )
    return parse_encryption_key(raw)


def oauth_aad(user_id: str, provider: str, column: str) -> bytes:
    return f"{OAUTH_AAD_PREFIX}:{user_id}:{provider}:{column}".encode("utf-8")


def oauth_crypto_import() -> Any:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise SyncError("cryptography is required for encrypted OAuth tokens; install requirements.txt") from exc
    return AESGCM


def decrypt_oauth_token(ciphertext: str | None, key: bytes, user_id: str, column: str) -> str | None:
    if ciphertext is None:
        return None
    parts = ciphertext.split(":")
    if len(parts) != 5 or f"{parts[0]}:{parts[1]}" != OAUTH_VERSION_PREFIX:
        raise SyncError("Refusing plaintext or malformed OAuth token; reconnect Google")
    try:
        iv = _base64url_decode(parts[2])
        tag = _base64url_decode(parts[3])
        encrypted = _base64url_decode(parts[4])
        if len(iv) != OAUTH_IV_BYTES:
            raise ValueError("invalid IV")
        plaintext = oauth_crypto_import()(key).decrypt(
            iv, encrypted + tag, oauth_aad(user_id, "google", column)
        )
        return plaintext.decode("utf-8")
    except Exception as exc:  # Crypto failures deliberately reveal no token detail.
        raise SyncError("Could not decrypt Google OAuth token; reconnect Google") from exc


def encrypt_oauth_token(plaintext: str | None, key: bytes, user_id: str, column: str) -> str | None:
    if plaintext is None:
        return None
    try:
        iv = os.urandom(OAUTH_IV_BYTES)
        encrypted_and_tag = oauth_crypto_import()(key).encrypt(
            iv, plaintext.encode("utf-8"), oauth_aad(user_id, "google", column)
        )
    except Exception as exc:
        raise SyncError("Could not encrypt Google OAuth token") from exc
    return ":".join(
        (
            OAUTH_VERSION_PREFIX,
            _base64url_encode(iv),
            _base64url_encode(encrypted_and_tag[-16:]),
            _base64url_encode(encrypted_and_tag[:-16]),
        )
    )


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(Path(__file__).with_name(".env"))
    if env_file:
        load_dotenv(env_file)
    legacy_enabled = getenv_bool("LIFEOS_ENABLE_LEGACY_SINGLE_USER_GOOGLE_SYNC")
    base = load_base_settings(
        require_user_id=legacy_enabled,
    )
    client_secrets_file = (
        Path(getenv_required("GOOGLE_CLIENT_SECRETS_FILE")).expanduser()
        if legacy_enabled
        else None
    )
    token_file = (
        Path(getenv_required("GOOGLE_TOKEN_FILE")).expanduser()
        if legacy_enabled
        else None
    )
    oauth_client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip() or None
    oauth_client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip() or None
    token_key = load_oauth_encryption_key() if not legacy_enabled else None
    if not legacy_enabled and (not oauth_client_id or not oauth_client_secret):
        raise SyncError(
            "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required "
            "for multi-user Google token refresh"
        )
    return Settings(
        base=base,
        legacy_enabled=legacy_enabled,
        client_secrets_file=client_secrets_file,
        token_file=token_file,
        oauth_client_id=oauth_client_id,
        oauth_client_secret=oauth_client_secret,
        token_encryption_key=token_key,
        scopes=csv_env("GOOGLE_SCOPES", SCOPES_DEFAULT),
        lookahead_days=getenv_int("GOOGLE_SYNC_LOOKAHEAD_DAYS", 14),
        poll_seconds=getenv_int("GOOGLE_SYNC_POLL_SECONDS", 300),
        calendar_ids=csv_env("GOOGLE_SYNC_CALENDAR_IDS", "primary"),
        tasklist_ids=csv_env("GOOGLE_SYNC_TASKLIST_IDS", "@default"),
    )


def google_imports() -> tuple[Any, Any, Any]:
    try:
        # pyrefly: ignore [missing-import]
        from google.auth.transport.requests import Request
        # pyrefly: ignore [missing-import]
        from google.oauth2.credentials import Credentials
        # pyrefly: ignore [missing-import]
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError as exc:
        raise SyncError("Google dependencies are missing; install requirements.txt") from exc
    return Request, Credentials, InstalledAppFlow


def authenticate(settings: Settings) -> None:
    _request, _credentials, installed_app_flow = google_imports()
    if not settings.legacy_enabled or not settings.client_secrets_file or not settings.token_file:
        raise SyncError("The auth command is available only in legacy single-user mode")
    if not settings.client_secrets_file.exists():
        raise SyncError(f"Missing Google OAuth client file: {settings.client_secrets_file}")
    settings.token_file.parent.mkdir(parents=True, exist_ok=True)
    flow = installed_app_flow.from_client_secrets_file(
        str(settings.client_secrets_file), scopes=list(settings.scopes)
    )
    credentials = flow.run_local_server(host="127.0.0.1", port=8765, open_browser=False)
    settings.token_file.write_text(credentials.to_json(), encoding="utf-8")
    settings.token_file.chmod(0o600)
    print(f"Google OAuth token written to {settings.token_file}")


def credentials(settings: Settings) -> Any:
    request_type, credentials_type, _installed_app_flow = google_imports()
    if not settings.legacy_enabled or not settings.token_file:
        raise SyncError("Legacy credentials are not available in multi-user mode")
    if not settings.token_file.exists():
        raise SyncError("Missing Google token.json; run: python google_sync.py auth")
    creds = credentials_type.from_authorized_user_file(str(settings.token_file), list(settings.scopes))
    if creds.expired and creds.refresh_token:
        creds.refresh(request_type())
        settings.token_file.write_text(creds.to_json(), encoding="utf-8")
        settings.token_file.chmod(0o600)
    if not creds.valid:
        raise SyncError("Google OAuth token is invalid; run auth again")
    return creds


def google_services(settings: Settings) -> tuple[Any, Any]:
    try:
        # pyrefly: ignore [missing-import]
        from googleapiclient.discovery import build
    except ImportError as exc: 
        raise SyncError("google-api-python-client is missing; install requirements.txt") from exc
    creds = credentials(settings)
    return (
        build("calendar", "v3", credentials=creds, cache_discovery=False),
        build("tasks", "v1", credentials=creds, cache_discovery=False),
    )


@dataclass(frozen=True)
class OAuthConnection:
    user_id: str
    provider: str
    access_token: str | None
    refresh_token: str | None
    expires_at: str | None
    scopes: tuple[str, ...]


def list_active_connections(client: SupabaseRestClient) -> list[OAuthConnection]:
    rows = client.request(
        "GET",
        "user_oauth_connections",
        {
            "select": "user_id,provider,access_token,refresh_token,expires_at,scopes",
            "provider": "eq.google",
            "status": "eq.connected",
        },
    ) or []
    return [parse_connection(row) for row in rows]


def connection_timezone(client: SupabaseRestClient, user_id: str, fallback: str) -> str:
    rows = client.request(
        "GET", "profiles", {"select": "timezone", "user_id": f"eq.{user_id}", "limit": "1"}
    ) or []
    value = rows[0].get("timezone") if rows else None
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def client_for_user(settings: Settings, user_id: str, timezone_name: str) -> SupabaseRestClient:
    return SupabaseRestClient(
        BaseSettings(
            supabase_url=settings.base.supabase_url,
            service_role_key=settings.base.service_role_key,
            user_id=user_id,
            timezone_name=timezone_name,
        )
    )


def update_connection_status(
    client: SupabaseRestClient, connection: OAuthConnection, status: str
) -> None:
    client.request(
        "PATCH",
        "user_oauth_connections",
        {"user_id": f"eq.{connection.user_id}", "provider": "eq.google"},
        {"status": status},
    )


def update_connection_tokens(
    client: SupabaseRestClient,
    connection: OAuthConnection,
    access_token: str | None,
    refresh_token: str | None,
    expires_at: str | None,
    encryption_key: bytes,
) -> None:
    client.request(
        "PATCH",
        "user_oauth_connections",
        {"user_id": f"eq.{connection.user_id}", "provider": "eq.google"},
        {
            "access_token": encrypt_oauth_token(
                access_token, encryption_key, connection.user_id, "access_token"
            ),
            "refresh_token": encrypt_oauth_token(
                refresh_token, encryption_key, connection.user_id, "refresh_token"
            ),
            "expires_at": expires_at,
            "status": "connected",
        },
    )


def parse_connection(row: dict[str, Any]) -> OAuthConnection:
    user_id = row.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        raise SyncError("OAuth connection has no user_id")
    if row.get("provider") != "google":
        raise SyncError("Unexpected OAuth provider")
    scopes = row.get("scopes")
    return OAuthConnection(
        user_id=user_id,
        provider="google",
        access_token=row.get("access_token") if isinstance(row.get("access_token"), str) else None,
        refresh_token=row.get("refresh_token") if isinstance(row.get("refresh_token"), str) else None,
        expires_at=row.get("expires_at") if isinstance(row.get("expires_at"), str) else None,
        scopes=tuple(scope for scope in (scopes or []) if isinstance(scope, str)),
    )


def connection_is_expired(expires_at: str | None) -> bool:
    if not expires_at:
        return False
    try:
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires <= datetime.now(timezone.utc) + timedelta(seconds=60)
    except ValueError:
        return True


def connection_expiry(expires_at: str | None) -> datetime | None:
    if not expires_at:
        return None
    try:
        value = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def google_services_for_connection(
    settings: Settings,
    connection: OAuthConnection,
    client: SupabaseRestClient,
) -> tuple[Any, Any]:
    if not settings.token_encryption_key or not settings.oauth_client_id or not settings.oauth_client_secret:
        raise SyncError("Multi-user Google OAuth worker is not configured")
    request_type, credentials_type, _installed_app_flow = google_imports()
    access_token = decrypt_oauth_token(
        connection.access_token, settings.token_encryption_key, connection.user_id, "access_token"
    )
    refresh_token = decrypt_oauth_token(
        connection.refresh_token, settings.token_encryption_key, connection.user_id, "refresh_token"
    )
    if not access_token and not refresh_token:
        raise SyncError("Google OAuth connection has no usable token; reconnect Google")
    creds = credentials_type(
        token=access_token,
        refresh_token=refresh_token,
        token_uri=OAUTH_TOKEN_URL,
        client_id=settings.oauth_client_id,
        client_secret=settings.oauth_client_secret,
        scopes=list(connection.scopes or settings.scopes),
        expiry=connection_expiry(connection.expires_at),
    )
    if connection_is_expired(connection.expires_at):
        if not refresh_token:
            raise SyncError("Google OAuth token expired without a refresh token; reconnect Google")
        creds.refresh(request_type())
        update_connection_tokens(
            client,
            connection,
            access_token=creds.token,
            refresh_token=creds.refresh_token or refresh_token,
            expires_at=iso_utc(creds.expiry),
            encryption_key=settings.token_encryption_key,
        )
    if not creds.valid:
        raise SyncError("Google OAuth token is invalid; reconnect Google")
    try:
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise SyncError("google-api-python-client is missing; install requirements.txt") from exc
    return (
        build("calendar", "v3", credentials=creds, cache_discovery=False),
        build("tasks", "v1", credentials=creds, cache_discovery=False),
    )


def google_datetime(value: dict[str, str] | None, timezone_name: str) -> str | None:
    value = value or {}
    if value.get("dateTime"):
        raw = value["dateTime"].replace("Z", "+00:00")
        parsed = datetime.fromisoformat(raw)
        return iso_utc(parsed)
    if value.get("date"):
        day = date.fromisoformat(value["date"])
        parsed = datetime.combine(day, datetime_time.min, timezone_for(timezone_name))
        return iso_utc(parsed)
    return None


def task_due_at(value: str | None, timezone_name: str) -> str | None:
    if not value:
        return None
    day = date.fromisoformat(value[:10])
    # Google Tasks due values are date-only in practice. LifeOS uses local 18:00
    # as the deadline anchor so same-day policy reminders remain useful.
    parsed = datetime.combine(day, datetime_time(18, 0), timezone_for(timezone_name))
    return iso_utc(parsed)


def fetch_calendar_events(service: Any, settings: Settings) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=settings.lookahead_days)
    result: list[dict[str, Any]] = []
    for calendar_id in settings.calendar_ids:
        page_token = None
        while True:
            response = service.events().list(
                calendarId=calendar_id,
                timeMin=iso_utc(now),
                timeMax=iso_utc(horizon),
                singleEvents=True,
                orderBy="startTime",
                showDeleted=True,
                pageToken=page_token,
            ).execute()
            for event in response.get("items", []):
                event["_lifeos_calendar_id"] = calendar_id
                result.append(event)
            page_token = response.get("nextPageToken")
            if not page_token:
                break
    return result


def fetch_tasks(service: Any, settings: Settings) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for tasklist_id in settings.tasklist_ids:
        page_token = None
        while True:
            response = service.tasks().list(
                tasklist=tasklist_id,
                showCompleted=True,
                showHidden=True,
                maxResults=100,
                pageToken=page_token,
            ).execute()
            for task in response.get("items", []):
                task["_lifeos_tasklist_id"] = tasklist_id
                result.append(task)
            page_token = response.get("nextPageToken")
            if not page_token:
                break
    return result


def normalize_calendar_event(event: dict[str, Any], timezone_name: str) -> dict[str, Any]:
    calendar_id = str(event.get("_lifeos_calendar_id") or "primary")
    starts_at = google_datetime(event.get("start"), timezone_name)
    return {
        "source_key": "google_calendar",
        "external_id": f"{calendar_id}:{event['id']}",
        "event_type": "event",
        "title": event.get("summary") or "Untitled calendar event",
        "description": event.get("description"),
        "location": event.get("location"),
        "starts_at": starts_at,
        "ends_at": google_datetime(event.get("end"), timezone_name),
        "due_at": None,
        "status": "cancelled" if event.get("status") == "cancelled" else "active",
        "source_url": event.get("htmlLink"),
        "external_updated_at": event.get("updated"),
        "checksum": event.get("etag") or stable_checksum(event),
        "raw_json": event,
    }


def normalize_task(task: dict[str, Any], timezone_name: str) -> dict[str, Any]:
    tasklist_id = str(task.get("_lifeos_tasklist_id") or "@default")
    due_at = task_due_at(task.get("due"), timezone_name)
    status = "done" if task.get("status") == "completed" else "active"
    return {
        "source_key": "google_tasks",
        "external_id": f"{tasklist_id}:{task['id']}",
        "event_type": "task",
        "title": task.get("title") or "Untitled Google task",
        "description": task.get("notes"),
        "location": None,
        "starts_at": None,
        "ends_at": None,
        "due_at": due_at,
        "status": status,
        "source_url": task.get("webViewLink"),
        "external_updated_at": task.get("updated"),
        "checksum": task.get("etag") or stable_checksum(task),
        "raw_json": {**task, "lifeos_date_only_due": bool(task.get("due"))},
    }


def sync_source(
    client: SupabaseRestClient,
    source_key: str,
    source_type: str,
    rows: list[dict[str, Any]],
    mode: str,
) -> SyncStats:
    source = client.ensure_source(source_key, source_type, SOURCE_LABELS[source_key])
    run_id = client.start_sync_run(source)
    stats = SyncStats(seen=len(rows))
    try:
        seen: set[str] = set()
        for row in rows:
            seen.add(str(row["external_id"]))
            event, created, reminder_stats = client.upsert_event(row, mode)
            stats.created += int(created)
            stats.updated += int(not created)
            stats.reminders_created += reminder_stats.created
            stats.reminders_updated += reminder_stats.updated
            stats.reminders_cancelled += reminder_stats.cancelled
            if event.get("status") in {"done", "cancelled"}:
                stats.reminders_cancelled += client.cancel_future_reminders(str(event["id"]))
        stats.missing = client.mark_missing(source_key, seen)
        client.finish_sync_run(run_id, "success", stats)
        logging.info(
            "%s seen=%d created=%d updated=%d missing=%d reminders_created=%d reminders_updated=%d reminders_cancelled=%d",
            "tasks" if source_key == "google_tasks" else "events",
            stats.seen,
            stats.created,
            stats.updated,
            stats.missing,
            stats.reminders_created,
            stats.reminders_updated,
            stats.reminders_cancelled,
        )
        return stats
    except Exception as exc:
        client.finish_sync_run(
            run_id, "failed", stats, safe_google_error_message(exc, "Google API sync failed")
        )
        client.set_source_status(source_key, "error")
        raise


def sync_remote_source(
    client: SupabaseRestClient,
    source_key: str,
    source_type: str,
    fetch: Any,
    normalize: Any,
    mode: str,
) -> SyncStats:
    """Record a run before network I/O so API failures reach Sources UI."""
    source = client.ensure_source(source_key, source_type, SOURCE_LABELS[source_key])
    run_id = client.start_sync_run(source)
    stats = SyncStats()
    try:
        rows = [normalize(item) for item in fetch() if item.get("id")]
        stats.seen = len(rows)
        seen: set[str] = set()
        for row in rows:
            seen.add(str(row["external_id"]))
            event, created, reminder_stats = client.upsert_event(row, mode)
            stats.created += int(created)
            stats.updated += int(not created)
            stats.reminders_created += reminder_stats.created
            stats.reminders_updated += reminder_stats.updated
            stats.reminders_cancelled += reminder_stats.cancelled
            if event.get("status") in {"done", "cancelled"}:
                stats.reminders_cancelled += client.cancel_future_reminders(str(event["id"]))
        stats.missing = client.mark_missing(source_key, seen)
        client.finish_sync_run(run_id, "success", stats)
        return stats
    except Exception as exc:
        client.finish_sync_run(
            run_id, "failed", stats, safe_google_error_message(exc, "Google API sync failed")
        )
        client.set_source_status(source_key, "error")
        raise


def record_connection_failure(client: SupabaseRestClient, message: str) -> None:
    for source_key in ("google_calendar", "google_tasks"):
        source = client.ensure_source(source_key, "google", SOURCE_LABELS[source_key])
        run_id = client.start_sync_run(source)
        client.finish_sync_run(run_id, "failed", SyncStats(), message)
        client.set_source_status(source_key, "error")


def add_stats(target: SyncStats, value: SyncStats) -> None:
    target.seen += value.seen
    target.created += value.created
    target.updated += value.updated
    target.missing += value.missing
    target.reminders_created += value.reminders_created
    target.reminders_updated += value.reminders_updated
    target.reminders_cancelled += value.reminders_cancelled


def safe_google_error_message(error: Exception, context: str) -> str:
    """Keep credentials and provider response bodies out of logs and sync_runs."""
    message = str(error).lower()
    if "invalid_grant" in message:
        return "Google OAuth authorization was revoked; reconnect Google"
    if "expired without a refresh token" in message:
        return "Google OAuth token expired; reconnect Google"
    return context


def sync_user_connection(settings: Settings, connection: OAuthConnection) -> dict[str, SyncStats]:
    directory_client = SupabaseRestClient(settings.base)
    timezone_name = connection_timezone(
        directory_client, connection.user_id, settings.base.timezone_name
    )
    client = client_for_user(settings, connection.user_id, timezone_name)
    try:
        calendar_service, tasks_service = google_services_for_connection(settings, connection, client)
    except Exception as exc:
        lowered = str(exc).lower()
        status = (
            "revoked"
            if "invalid_grant" in lowered
            else "expired"
            if "expired without a refresh token" in lowered
            else "error"
        )
        message = safe_google_error_message(exc, "Google OAuth authentication failed")
        update_connection_status(client, connection, status)
        record_connection_failure(client, message)
        logging.warning("google_sync connection authentication failed; marked status=%s", status)
        return {}

    mode = client.get_reminder_mode()
    results: dict[str, SyncStats] = {}
    for source_key, service, fetch, normalize in (
        (
            "google_calendar",
            calendar_service,
            fetch_calendar_events,
            lambda item: normalize_calendar_event(item, timezone_name),
        ),
        (
            "google_tasks",
            tasks_service,
            fetch_tasks,
            lambda item: normalize_task(item, timezone_name),
        ),
    ):
        try:
            results[source_key] = sync_remote_source(
                client,
                source_key,
                "google",
                lambda service=service, fetch=fetch: fetch(service, settings),
                normalize,
                mode,
            )
        except Exception as exc:  # A calendar failure must not suppress task sync.
            logging.warning("google_sync source=%s failed", source_key)
    return results


def sync_once_multi_user(settings: Settings) -> dict[str, SyncStats]:
    directory_client = SupabaseRestClient(settings.base)
    totals = {"google_calendar": SyncStats(), "google_tasks": SyncStats()}
    for connection in list_active_connections(directory_client):
        for source_key, stats in sync_user_connection(settings, connection).items():
            add_stats(totals[source_key], stats)
    return totals


def sync_once_legacy(settings: Settings) -> dict[str, SyncStats]:
    calendar_service, tasks_service = google_services(settings)
    client = SupabaseRestClient(settings.base)
    mode = client.get_reminder_mode()
    calendars = [
        normalize_calendar_event(item, settings.base.timezone_name)
        for item in fetch_calendar_events(calendar_service, settings)
        if item.get("id")
    ]
    tasks = [
        normalize_task(item, settings.base.timezone_name)
        for item in fetch_tasks(tasks_service, settings)
        if item.get("id")
    ]
    return {
        "google_calendar": sync_source(client, "google_calendar", "google", calendars, mode),
        "google_tasks": sync_source(client, "google_tasks", "google", tasks, mode),
    }


def sync_once(settings: Settings) -> dict[str, SyncStats]:
    return sync_once_legacy(settings) if settings.legacy_enabled else sync_once_multi_user(settings)


def status(settings: Settings) -> None:
    print("Google sync status")
    if settings.legacy_enabled:
        assert settings.client_secrets_file and settings.token_file
        print(f"Mode: legacy single-user")
        print(f"OAuth client: {'present' if settings.client_secrets_file.exists() else 'missing'}")
        print(f"OAuth token: {'present' if settings.token_file.exists() else 'missing'}")
        client = SupabaseRestClient(settings.base)
        for row in client.source_status(["google_calendar", "google_tasks"]):
            print(f"{row['source_key']}: {row['status']} last_sync={row.get('last_sync_at') or 'never'}")
        return
    connections = list_active_connections(SupabaseRestClient(settings.base))
    print("Mode: multi-user OAuth connections")
    print(f"Active Google connections: {len(connections)}")
    print("Run sync-once and inspect each user's TMA Sources screen for source status.")


def run_loop(settings: Settings) -> None:
    while True:
        try:
            results = sync_once(settings)
            logging.info("google_sync complete stats=%s", results)
        except Exception as exc:  # noqa: BLE001
            logging.exception("google_sync iteration failed: %s", exc)
        time.sleep(settings.poll_seconds)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LifeOS Google Calendar/Tasks sync")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("command", choices=("auth", "status", "sync-once", "run-loop"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        settings = load_settings(args.env_file)
        if args.command == "auth":
            authenticate(settings)
        elif args.command == "status":
            status(settings)
        elif args.command == "sync-once":
            print(json.dumps({key: vars(value) for key, value in sync_once(settings).items()}, indent=2))
        else:
            run_loop(settings)
        return 0
    except (SyncError, OSError, ValueError) as exc:
        logging.error("%s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
