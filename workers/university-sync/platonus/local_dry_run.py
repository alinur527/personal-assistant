#!/usr/bin/env python3
"""Read-only Platonus preview using the developer's ignored bot .env file."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from platonus_sync import (
    BaseSettings,
    SupabaseRestClient,
    dry_run_once,
    load_dotenv,
    load_settings,
)


def load_local_owner_id() -> str:
    repo_root = Path(__file__).resolve().parents[3]
    bot_env = repo_root / "apps" / "bot" / ".env"
    if not bot_env.is_file():
        raise FileNotFoundError("local_bot_env_missing")

    load_dotenv(bot_env)
    if not os.environ.get("LIFEOS_DEFAULT_USER_ID", "").strip():
        admin_ids = [
            value.strip()
            for value in os.environ.get("LIFEOS_ADMIN_TELEGRAM_IDS", "").split(",")
            if value.strip()
        ]
        if len(admin_ids) != 1 or not admin_ids[0].isdigit():
            raise ValueError("admin_profile_not_unique")
        db = SupabaseRestClient(BaseSettings(
            supabase_url=os.environ["SUPABASE_URL"].rstrip("/"),
            service_role_key=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            user_id="",
            timezone_name="Asia/Qyzylorda",
        ))
        profiles = db.request("GET", "profiles", query={
            "select": "user_id",
            "telegram_user_id": f"eq.{admin_ids[0]}",
            "status": "eq.active",
            "limit": "2",
        })
        if len(profiles or []) != 1:
            raise ValueError("admin_profile_not_unique")
        os.environ["LIFEOS_DEFAULT_USER_ID"] = str(profiles[0]["user_id"])
    return os.environ["LIFEOS_DEFAULT_USER_ID"]


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:] if argv is None else argv
    if args not in ([], ["--owner-id"]):
        print(json.dumps({"ok": False, "reason": "unsupported_argument"}))
        return 1
    try:
        owner_id = load_local_owner_id()
        if args == ["--owner-id"]:
            print(owner_id)
            return 0
        os.environ["LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC"] = "true"
        os.environ["PLATONUS_SYNC_MOCK_MODE"] = "false"
        result = dry_run_once(load_settings())
    except Exception:  # noqa: BLE001 - provider errors may contain secrets
        print(json.dumps({"ok": False, "reason": "local_dry_run_failed"}))
        return 1

    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
