from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("platonus_sync.py")
SPEC = importlib.util.spec_from_file_location("platonus_sync", MODULE_PATH)
assert SPEC and SPEC.loader
platonus_sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = platonus_sync
SPEC.loader.exec_module(platonus_sync)


class PlatonusSyncLegacyGuardTest(unittest.TestCase):
    def test_load_settings_requires_legacy_single_user_opt_in(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role",
                "LIFEOS_DEFAULT_USER_ID": "user-1",
                "PLATONUS_USERNAME": "testuser",
                "PLATONUS_PASSWORD": "testpassword",
            },
            clear=True,
        ), patch.object(platonus_sync, "load_dotenv", lambda _path: None):
            with self.assertRaises(platonus_sync.SyncError) as context:
                platonus_sync.load_settings()

        self.assertIn(
            "LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC",
            str(context.exception),
        )

    def test_mock_fallback_on_auth_failure(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role",
                "LIFEOS_DEFAULT_USER_ID": "user-1",
                "LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC": "true",
                "PLATONUS_USERNAME": "testuser",
                "PLATONUS_PASSWORD": "testpassword",
                "PLATONUS_SYNC_MOCK_MODE": "true",
            },
            clear=True,
        ), patch.object(platonus_sync, "load_dotenv", lambda _path: None):
            settings = platonus_sync.load_settings()
            client = platonus_sync.PlatonusClient(settings)

            # Simulate network failure or dynamic security blocking on login
            with patch.object(client, "_request", side_effect=OSError("Blocked")):
                client.authenticate()
                self.assertTrue(client.is_mocked)
                grades = client.fetch_grades()
                self.assertTrue(len(grades) > 0)
                self.assertEqual(grades[0]["course_title"], "Crop Production")

    def test_refuses_mock_fallback_without_explicit_opt_in(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role",
                "LIFEOS_DEFAULT_USER_ID": "user-1",
                "LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC": "true",
                "PLATONUS_USERNAME": "testuser",
                "PLATONUS_PASSWORD": "testpassword",
            },
            clear=True,
        ), patch.object(platonus_sync, "load_dotenv", lambda _path: None):
            settings = platonus_sync.load_settings()
            client = platonus_sync.PlatonusClient(settings)

            with patch.object(client, "_request", side_effect=OSError("Blocked")):
                with self.assertRaises(platonus_sync.SyncError) as ctx:
                    client.authenticate()

            self.assertIn("sign-in failed", str(ctx.exception))
            self.assertFalse(client.is_mocked)

    def test_login_and_gradebook_use_same_cookie_session(self) -> None:
        seen: list[tuple[str, str]] = []

        class PortalHandler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                pass

            def do_GET(self) -> None:
                if self.path == "/index":
                    seen.append(("index", self.headers.get("Cookie", "")))
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Set-Cookie", "pre=sample; Path=/")
                    self.end_headers()
                    self.wfile.write(b"<html>login</html>")
                    return
                if self.path == "/current_progress_gradebook_student":
                    seen.append(("gradebook", self.headers.get("Cookie", "")))
                    self.send_response(200 if "auth=sample" in self.headers.get("Cookie", "") else 401)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write((
                        '<select name="year"><option value="2026" selected>2026</option></select>'
                        '<select name="term"><option value="1" selected>1</option></select>'
                        '<table><tr><td>Дисциплина</td><td>Учебный поток</td>'
                        '<td>Преподаватель</td><td>1</td></tr><tr><td>Mathematics</td>'
                        '<td>Group A</td><td>Teacher A</td><td>90</td></tr></table>'
                    ).encode("utf-8"))
                    return
                self.send_error(404)

            def do_POST(self) -> None:
                if self.path != "/rest/api/login":
                    self.send_error(404)
                    return
                seen.append(("login", self.headers.get("Cookie", "")))
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if body != {
                    "login": "student", "iin": None, "icNumber": None,
                    "password": "synthetic-password",
                    "authForDeductedStudentsAndGraduates": "false",
                }:
                    self.send_error(400)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", "auth=sample; Path=/")
                self.end_headers()
                self.wfile.write(b'{"login_status":"success"}')

        server = ThreadingHTTPServer(("127.0.0.1", 0), PortalHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = platonus_sync.BaseSettings(
                supabase_url="https://example.supabase.co",
                service_role_key="service-role",
                user_id="user-1",
                timezone_name="Asia/Qyzylorda",
            )
            settings = platonus_sync.Settings(base, "student", "synthetic-password", 60, False)
            client = platonus_sync.PlatonusClient(settings)
            client.base_url = f"http://127.0.0.1:{server.server_port}"
            client.authenticate()
            grades = client.fetch_grades()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual([name for name, _ in seen], ["index", "login", "gradebook"])
        self.assertIn("pre=sample", seen[1][1])
        self.assertIn("auth=sample", seen[2][1])
        self.assertEqual(len(grades), 1)
        self.assertEqual(grades[0]["course_title"], "Mathematics")
        self.assertEqual(grades[0]["teacher"], "Teacher A")
        self.assertEqual(grades[0]["score"], 90)

    def test_additional_verification_fails_closed(self) -> None:
        base = platonus_sync.BaseSettings(
            supabase_url="https://example.supabase.co",
            service_role_key="service-role",
            user_id="user-1",
            timezone_name="Asia/Qyzylorda",
        )
        settings = platonus_sync.Settings(base, "student", "synthetic-password", 60, False)
        client = platonus_sync.PlatonusClient(settings)
        with patch.object(client, "_request", side_effect=["<html></html>", {"login_status": "verify"}]) as request:
            with self.assertRaises(platonus_sync.SyncError):
                client.authenticate()
        self.assertEqual(request.call_count, 2)

    def test_login_page_is_not_treated_as_gradebook(self) -> None:
        base = platonus_sync.BaseSettings(
            supabase_url="https://example.supabase.co",
            service_role_key="service-role",
            user_id="user-1",
            timezone_name="Asia/Qyzylorda",
        )
        settings = platonus_sync.Settings(base, "student", "synthetic-password", 60, False)
        client = platonus_sync.PlatonusClient(settings)
        with patch.object(client, "_request", return_value="<html><body>Sign in</body></html>"):
            with self.assertRaises(platonus_sync.SyncError):
                client.fetch_grades()
        self.assertFalse(client.is_mocked)

    def test_diagnose_does_not_require_supabase_or_print_credentials(self) -> None:
        self.assertNotIn(
            "synthetic-password",
            repr(platonus_sync.DiagnosticSettings("student", "synthetic-password")),
        )
        output = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), redirect_stdout(output):
            code = platonus_sync.main(["diagnose"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue()), {
            "http_status": None,
            "url": None,
            "redirect": None,
            "reason": "missing_credentials",
        })

    def test_diagnostic_failure_contains_only_safe_status_url_redirect_reason(self) -> None:
        class RejectHandler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                pass

            def do_GET(self) -> None:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"<html>login</html>")

            def do_POST(self) -> None:
                self.send_response(401)
                self.send_header("Location", "/index?sid=SYNTHETIC_SECRET_123456")
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), RejectHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = platonus_sync.PlatonusClient(
                platonus_sync.DiagnosticSettings("student", "SYNTHETIC_SECRET_123456")
            )
            client.base_url = f"http://127.0.0.1:{server.server_port}"
            ok, result = platonus_sync.diagnostic_result(client)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertFalse(ok)
        self.assertEqual(set(result), {"http_status", "url", "redirect", "reason"})
        self.assertEqual(result["http_status"], 401, result)
        self.assertEqual(result["url"], f"http://127.0.0.1:{server.server_port}/rest/api/login")
        self.assertEqual(result["redirect"], f"http://127.0.0.1:{server.server_port}/index?sid=%5BREMOVED%5D")
        self.assertEqual(result["reason"], "http_error")
        self.assertNotIn("SYNTHETIC_SECRET_123456", json.dumps(result))

    def test_diagnostic_reports_verification_without_response_values(self) -> None:
        client = platonus_sync.PlatonusClient(
            platonus_sync.DiagnosticSettings("student", "synthetic-password")
        )
        with patch.object(client, "_request", side_effect=[
            "<html></html>",
            {"login_status": "verify", "challengeId": "SYNTHETIC_SECRET_123456"},
        ]):
            ok, result = platonus_sync.diagnostic_result(client)
        self.assertFalse(ok)
        self.assertEqual(result, {
            "http_status": None,
            "url": None,
            "redirect": None,
            "reason": "verification_required",
        })

    def test_diagnostic_success_reports_counts_without_grade_details(self) -> None:
        client = platonus_sync.PlatonusClient(
            platonus_sync.DiagnosticSettings("student", "synthetic-password")
        )
        with patch.object(client, "authenticate"), patch.object(
            client, "fetch_grades", return_value=[{
                "course_id": "course-1", "course_title": "PRIVATE COURSE",
                "teacher": "PRIVATE TEACHER", "score": 90,
            }]
        ):
            ok, result = platonus_sync.diagnostic_result(client)
        self.assertTrue(ok)
        self.assertEqual(result["grade_count"], 1)
        self.assertEqual(result["course_count"], 1)
        self.assertNotIn("PRIVATE", json.dumps(result))


