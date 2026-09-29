#!/usr/bin/env python3
"""One-time live Platonus baseline writer; never queues grade alerts."""

from __future__ import annotations

import argparse
import json
import os
import sys

from local_dry_run import load_local_owner_id
from platonus_sync import establish_baseline_once, load_settings


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Save the first live Platonus baseline")
    parser.add_argument("--expected-grades", type=int, required=True)
    args = parser.parse_args(argv)

    try:
        load_local_owner_id()
        os.environ["LIFEOS_ENABLE_LEGACY_SINGLE_USER_PLATONUS_SYNC"] = "true"
        os.environ["PLATONUS_SYNC_MOCK_MODE"] = "false"
        result = establish_baseline_once(load_settings(), args.expected_grades)
    except Exception:  # noqa: BLE001 - provider errors may contain secrets
        print(json.dumps({"ok": False, "reason": "baseline_failed"}))
        return 1

    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
