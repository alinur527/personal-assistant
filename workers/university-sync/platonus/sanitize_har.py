#!/usr/bin/env python3
"""Make a structural HAR copy that is safe to inspect and share.

Only explicitly selected HAR fields are copied. Request and response values,
cookies, bodies, and arbitrary browser extension fields are never copied raw.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

REMOVED = "[REMOVED]"
SAFE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.\[\]-]{0,79}$")
SAFE_PATH = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,39}$")


def field_name(value: Any) -> str:
    name = str(value or "")
    return name if SAFE_NAME.fullmatch(name) else "[FIELD]"


def clean_url(value: Any) -> str:
    if not isinstance(value, str):
        return REMOVED
    if not value:
        return ""
    try:
        url = urlsplit(value)
        if url.scheme and url.scheme not in {"http", "https"}:
            return REMOVED
        # Discard URL userinfo, fragment, and all query values. Preserve endpoint
        # names and query parameter names needed to reconstruct the request.
        host = url.hostname or ""
        if host and not re.fullmatch(r"[A-Za-z0-9.-]+", host):
            host = REMOVED
        if url.port:
            host += f":{url.port}"
        path = "/".join(
            segment
            if not segment or (
                SAFE_PATH.fullmatch(segment)
                and not re.search(r"\d{5,}", segment)
                and (len(segment) <= 24 or segment == "current_progress_gradebook_student")
            )
            else REMOVED
            for segment in url.path.split("/")
        )
        query = urlencode(
            [(field_name(key), REMOVED) for key, _ in parse_qsl(url.query, keep_blank_values=True)]
        )
        return urlunsplit((url.scheme if url.scheme in {"http", "https"} else "", host, path, query, ""))
    except (ValueError, TypeError):
        return REMOVED


def clean_headers(items: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if not isinstance(items, list):
        return result
    for item in items:
        if not isinstance(item, dict):
            continue
        name = field_name(item.get("name"))
        value = REMOVED
        if name.lower() in {"location", "referer", "origin"}:
            value = clean_url(item.get("value"))
        elif name.lower() == "content-type":
            media_type = str(item.get("value") or "").split(";", 1)[0].strip().lower()
            if re.fullmatch(r"[a-z][a-z0-9.+-]*/[a-z][a-z0-9.+-]*", media_type):
                value = media_type
        result.append({"name": name, "value": value})
    return result


def clean_params(items: Any) -> list[dict[str, str]]:
    if not isinstance(items, list):
        return []
    return [
        {"name": field_name(item.get("name")), "value": REMOVED}
        for item in items
        if isinstance(item, dict)
    ]


def redact_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {field_name(key): redact_json(child) for key, child in value.items()}
    if isinstance(value, list):
        return [redact_json(child) for child in value]
    return REMOVED


_JS_TOKEN = re.compile(
    r"/\*[\s\S]*?\*/|//[^\n]*|"
    r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`|"
    r"[A-Za-z_$][A-Za-z0-9_$]*|\d+|[{}()\[\].,:;=+?!-]"
)
_SAFE_JS_STRINGS = {
    "rest/api/login", "/rest/api/login", "POST", "GET", "login", "password",
    "url", "type", "method", "data", "success", "error", "status",
    "contentType", "dataType", "username", "code", "sid", "returnUrl",
    "application/json", "application/x-www-form-urlencoded",
}


def js_login_context(source: str) -> list[str]:
    """Keep only code tokens around the static login route, never JS values."""
    route = re.search(r"rest/api/login(?!/)", source)
    if route is None:
        return []
    route_at = route.start()
    source = source[max(0, route_at - 900):route_at + 1500]
    tokens: list[str] = []
    for match in _JS_TOKEN.finditer(source):
        token = match.group()
        if token.startswith(("//", "/*")):
            continue
        if token.startswith(("'", '"', "`")):
            literal = token[1:-1]
            if "rest/api/login" in literal and "rest/api/login/" not in literal:
                tokens.append("LOGIN_ROUTE")
            else:
                tokens.append(literal if literal in _SAFE_JS_STRINGS else "STRING")
        elif token[0].isdigit():
            tokens.append("NUMBER")
        elif re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", token):
            tokens.append(token if len(token) <= 40 and not re.search(r"\d{5,}", token) else "IDENTIFIER")
        else:
            tokens.append(token)
    return tokens[:450]


class _HtmlShape(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: list[dict[str, Any]] = []
        self._current_form: dict[str, Any] | None = None
        self.fields: list[dict[str, str]] = []
        self.tables = 0
        self.login_target: str | None = None
        self._in_script = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "form":
            self._current_form = {
                "method": str(values.get("method") or "get").lower() if str(values.get("method") or "get").lower() in {"get", "post"} else REMOVED,
                "action": clean_url(values.get("action") or ""),
                "fields": [],
            }
            self.forms.append(self._current_form)
        elif tag in {"input", "select", "textarea", "button"}:
            kind = str(values.get("type") or tag).lower()
            field = {
                "name": field_name(values.get("name")),
                "type": kind if re.fullmatch(r"[a-z]{1,30}", kind) else REMOVED,
            }
            self.fields.append(field)
            if self._current_form is not None:
                self._current_form["fields"].append(field)
        elif tag == "table":
            self.tables += 1
        elif tag == "script":
            self._in_script = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self._current_form = None
        elif tag == "script":
            self._in_script = False

    def handle_data(self, data: str) -> None:
        if self._in_script and self.login_target is None:
            match = re.search(r"(?:var|let|const)\s+login\s*=\s*(['\"])(.*?)\1", data)
            if match:
                self.login_target = clean_url(match.group(2))


def clean_post_data(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    mime = str(data.get("mimeType") or "").split(";", 1)[0].strip().lower()
    result: dict[str, Any] = {"mimeType": mime if re.fullmatch(r"[a-z][a-z0-9.+-]*/[a-z][a-z0-9.+-]*", mime) else REMOVED}
    if "params" in data:
        result["params"] = clean_params(data["params"])
    raw = data.get("text")
    if isinstance(raw, str):
        if "json" in mime:
            try:
                result["text"] = json.dumps(redact_json(json.loads(raw)), ensure_ascii=False)
            except (ValueError, TypeError):
                result["text"] = REMOVED
        elif mime == "application/x-www-form-urlencoded":
            result["params"] = clean_params(
                [{"name": key} for key, _ in parse_qsl(raw, keep_blank_values=True)]
            )
            result["text"] = REMOVED
        else:
            result["text"] = REMOVED
    return result


def clean_content(content: Any) -> dict[str, Any]:
    if not isinstance(content, dict):
        return {"text": REMOVED}
    mime = str(content.get("mimeType") or "").split(";", 1)[0].strip().lower()
    result: dict[str, Any] = {"mimeType": mime if re.fullmatch(r"[a-z][a-z0-9.+-]*/[a-z][a-z0-9.+-]*", mime) else REMOVED}
    raw = content.get("text")
    if isinstance(raw, str) and content.get("encoding") != "base64":
        if mime in {"text/html", "application/xhtml+xml"}:
            shape = _HtmlShape()
            shape.feed(raw)
            result["shape"] = {
                "forms": shape.forms,
                "fields": shape.fields,
                "table_count": shape.tables,
                "login_target": shape.login_target,
            }
        elif "json" in mime:
            try:
                result["shape"] = redact_json(json.loads(raw))
            except (ValueError, TypeError):
                pass
        elif mime in {"text/javascript", "application/javascript", "application/x-javascript"}:
            # Static route literals can identify a login endpoint without
            # retaining script bodies, credentials, or arbitrary string data.
            routes = set(re.findall(r"(?<![A-Za-z0-9_])/?(?:rest|api)/[A-Za-z][A-Za-z0-9_./-]{0,79}", raw))
            result["shape"] = {"route_literals": sorted(
                cleaned for route in routes if (cleaned := clean_url(route)) != REMOVED
            ), "login_code_tokens": js_login_context(raw)}
    result["text"] = REMOVED
    return result


def clean_entry(entry: dict[str, Any]) -> dict[str, Any]:
    request = entry.get("request") if isinstance(entry.get("request"), dict) else {}
    response = entry.get("response") if isinstance(entry.get("response"), dict) else {}
    method = str(request.get("method") or "").upper()
    clean_request: dict[str, Any] = {
        "method": method if re.fullmatch(r"[A-Z]{1,12}", method) else REMOVED,
        "url": clean_url(request.get("url")),
        "headers": clean_headers(request.get("headers")),
        "queryString": clean_params(request.get("queryString")),
        "cookies": clean_params(request.get("cookies")),
    }
    post_data = clean_post_data(request.get("postData"))
    if post_data is not None:
        clean_request["postData"] = post_data
    status = response.get("status")
    clean_response: dict[str, Any] = {
        "status": status if isinstance(status, int) and 0 <= status <= 599 else None,
        "headers": clean_headers(response.get("headers")),
        "cookies": clean_params(response.get("cookies")),
        "redirectURL": clean_url(response.get("redirectURL")),
        "content": clean_content(response.get("content")),
    }
    return {"request": clean_request, "response": clean_response}


def sanitize(source: Path, destination: Path) -> int:
    if source.resolve() == destination.resolve():
        raise ValueError("Source and destination must differ")
    with source.open("r", encoding="utf-8-sig") as stream:
        raw = json.load(stream)
    entries = raw.get("log", {}).get("entries", [])
    if not isinstance(entries, list):
        raise ValueError("Invalid HAR entries")
    cleaned = {"log": {"version": "1.2", "entries": [clean_entry(item) for item in entries if isinstance(item, dict)]}}
    with destination.open("w", encoding="utf-8") as stream:
        json.dump(cleaned, stream, ensure_ascii=False, indent=2)
    return len(cleaned["log"]["entries"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a redacted, structural HAR copy")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        count = sanitize(args.source, args.destination)
    except (OSError, ValueError, TypeError, AttributeError):
        print("HAR sanitization failed; no raw content was printed", file=sys.stderr)
        return 1
    print(f"Sanitized {count} HAR entries to {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