class GradeNotificationClient:
    def __init__(self) -> None:
        self.settings = platonus_sync.BaseSettings(
            supabase_url="https://example.supabase.co",
            service_role_key="service-role",
            user_id="user-1",
            timezone_name="Asia/Qyzylorda",
        )
        self.academic_records: dict[str, dict] = {}
        self.reminders: dict[str, dict] = {}

    def upsert_event(
        self, event: dict, _mode: str, *, sync_reminders: bool = True
    ) -> tuple[dict, bool, object]:
        assert not sync_reminders, "Platonus grades must bypass generic reminders"
        synced = {"id": event["external_id"], "normalized_entity_id": None}
        return synced, False, SimpleNamespace(created=0, updated=0, cancelled=0)

    def request(
        self,
        method: str,
        table: str,
        query: dict | None = None,
        body: dict | None = None,
    ) -> list[dict]:
        query = query or {}
        if table == "academic_records":
            event_id = str(query.get("source_event_id", ""))[3:]
            if method == "GET":
                row = self.academic_records.get(event_id)
                return [row.copy()] if row else []
            assert body is not None
            key = str(body["source_event_id"])
            self.academic_records[key] = {"id": key, **body}
            return []
        if table == "reminders":
            key = str(query.get("dedup_key", ""))[3:]
            if method == "GET":
                row = self.reminders.get(key)
                return [row.copy()] if row else []
            assert method == "POST" and body is not None
            self.reminders[str(body["dedup_key"])] = body.copy()
            return []
        raise AssertionError(f"Unexpected request: {method} {table}")

    def mark_missing(self, _source_key: str, _seen_ids: set[str]) -> int:
        return 0

    def finish_sync_run(self, _run_id: str, _status: str, _stats: object, _error: str | None = None) -> None:
        return None


