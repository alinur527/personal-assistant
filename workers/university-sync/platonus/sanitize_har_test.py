from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("sanitize_har.py")
SPEC = importlib.util.spec_from_file_location("sanitize_har", MODULE_PATH)
assert SPEC and SPEC.loader
sanitize_har = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sanitize_har
SPEC.loader.exec_module(sanitize_har)


class SanitizeHarTest(unittest.TestCase):
    def test_redacts_all_secrets_but_keeps_request_shape(self) -> None:
        sentinel = "SYNTHETIC_SECRET_123456"
        raw = {
            "log": {
                "entries": [
                    {
                        "request": {
                            "method": "POST",
                            "url": f"https://example.org/login?session={sentinel}",
                            "headers": [
                                {"name": "Cookie", "value": f"JSESSIONID={sentinel}"},
                                {"name": "Authorization", "value": f"Bearer {sentinel}"},
                            ],
                            "cookies": [{"name": "JSESSIONID", "value": sentinel}],
                            "postData": {
                                "mimeType": "application/x-www-form-urlencoded",
                                "text": f"username=user&password={sentinel}",
                            },
                        },
                        "response": {
                            "status": 302,
                            "headers": [
                                {"name": "Set-Cookie", "value": f"JSESSIONID={sentinel}"},
                                {"name": "Location", "value": f"/current_progress_gradebook_student?token={sentinel}"},
                            ],
                            "content": {
                                "mimeType": "text/html",
                                "text": f'<form action="/login"><input name="password" value="{sentinel}"></form>',
                            },
                        },
                        "_unsafe_extension_field": sentinel,
                    }
                ]
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "raw.har"
            target = Path(directory) / "clean.har"
            source.write_text(json.dumps(raw), encoding="utf-8")
            self.assertEqual(sanitize_har.sanitize(source, target), 1)
            cleaned_text = target.read_text(encoding="utf-8")
            cleaned = json.loads(cleaned_text)["log"]["entries"][0]

        self.assertNotIn(sentinel, cleaned_text)
        self.assertEqual(cleaned["request"]["method"], "POST")
        self.assertEqual(cleaned["request"]["url"], "https://example.org/login?session=%5BREMOVED%5D")
        self.assertEqual(
            [item["name"] for item in cleaned["request"]["postData"]["params"]],
            ["username", "password"],
        )
        self.assertEqual(cleaned["response"]["status"], 302)
        self.assertEqual(cleaned["response"]["content"]["shape"]["forms"][0]["fields"][0]["name"], "password")
        self.assertEqual(cleaned["request"]["headers"][0]["value"], "[REMOVED]")
        self.assertEqual(cleaned["response"]["headers"][0]["value"], "[REMOVED]")

    def test_redacts_json_values_and_long_path_segments(self) -> None:
        secret = "abcdefabcdefabcdefabcdefabcdefabcdef"
        self.assertEqual(sanitize_har.clean_url(f"data:image/png;base64,{secret}"), "[REMOVED]")
        self.assertEqual(
            sanitize_har.clean_url(f"https://example.org/{secret}/grades?studentID={secret}"),
            "https://example.org/[REMOVED]/grades?studentID=%5BREMOVED%5D",
        )
        self.assertEqual(
            sanitize_har.clean_post_data({
                "mimeType": "application/json",
                "text": json.dumps({"username": "user", "password": secret, "nested": {"token": secret}}),
            })["text"],
            '{"username": "[REMOVED]", "password": "[REMOVED]", "nested": {"token": "[REMOVED]"}}',
        )

    def test_keeps_only_safe_script_route_literals(self) -> None:
        secret = "SYNTHETIC_SECRET_123456"
        content = sanitize_har.clean_content({
            "mimeType": "application/javascript",
            "text": f'const endpoint="rest/api/login"; const password="{secret}"; fetch(endpoint);',
        })
        self.assertEqual(content["shape"]["route_literals"], ["rest/api/login"])
        self.assertIn("LOGIN_ROUTE", content["shape"]["login_code_tokens"])
        self.assertNotIn(secret, json.dumps(content))


if __name__ == "__main__":
    unittest.main()
