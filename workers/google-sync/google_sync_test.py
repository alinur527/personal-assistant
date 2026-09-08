from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).with_name("google_sync.py")
SPEC = importlib.util.spec_from_file_location("google_sync", MODULE_PATH)
assert SPEC and SPEC.loader
google_sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = google_sync
SPEC.loader.exec_module(google_sync)


class GoogleSyncMultiUserTest(unittest.TestCase):
    def test_load_settings_uses_multi_user_connections_without_default_user(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role",
                "GOOGLE_OAUTH_CLIENT_ID": "google-client-id",
                "GOOGLE_OAUTH_CLIENT_SECRET": "google-client-secret",
                "LIFEOS_OAUTH_TOKEN_ENCRYPTION_KEY": "x" * 32,
            },
            clear=True,
        ), patch.object(google_sync, "load_dotenv", lambda _path: None):
            settings = google_sync.load_settings()

        self.assertFalse(settings.legacy_enabled)
        self.assertEqual(settings.base.user_id, "")
        self.assertIsNone(settings.token_file)

    def test_legacy_mode_still_requires_explicit_local_configuration(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role",
                "LIFEOS_DEFAULT_USER_ID": "legacy-user-id",
                "LIFEOS_ENABLE_LEGACY_SINGLE_USER_GOOGLE_SYNC": "true",
            },
            clear=True,
        ), patch.object(google_sync, "load_dotenv", lambda _path: None):
            with self.assertRaises(google_sync.SyncError) as context:
                google_sync.load_settings()

        self.assertIn("GOOGLE_CLIENT_SECRETS_FILE", str(context.exception))

    def test_oauth_token_encryption_round_trip_is_bound_to_user_and_column(self) -> None:
        key = google_sync.parse_encryption_key("k" * 32)
        encrypted = google_sync.encrypt_oauth_token("access-token", key, "user-a", "access_token")

        self.assertTrue(encrypted.startswith("enc:v1:"))
        self.assertEqual(
            google_sync.decrypt_oauth_token(encrypted, key, "user-a", "access_token"),
            "access-token",
        )
        with self.assertRaises(google_sync.SyncError):
            google_sync.decrypt_oauth_token(encrypted, key, "user-b", "access_token")
        with self.assertRaises(google_sync.SyncError):
            google_sync.decrypt_oauth_token("plaintext-token", key, "user-a", "access_token")

    def test_expired_token_is_refreshed_and_encrypted_before_storage(self) -> None:
        key = google_sync.parse_encryption_key("k" * 32)
        connection = google_sync.OAuthConnection(
            user_id="user-a",
            provider="google",
            access_token=google_sync.encrypt_oauth_token("old-access", key, "user-a", "access_token"),
            refresh_token=google_sync.encrypt_oauth_token("refresh", key, "user-a", "refresh_token"),
            expires_at=(datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
            scopes=("scope",),
        )
        refreshed = Mock(token="new-access", refresh_token="refresh", expiry=datetime.now(timezone.utc) + timedelta(hours=1), valid=True)
        refreshed.refresh = Mock()
        credentials_type = Mock(return_value=refreshed)
        client = Mock()
        settings = Mock(
            token_encryption_key=key,
            oauth_client_id="client-id",
            oauth_client_secret="client-secret",
            scopes=("scope",),
        )

        with patch.object(google_sync, "google_imports", return_value=(Mock, credentials_type, Mock)), patch.dict(
            sys.modules,
            {"googleapiclient": Mock(), "googleapiclient.discovery": Mock(build=Mock())},
        ):
            with patch.object(google_sync, "update_connection_tokens") as update:
                google_sync.google_services_for_connection(settings, connection, client)

        refreshed.refresh.assert_called_once()
        update.assert_called_once()
        self.assertEqual(update.call_args.kwargs["access_token"], "new-access")

    def test_calendar_and_tasks_are_synced_for_the_connection_user(self) -> None:
        client = Mock()
        client.settings.user_id = "user-a"
        client.get_reminder_mode.return_value = "normal"
        calendar = Mock()
        tasks = Mock()
        settings = Mock(base=Mock(timezone_name="UTC"), lookahead_days=14, calendar_ids=("primary",), tasklist_ids=("@default",))
        connection = google_sync.OAuthConnection("user-a", "google", "x", "y", None, ())

        with patch.object(google_sync, "connection_timezone", return_value="UTC"), patch.object(
            google_sync, "client_for_user", return_value=client
        ), patch.object(google_sync, "google_services_for_connection", return_value=(calendar, tasks)), patch.object(
            google_sync, "fetch_calendar_events", return_value=[{"id": "event-1", "start": {"date": "2026-01-01"}}]
        ), patch.object(google_sync, "fetch_tasks", return_value=[{"id": "task-1", "title": "Task"}]), patch.object(
            google_sync, "sync_remote_source", side_effect=[google_sync.SyncStats(seen=1), google_sync.SyncStats(seen=1)]
        ) as sync_source:
            result = google_sync.sync_user_connection(settings, connection)

        self.assertEqual(set(result), {"google_calendar", "google_tasks"})
        self.assertEqual(client.settings.user_id, "user-a")
        self.assertEqual([call.args[1] for call in sync_source.call_args_list], ["google_calendar", "google_tasks"])

    def test_calendar_and_tasks_fetch_and_normalize_real_api_shapes(self) -> None:
        class Request:
            def __init__(self, response: dict[str, object]) -> None:
                self.response = response

            def execute(self) -> dict[str, object]:
                return self.response

        calendar_service = Mock()
        calendar_service.events.return_value.list.return_value = Request(
            {"items": [{"id": "event-1", "summary": "Lecture", "start": {"date": "2026-01-01"}, "end": {"date": "2026-01-02"}}]}
        )
        tasks_service = Mock()
        tasks_service.tasks.return_value.list.return_value = Request(
            {"items": [{"id": "task-1", "title": "Submit", "due": "2026-01-02T00:00:00.000Z", "status": "needsAction"}]}
        )
        settings = Mock(lookahead_days=14, calendar_ids=("primary",), tasklist_ids=("@default",))

        calendar_rows = google_sync.fetch_calendar_events(calendar_service, settings)
        task_rows = google_sync.fetch_tasks(tasks_service, settings)
        calendar_event = google_sync.normalize_calendar_event(calendar_rows[0], "UTC")
        task_event = google_sync.normalize_task(task_rows[0], "UTC")

        self.assertEqual(calendar_event["external_id"], "primary:event-1")
        self.assertEqual(calendar_event["source_key"], "google_calendar")
        self.assertEqual(task_event["external_id"], "@default:task-1")
        self.assertEqual(task_event["source_key"], "google_tasks")
        self.assertEqual(task_event["event_type"], "task")

    def test_active_connections_and_source_requests_remain_user_scoped(self) -> None:
        directory = Mock()
        directory.request.return_value = [
            {"user_id": "user-a", "provider": "google", "access_token": "enc:v1:x:y:z", "refresh_token": None, "expires_at": None, "scopes": []},
            {"user_id": "user-b", "provider": "google", "access_token": "enc:v1:x:y:z", "refresh_token": None, "expires_at": None, "scopes": []},
        ]

        connections = google_sync.list_active_connections(directory)

        self.assertEqual([connection.user_id for connection in connections], ["user-a", "user-b"])
        self.assertEqual(directory.request.call_args.args[1], "user_oauth_connections")
        self.assertEqual(directory.request.call_args.args[2]["status"], "eq.connected")

    def test_connection_failure_records_error_runs_for_both_google_sources(self) -> None:
        client = Mock()
        client.ensure_source.side_effect = [
            {"id": "calendar-source", "source_key": "google_calendar"},
            {"id": "tasks-source", "source_key": "google_tasks"},
        ]
        client.start_sync_run.side_effect = ["calendar-run", "tasks-run"]

        google_sync.record_connection_failure(client, "Google OAuth token is invalid")

        self.assertEqual(client.ensure_source.call_count, 2)
        self.assertEqual(client.finish_sync_run.call_count, 2)
        self.assertEqual(client.set_source_status.call_count, 2)
        self.assertTrue(
            all(call.args[1] == "failed" for call in client.finish_sync_run.call_args_list)
        )


if __name__ == "__main__":
    unittest.main()
