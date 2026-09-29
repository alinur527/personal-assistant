#!/usr/bin/env python3
"""Sync university grades and marks from Platonus into LifeOS."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import logging
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Resolve the workers/ directory path for imports
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "reminder-worker"))

from gradebook_html import GradebookParseError, parse_gradebook_html  # noqa: E402
from reminder_worker import format_telegram_message  # noqa: E402
from sanitize_har import clean_url  # noqa: E402

from common.lifeos_sync import (  # noqa: E402
    BaseSettings,
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
    utc_now,
)

MOCK_COURSES = [
    {
        "course_id": "crop_prod",
        "course_title": "Crop Production",
        "assessments": [
            {"assessment_id": "assign_1", "title": "Lab 1: Seed Quality", "record_type": "assignment", "score": 8.5, "max_score": 10.0},
            {"assessment_id": "assign_2", "title": "Homework 2: Yield Estimation", "record_type": "assignment", "score": 9.0, "max_score": 10.0},
            {"assessment_id": "midterm", "title": "Midterm Examination", "record_type": "midterm", "score": 18.0, "max_score": 20.0},
            {"assessment_id": "final", "title": "Final Examination", "record_type": "final", "score": 52.0, "max_score": 60.0},
        ]
    },
    {
        "course_id": "agri_mach",
        "course_title": "Agricultural Machinery",
        "assessments": [
            {"assessment_id": "assign_1", "title": "Project: Tractor Design", "record_type": "assignment", "score": 9.5, "max_score": 10.0},
            {"assessment_id": "midterm", "title": "Midterm Exam", "record_type": "midterm", "score": 17.5, "max_score": 20.0},
            {"assessment_id": "final", "title": "Final Examination", "record_type": "final", "score": 54.0, "max_score": 60.0},
        ]
    },
    {
        "course_id": "soil_sci",
        "course_title": "Soil Science",
        "assessments": [
            {"assessment_id": "assign_1", "title": "Lab: Soil pH measurement", "record_type": "assignment", "score": 7.0, "max_score": 10.0},
            {"assessment_id": "midterm", "title": "Midterm Test", "record_type": "midterm", "score": 15.0, "max_score": 20.0},
            {"assessment_id": "final", "title": "Final Examination", "record_type": "final", "score": 48.0, "max_score": 60.0},
        ]
    }
]


@dataclass(frozen=True)
class Settings:
    base: BaseSettings
    username: str
    password: str = field(repr=False)
    poll_seconds: int
    allow_mock: bool  # Explicit opt-in for mock fallback (never automatic)


@dataclass(frozen=True)
class DiagnosticSettings:
    username: str
    password: str = field(repr=False)
    allow_mock: bool = False


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(Path(__file__).with_name(".env"))
    if env_file:
        load_dotenv(env_file)
    return Settings(
        base=load_base_settings(
            legacy_guard_env="LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC",
            worker_name="Platonus sync",
        ),
        username=getenv_required("PLATONUS_USERNAME"),
        password=getenv_required("PLATONUS_PASSWORD"),
        poll_seconds=getenv_int("PLATONUS_SYNC_POLL_SECONDS", 3600),
        allow_mock=getenv_bool("PLATONUS_SYNC_MOCK_MODE", False),
    )


class PlatonusClient:
    """Sign in and read the current-progress HTML journal with one cookie jar."""

    def __init__(self, settings: Settings | DiagnosticSettings):
        self.username = settings.username
        self.password = settings.password
        self.base_url = "https://platonus.kazatu.kz"
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self.is_mocked = False
        self._allow_mock = settings.allow_mock
        self.request_diagnostics: list[dict[str, Any]] = []
        self.failure_reason: str | None = None

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        response_kind: str = "json",
    ) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = {
            "Accept": "application/json" if response_kind == "json" else "text/html",
            "User-Agent": "LifeOS Platonus Sync Worker/1.0",
        }
        if body is not None:
            headers.update({
                "Content-Type": "application/json",
                "Origin": self.base_url,
                "Referer": f"{self.base_url}/index",
            })
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        diagnostic = {"http_status": None, "url": clean_url(url), "redirect": None}
        try:
            with self._opener.open(req, timeout=15) as resp:
                diagnostic["http_status"] = resp.getcode()
                final_url = resp.geturl()
                if final_url and final_url != url:
                    diagnostic["redirect"] = clean_url(final_url)
                raw = resp.read(5_000_001)
                if len(raw) > 5_000_000:
                    raise SyncError("Platonus response exceeded the size limit")
                decoded = raw.decode("utf-8")
                return json.loads(decoded) if response_kind == "json" else decoded
        except urllib.error.HTTPError as exc:
            diagnostic["http_status"] = exc.code
            location = exc.headers.get("Location") if exc.headers else None
            if location:
                diagnostic["redirect"] = clean_url(urllib.parse.urljoin(url, location))
            exc.close()
            self.failure_reason = "http_error"
            raise
        except (OSError, TimeoutError):
            self.failure_reason = "network_error"
            raise
        except (ValueError, SyncError):
            self.failure_reason = "invalid_response"
            raise
        finally:
            self.request_diagnostics.append(diagnostic)

    def authenticate(self) -> None:
        """Authenticate with the Platonus portal."""
        try:
            # The login page request establishes any preliminary browser cookie.
            self._request("GET", "index", response_kind="html")
            response = self._request("POST", "rest/api/login", {
                "login": self.username,
                "iin": None,
                "icNumber": None,
                "password": self.password,
                # login.js reads this from localStorage, where false is a string.
                "authForDeductedStudentsAndGraduates": "false",
            })
            if isinstance(response, dict) and response.get("login_status") == "success":
                self.failure_reason = None
                return
            self.failure_reason = (
                "verification_required"
                if isinstance(response, dict)
                and (response.get("challengeId") or response.get("verifyStatus"))
                else "login_rejected"
            )
        except (OSError, ValueError, SyncError, urllib.error.HTTPError):
            pass

        if not self._allow_mock:
            raise SyncError(
                "Platonus sign-in failed or requires an additional verification step. "
                "No grade sync was performed."
            )
        self.is_mocked = True
        logging.warning("Platonus sign-in failed; using explicitly enabled mock mode")

    def fetch_grades(self) -> list[dict[str, Any]]:
        """Fetch academic marks/grades."""
        if self.is_mocked:
            return self._get_mock_grades()
        try:
            document = self._request(
                "GET", "current_progress_gradebook_student", response_kind="html"
            )
            grades = parse_gradebook_html(document)
            self.failure_reason = None
            return grades
        except GradebookParseError:
            self.failure_reason = "invalid_gradebook"
        except (OSError, ValueError, SyncError, urllib.error.HTTPError):
            pass
        if not self._allow_mock:
            raise SyncError(
                "Platonus current-progress gradebook could not be fetched or parsed. "
                "No grade sync was performed."
            )
        self.is_mocked = True
        logging.warning("Platonus gradebook fetch failed; using explicitly enabled mock mode")
        return self._get_mock_grades()

    def _get_mock_grades(self) -> list[dict[str, Any]]:
        records = []
        for course in MOCK_COURSES:
            for ass in course["assessments"]:
                records.append({
                    "course_id": course["course_id"],
                    "course_title": course["course_title"],
                    "assessment_id": ass["assessment_id"],
                    "title": ass["title"],
                    "record_type": ass["record_type"],
                    "score": ass["score"],
                    "max_score": ass["max_score"],
                })
        return records


def queue_grade_notification(
    client: SupabaseRestClient,
    source_event: dict[str, Any],
    record: dict[str, Any],
    score: float,
    max_score: float | None,
    change_kind: str,
) -> bool:
    """Queue one Telegram message per distinct published grade value."""
    dedup_key = grade_notification_key(record, score, max_score)
    existing = client.request(
        "GET",
        "reminders",
        query={
            "select": "id",
            "user_id": f"eq.{client.settings.user_id}",
            "dedup_key": f"eq.{dedup_key}",
            "limit": "1",
        },
    )
    if existing:
        return False

    client.request(
        "POST",
        "reminders",
        body={
            "user_id": client.settings.user_id,
            "life_entity_id": source_event.get("normalized_entity_id"),
            # Generic event reminder reconciliation cancels its own pending rows.
            # Leave this notification outside that schedule; keep the life entity link.
            "source_event_id": None,
            "channel": "telegram",
            "status": "pending",
            "remind_at": utc_now(),
            "dedup_key": dedup_key,
            "reminder_policy_key": "platonus_grade",
            "message": f"{record['course_title']}: {score:g}",
            "metadata_json": grade_notification_metadata(
                record, score, max_score, change_kind
            ),
        },
    )
    return True


def grade_notification_key(
    record: dict[str, Any], score: float, max_score: float | None
) -> str:
    grade_key = stable_checksum(
        [record["course_id"], record["assessment_id"], score, max_score]
    )
    return f"platonus-grade:{grade_key}"


def grade_notification_metadata(
    record: dict[str, Any], score: float, max_score: float | None, change_kind: str
) -> dict[str, Any]:
    teacher = str(record.get("teacher") or record.get("teacher_name") or "").strip()
    return {
        "notification_kind": "platonus_grade",
        "change_kind": change_kind,
        "source_label": "Platonus",
        "course_title": str(record["course_title"]),
        "assessment_title": str(record.get("title") or "Оценка"),
        "score": f"{score:g}",
        "max_score": f"{max_score:g}" if max_score is not None else None,
        "teacher": teacher or None,
    }


def preview_grade_notifications(
    db_client: SupabaseRestClient, grades: list[dict[str, Any]]
) -> dict[str, Any]:
    """Read saved Supabase grades and render pending messages without any writes."""
    example_message = None
    if grades:
        example = grades[0]
        example_score = float(example["score"])
        example_max_score = (
            float(example["max_score"])
            if example.get("max_score") is not None else None
        )
        example_message = format_telegram_message({
            "message": f"{example['course_title']}: {example_score:g}",
            "metadata_json": grade_notification_metadata(
                example, example_score, example_max_score, "new"
            ),
        }, {})
    user_id = db_client.settings.user_id
    prior_success = db_client.request(
        "GET", "sync_runs",
        query={
            "select": "id", "user_id": f"eq.{user_id}",
            "source_key": "eq.university_platform", "status": "eq.success",
            "limit": "1",
        },
    )
    if not prior_success:
        return {
            "status": "baseline_not_established",
            "grades_seen": len(grades),
            "unchanged": 0,
            "already_queued": 0,
            "would_send": [],
            "example_message_preview_only": example_message,
        }

    messages: list[str] = []
    unchanged = 0
    already_queued = 0
    for record in grades:
        course_id = str(record["course_id"])
        assessment_id = str(record["assessment_id"])
        score = float(record["score"])
        max_score = (
            float(record["max_score"])
            if record.get("max_score") is not None else None
        )
        external_id = f"academic:platonus:{course_id}:{assessment_id}"
        events = db_client.request(
            "GET", "source_events",
            query={
                "select": "id", "user_id": f"eq.{user_id}",
                "source_key": "eq.university_platform",
                "external_id": f"eq.{external_id}", "limit": "1",
            },
        )
        previous = []
        if events:
            previous = db_client.request(
                "GET", "academic_records",
                query={
                    "select": "score,max_score", "user_id": f"eq.{user_id}",
                    "source_event_id": f"eq.{events[0]['id']}", "limit": "1",
                },
            )
        if previous and previous[0].get("score") is not None and (
            float(previous[0]["score"]) == score
            and (
                float(previous[0]["max_score"])
                if previous[0].get("max_score") is not None else None
            ) == max_score
        ):
            unchanged += 1
            continue

        dedup_key = grade_notification_key(record, score, max_score)
        queued = db_client.request(
            "GET", "reminders",
            query={
                "select": "id", "user_id": f"eq.{user_id}",
                "dedup_key": f"eq.{dedup_key}", "limit": "1",
            },
        )
        if queued:
            already_queued += 1
            continue
        metadata = grade_notification_metadata(
            record, score, max_score, "updated" if previous else "new"
        )
        messages.append(format_telegram_message({
            "message": f"{record['course_title']}: {score:g}",
            "metadata_json": metadata,
        }, {}))

    return {
        "status": "compared",
        "grades_seen": len(grades),
        "unchanged": unchanged,
        "already_queued": already_queued,
        "would_send": messages,
        "example_message_preview_only": example_message,
    }


def sync_grades(
    client: SupabaseRestClient,
    settings: Settings,
    grades: list[dict[str, Any]],
    mode: str,
    run_id: str | None = None,
    notify_changes: bool = False,
) -> SyncStats:
    """Sync the fetched grades to Supabase source_events and academic_records."""
    if run_id is None:
        source = client.ensure_source("university_platform", "university", "University Platform")
        run_id = client.start_sync_run(source)
    stats = SyncStats(seen=len(grades))

    try:
        seen_ids = set()
        for record in grades:
            course_id = str(record.get("course_id") or "").strip()
            assessment_id = str(record.get("assessment_id") or "").strip()
            course_title = str(record.get("course_title") or "").strip()
            if (
                not course_id
                or not assessment_id
                or not course_title
                or record.get("score") is None
            ):
                raise SyncError("Platonus grade is missing a course, assessment, or score")
            assessment_title = record.get("title", "Assessment")
            record_type = record.get("record_type", "assignment")
            score = float(record["score"])
            max_score = (
                float(record["max_score"])
                if record.get("max_score") is not None
                else None
            )
            if not math.isfinite(score) or (
                max_score is not None and not math.isfinite(max_score)
            ):
                raise SyncError("Platonus grade contains a non-finite score")
            percentage = (
                score / max_score * 100.0
                if max_score is not None and max_score > 0
                else None
            )

            external_id = f"academic:platonus:{course_id}:{assessment_id}"
            seen_ids.add(external_id)

            # Build source event dictionary
            event_dict = {
                "source_key": "university_platform",
                "external_id": external_id,
                "event_type": "academic_grade",
                "title": assessment_title,
                "description": f"Platonus grade entry for course {course_title}",
                "status": "active",
                "due_at": iso_utc(datetime.now(timezone.utc)),
                "raw_json": record,
            }

            # Upsert into source_events
            # Grade alerts use their own exact-value deduplication. The generic
            # deadline scheduler must never create an assessment reminder here.
            synced_event, created, reminder_stats = client.upsert_event(
                event_dict, mode, sync_reminders=False
            )
            stats.created += int(created)
            stats.updated += int(not created)
            stats.reminders_created += reminder_stats.created
            stats.reminders_updated += reminder_stats.updated
            stats.reminders_cancelled += reminder_stats.cancelled

            # Upsert into public.academic_records idempotently
            source_event_id = synced_event["id"]
            existing = client.request(
                "GET",
                "academic_records",
                query={
                    "select": "id,score,max_score",
                    "user_id": f"eq.{client.settings.user_id}",
                    "source_event_id": f"eq.{source_event_id}",
                    "limit": "1",
                }
            )

            academic_record_payload = {
                "user_id": settings.base.user_id,
                "source_event_id": source_event_id,
                "course_title": course_title,
                "record_type": record_type,
                "title": assessment_title,
                "score": score,
                "max_score": max_score,
                "percentage": percentage,
                "raw_json": record,
            }

            previous = existing[0] if existing else None
            score_changed = previous is None or (
                previous.get("score") is None
                or float(previous["score"]) != score
                or (
                    float(previous["max_score"])
                    if previous.get("max_score") is not None
                    else None
                ) != max_score
            )
            if notify_changes and score_changed:
                if queue_grade_notification(
                    client,
                    synced_event,
                    {
                        **record,
                        "course_id": course_id,
                        "assessment_id": assessment_id,
                        "course_title": course_title,
                    },
                    score,
                    max_score,
                    "updated" if previous else "new",
                ):
                    stats.reminders_created += 1

            if existing:
                record_id = existing[0]["id"]
                client.request("PATCH", "academic_records", query={"id": f"eq.{record_id}"}, body=academic_record_payload)
            else:
                client.request("POST", "academic_records", body=academic_record_payload)

        # Mark any no-longer-reported events as missing
        stats.missing = client.mark_missing("university_platform", seen_ids)
        client.finish_sync_run(run_id, "success", stats)
        return stats
    except Exception:
        client.finish_sync_run(run_id, "failed", stats, "sync_failed")
        raise


def sync_once(settings: Settings) -> SyncStats:
    """Run single sync execution."""
    client = PlatonusClient(settings)
    db_client = SupabaseRestClient(settings.base)

    # Open the sync_run before attempting live auth/fetch, so a failure here
    # (e.g. mock mode disabled and the portal is blocked) still lands in
    # sync_runs instead of only the systemd journal.
    source = db_client.ensure_source("university_platform", "university", "University Platform")
    run_id = db_client.start_sync_run(source)

    try:
        client.authenticate()
        grades = client.fetch_grades()
    except Exception:
        db_client.finish_sync_run(run_id, "failed", SyncStats(), "portal_fetch_failed")
        raise

    mode = db_client.get_reminder_mode()
    prior_success = db_client.request(
        "GET",
        "sync_runs",
        query={
            "select": "id",
            "user_id": f"eq.{settings.base.user_id}",
            "source_key": "eq.university_platform",
            "status": "eq.success",
            "limit": "1",
        },
    )
    return sync_grades(
        db_client,
        settings,
        grades,
        mode,
        run_id=run_id,
        notify_changes=bool(prior_success) and not client.is_mocked,
    )


def dry_run_once(settings: Settings) -> dict[str, Any]:
    """Fetch live grades and compare to Supabase without writing or sending."""
    portal = PlatonusClient(settings)
    portal.authenticate()
    if portal.is_mocked:
        raise SyncError("Dry-run requires live Platonus records")
    grades = portal.fetch_grades()
    if portal.is_mocked:
        raise SyncError("Dry-run requires live Platonus records")
    return preview_grade_notifications(SupabaseRestClient(settings.base), grades)


def establish_baseline_once(
    settings: Settings, expected_grade_count: int
) -> dict[str, Any]:
    """Persist the first live journal without scheduling any notifications."""
    if settings.allow_mock or expected_grade_count <= 0:
        raise SyncError("Baseline requires live grades and a positive expected count")

    db_client = SupabaseRestClient(settings.base)
    user_scope = {"user_id": f"eq.{settings.base.user_id}"}
    prior_success = db_client.request("GET", "sync_runs", query={
        "select": "id", **user_scope,
        "source_key": "eq.university_platform", "status": "eq.success",
        "limit": "1",
    })
    if prior_success:
        raise SyncError("Baseline already established")

    existing_events = db_client.request("GET", "source_events", query={
        "select": "external_id", **user_scope,
        "source_key": "eq.university_platform",
    }) or []
    if any(
        not str(row.get("external_id") or "").startswith("academic:platonus:")
        for row in existing_events
    ):
        raise SyncError("University source contains non-Platonus records")

    pending_notifications = db_client.request("GET", "reminders", query={
        "select": "id", **user_scope,
        "reminder_policy_key": "eq.platonus_grade",
        "status": "eq.pending", "limit": "1",
    })
    if pending_notifications:
        raise SyncError("Pending grade notifications exist")

    portal = PlatonusClient(settings)
    portal.authenticate()
    grades = portal.fetch_grades()
    grade_keys = {
        (str(row.get("course_id") or ""), str(row.get("assessment_id") or ""))
        for row in grades
    }
    if portal.is_mocked or len(grades) != expected_grade_count or len(grade_keys) != len(grades):
        raise SyncError("Live grade count did not match the expected baseline")

    mode = db_client.get_reminder_mode()
    source = db_client.ensure_source(
        "university_platform", "university", "University Platform"
    )
    run_id = db_client.start_sync_run(source)
    stats = sync_grades(
        db_client, settings, grades, mode,
        run_id=run_id, notify_changes=False,
    )
    if stats.reminders_created or stats.reminders_updated:
        raise SyncError("Baseline unexpectedly scheduled reminders")
    comparison = preview_grade_notifications(db_client, grades)
    if (
        comparison["status"] != "compared"
        or comparison["unchanged"] != len(grades)
        or comparison["would_send"]
    ):
        raise SyncError("Baseline verification failed")
    return {
        "status": "baseline_established",
        "grades_seen": len(grades),
        "unchanged_after_save": comparison["unchanged"],
        "notifications_queued": 0,
    }


def status(settings: Settings) -> None:
    """Print sync status details."""
    print("Platonus university sync status")
    print("Platonus credentials configured: yes")
    db_client = SupabaseRestClient(settings.base)
    for row in db_client.source_status(["university_platform"]):
        print(f"{row['source_key']}: {row['status']} last_sync={row.get('last_sync_at') or 'never'}")


def diagnostic_result(client: PlatonusClient) -> tuple[bool, dict[str, Any]]:
    """Check portal login and parsing without Supabase writes or secret output."""
    try:
        client.authenticate()
        grades = client.fetch_grades()
    except Exception:  # noqa: BLE001 - no exception text may reach diagnostics
        last = client.request_diagnostics[-1] if client.request_diagnostics else {}
        return False, {
            "http_status": last.get("http_status"),
            "url": last.get("url"),
            "redirect": last.get("redirect"),
            "reason": client.failure_reason or "unexpected_failure",
        }
    return True, {
        "ok": True,
        "requests": client.request_diagnostics,
        "grade_count": len(grades),
        "course_count": len({record["course_id"] for record in grades}),
    }


def run_loop(settings: Settings) -> None:
    """Sync continuously in a loop."""
    while True:
        try:
            results = sync_once(settings)
            logging.info("platonus_sync complete stats=%s", results)
        except Exception:  # noqa: BLE001 - provider errors may contain secrets
            logging.error("platonus_sync iteration_failed; see sync_runs status")
        time.sleep(settings.poll_seconds)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LifeOS Platonus university sync")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("command", choices=("status", "sync-once", "run-loop", "diagnose", "dry-run"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "diagnose":
        if args.env_file is not None:
            print(json.dumps({
                "http_status": None, "url": None, "redirect": None,
                "reason": "env_file_not_supported",
            }))
            return 1
        try:
            diagnostic_settings = DiagnosticSettings(
                username=getenv_required("PLATONUS_USERNAME"),
                password=getenv_required("PLATONUS_PASSWORD"),
            )
        except SyncError:
            print(json.dumps({
                "http_status": None, "url": None, "redirect": None,
                "reason": "missing_credentials",
            }))
            return 1
        ok, result = diagnostic_result(PlatonusClient(diagnostic_settings))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if ok else 1
    try:
        settings = load_settings(args.env_file)
        if args.command == "status":
            status(settings)
        elif args.command == "sync-once":
            stats = sync_once(settings)
            print(json.dumps(vars(stats), indent=2))
        elif args.command == "dry-run":
            try:
                result = dry_run_once(settings)
            except Exception:  # noqa: BLE001 - never print secrets from providers
                print(json.dumps({"ok": False, "reason": "dry_run_failed"}))
                return 1
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            run_loop(settings)
        return 0
    except (SyncError, OSError, ValueError):
        logging.error("platonus_sync failed; check configuration and sync_runs")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