class PlatonusGradeNotificationTest(unittest.TestCase):
    def test_baseline_then_new_and_changed_grades_are_queued_once(self) -> None:
        db = GradeNotificationClient()
        settings = platonus_sync.Settings(db.settings, "student", "unused", 60, False)
        grade = {
            "course_id": "course-1",
            "course_title": "Mathematics",
            "assessment_id": "work-1",
            "title": "Quiz",
            "record_type": "quiz",
            "score": 8,
            "max_score": 10,
            "teacher": "A. Teacher",
        }

        platonus_sync.sync_grades(db, settings, [grade], "normal", run_id="run-1")
        self.assertEqual(len(db.reminders), 0)

        platonus_sync.sync_grades(db, settings, [grade], "normal", run_id="run-2", notify_changes=True)
        self.assertEqual(len(db.reminders), 0)

        changed = {**grade, "score": 9}
        platonus_sync.sync_grades(db, settings, [changed], "normal", run_id="run-3", notify_changes=True)
        self.assertEqual(len(db.reminders), 1)
        reminder = next(iter(db.reminders.values()))
        self.assertIsNone(reminder["source_event_id"])
        self.assertEqual(reminder["metadata_json"]["teacher"], "A. Teacher")
        self.assertEqual(reminder["metadata_json"]["change_kind"], "updated")
        self.assertEqual(reminder["metadata_json"]["score"], "9")

        platonus_sync.sync_grades(db, settings, [changed], "normal", run_id="run-4", notify_changes=True)
        self.assertEqual(len(db.reminders), 1)

        new_grade = {**grade, "assessment_id": "work-2", "score": 7}
        platonus_sync.sync_grades(db, settings, [changed, new_grade], "normal", run_id="run-5", notify_changes=True)
        self.assertEqual(len(db.reminders), 2)

    def test_incomplete_grade_does_not_create_zero_score(self) -> None:
        db = GradeNotificationClient()
        settings = platonus_sync.Settings(db.settings, "student", "unused", 60, False)

        with self.assertRaises(platonus_sync.SyncError):
            platonus_sync.sync_grades(
                db,
                settings,
                [{"course_id": "course-1", "assessment_id": "work-1", "course_title": "Math"}],
                "normal",
                run_id="run-1",
                notify_changes=True,
            )
        self.assertEqual(db.reminders, {})

    def test_dry_run_compares_saved_grade_and_never_writes(self) -> None:
        class ReadOnlyDatabase:
            settings = SimpleNamespace(user_id="user-1")
            baseline = True
            saved_score: float | None = 8
            queued = False

            def request(self, method: str, table: str, query: dict | None = None) -> list[dict]:
                assert method == "GET", "dry-run must never write"
                assert query and query.get("user_id") == "eq.user-1"
                if table == "sync_runs":
                    return [{"id": "run-1"}] if self.baseline else []
                if table == "source_events":
                    return [{"id": "event-1"}] if self.saved_score is not None else []
                if table == "academic_records":
                    return [{"score": self.saved_score, "max_score": 10}]
                if table == "reminders":
                    return [{"id": "reminder-1"}] if self.queued else []
                raise AssertionError(table)

        db = ReadOnlyDatabase()
        grade = {
            "course_id": "math", "assessment_id": "week-1",
            "course_title": "Mathematics", "title": "Неделя 1",
            "score": 9, "max_score": 10, "teacher": "Teacher A",
        }
        changed = platonus_sync.preview_grade_notifications(db, [grade])
        self.assertEqual(changed["status"], "compared")
        self.assertEqual(changed["unchanged"], 0)
        self.assertEqual(len(changed["would_send"]), 1)
        self.assertIn("Оценка изменена", changed["would_send"][0])
        self.assertIn("Mathematics", changed["would_send"][0])
        self.assertIn("Teacher A", changed["would_send"][0])

        db.saved_score = 9
        unchanged = platonus_sync.preview_grade_notifications(db, [grade])
        self.assertEqual(unchanged["unchanged"], 1)
        self.assertEqual(unchanged["would_send"], [])
        self.assertIn("Оценка:", unchanged["example_message_preview_only"])

        db.saved_score = 8
        db.queued = True
        deduplicated = platonus_sync.preview_grade_notifications(db, [grade])
        self.assertEqual(deduplicated["already_queued"], 1)
        self.assertEqual(deduplicated["would_send"], [])

        db.baseline = False
        first_run = platonus_sync.preview_grade_notifications(db, [grade])
        self.assertEqual(first_run["status"], "baseline_not_established")
        self.assertEqual(first_run["would_send"], [])
        self.assertIn("Новая оценка", first_run["example_message_preview_only"])

    def test_dry_run_once_fetches_and_compares_without_sync_writes(self) -> None:
        base = platonus_sync.BaseSettings(
            supabase_url="https://example.supabase.co",
            service_role_key="service-role",
            user_id="user-1",
            timezone_name="Asia/Qyzylorda",
        )
        settings = platonus_sync.Settings(base, "student", "synthetic-password", 900, False)
        grade = {
            "course_id": "math", "assessment_id": "week-1",
            "course_title": "Mathematics", "title": "Неделя 1",
            "score": 9, "max_score": None, "teacher": "Teacher A",
        }
        portal = SimpleNamespace(is_mocked=False)
        portal.authenticate = lambda: None
        portal.fetch_grades = lambda: [grade]

        class ReadOnlyDatabase:
            settings = SimpleNamespace(user_id="user-1")

            def request(self, method: str, table: str, query: dict | None = None) -> list[dict]:
                assert method == "GET"
                assert table == "sync_runs"
                assert query and query.get("user_id") == "eq.user-1"
                return []

        with patch.object(platonus_sync, "PlatonusClient", return_value=portal), patch.object(
            platonus_sync, "SupabaseRestClient", return_value=ReadOnlyDatabase()
        ):
            result = platonus_sync.dry_run_once(settings)
        self.assertEqual(result["grades_seen"], 1)
        self.assertEqual(result["status"], "baseline_not_established")
        self.assertEqual(result["would_send"], [])

    def test_baseline_writes_expected_live_grades_without_notifications(self) -> None:
        base = platonus_sync.BaseSettings(
            supabase_url="https://example.supabase.co",
            service_role_key="service-role",
            user_id="user-1",
            timezone_name="Asia/Qyzylorda",
        )
        settings = platonus_sync.Settings(base, "student", "synthetic-password", 900, False)
        grade = {
            "course_id": "math", "assessment_id": "week-1",
            "course_title": "Mathematics", "score": 9,
        }
        portal = SimpleNamespace(is_mocked=False)
        portal.authenticate = lambda: None
        portal.fetch_grades = lambda: [grade]

        class BaselineDatabase:
            settings = base
            writes = 0
            prior_success = False

            def request(self, method: str, table: str, query: dict | None = None) -> list[dict]:
                assert method == "GET"
                assert query and query.get("user_id") == "eq.user-1"
                if table == "sync_runs":
                    return [{"id": "old-run"}] if self.prior_success else []
                if table in {"source_events", "reminders"}:
                    return []
                raise AssertionError(table)

            def get_reminder_mode(self) -> str:
                return "normal"

            def ensure_source(self, *_args: str) -> dict:
                self.writes += 1
                return {"id": "source-1"}

            def start_sync_run(self, _source: dict) -> str:
                self.writes += 1
                return "run-1"

        db = BaselineDatabase()
        stats = platonus_sync.SyncStats(seen=1)
        comparison = {"status": "compared", "unchanged": 1, "would_send": []}
        with patch.object(platonus_sync, "PlatonusClient", return_value=portal), patch.object(
            platonus_sync, "SupabaseRestClient", return_value=db
        ), patch.object(platonus_sync, "sync_grades", return_value=stats) as sync, patch.object(
            platonus_sync, "preview_grade_notifications", return_value=comparison
        ):
            result = platonus_sync.establish_baseline_once(settings, 1)
            self.assertEqual(result["notifications_queued"], 0)
            self.assertEqual(result["unchanged_after_save"], 1)
            self.assertFalse(sync.call_args.kwargs["notify_changes"])
            self.assertEqual(db.writes, 2)

            db.writes = 0
            db.prior_success = True
            with self.assertRaises(platonus_sync.SyncError):
                platonus_sync.establish_baseline_once(settings, 1)
            self.assertEqual(db.writes, 0)

            db.prior_success = False
            with self.assertRaises(platonus_sync.SyncError):
                platonus_sync.establish_baseline_once(settings, 2)
            self.assertEqual(db.writes, 0)


if __name__ == "__main__":
    unittest.main()
