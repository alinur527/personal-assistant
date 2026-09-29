"""Parse the saved Platonus current-progress gradebook without network access."""

from __future__ import annotations

import hashlib
import json
import re
from html.parser import HTMLParser
from typing import Any


class GradebookParseError(ValueError):
    """The document does not contain a recognizable student gradebook."""


def _text(value: str) -> str:
    return " ".join(value.split())


class _GradebookDocument(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[dict[str, Any]]]] = []
        self._table: list[list[dict[str, Any]]] | None = None
        self._row: list[dict[str, Any]] | None = None
        self._cell: dict[str, Any] | None = None
        self._select: str | None = None
        self.period: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "select":
            name = attributes.get("name")
            self._select = name if name in {"year", "term"} else None
        elif tag == "option" and self._select and "selected" in attributes:
            self.period[self._select] = attributes.get("value") or ""
        elif tag == "table":
            self._table = []
            self.tables.append(self._table)
        elif tag == "tr" and self._table is not None:
            self._row = []
            self._table.append(self._row)
        elif tag in {"th", "td"} and self._row is not None:
            self._cell = {"attrs": attributes, "parts": []}
            self._row.append(self._cell)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"}:
            self._cell = None
        elif tag == "tr":
            self._row = None
        elif tag == "table":
            self._table = None
        elif tag == "select":
            self._select = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["parts"].append(data)


def _grid(rows: list[list[dict[str, Any]]]) -> list[list[dict[str, Any] | None]]:
    result: list[list[dict[str, Any] | None]] = []
    for row_index, cells in enumerate(rows):
        while len(result) <= row_index:
            result.append([])
        column = 0
        for cell in cells:
            while column < len(result[row_index]) and result[row_index][column] is not None:
                column += 1
            attrs = cell["attrs"]
            rowspan = min(max(int(attrs.get("rowspan") or 1), 1), 100)
            colspan = min(max(int(attrs.get("colspan") or 1), 1), 100)
            for row_offset in range(rowspan):
                target_index = row_index + row_offset
                while len(result) <= target_index:
                    result.append([])
                target = result[target_index]
                while len(target) < column + colspan:
                    target.append(None)
                for column_offset in range(colspan):
                    target[column + column_offset] = cell
            column += colspan
    return result


def _cell_text(row: list[dict[str, Any] | None], column: int) -> str:
    if column >= len(row) or row[column] is None:
        return ""
    return _text("".join(row[column]["parts"]))


def _grade_column(header: str) -> bool:
    if header.isdigit():
        return 1 <= int(header) <= 15
    return header.casefold() in {
        "рк1",
        "рк2",
        "итоговый контроль",
        "оценка за курсовую работу",
        "практика",
        "исследоват. работа",
    }


def _stable_id(parts: list[str]) -> str:
    encoded = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def parse_gradebook_html(document: str) -> list[dict[str, Any]]:
    """Extract posted numeric marks with course, stream, and listed teacher."""
    parser = _GradebookDocument()
    parser.feed(document)

    for table in parser.tables:
        if not table:
            continue
        grid = _grid(table)
        headers = [_cell_text(grid[0], column) for column in range(len(grid[0]))]
        if "Дисциплина" not in headers or "Преподаватель" not in headers:
            continue

        course_column = headers.index("Дисциплина")
        stream_column = headers.index("Учебный поток") if "Учебный поток" in headers else None
        teacher_column = headers.index("Преподаватель")
        grade_columns = [index for index, header in enumerate(headers) if _grade_column(header)]
        if not grade_columns:
            raise GradebookParseError("Platonus gradebook has no recognized mark columns")

        records: dict[tuple[str, str], dict[str, Any]] = {}
        for row in grid[1:]:
            course = _cell_text(row, course_column)
            teacher = _cell_text(row, teacher_column)
            stream = _cell_text(row, stream_column) if stream_column is not None else ""
            if not course or course == "Дисциплина":
                continue
            course_id = _stable_id([parser.period.get("year", ""), parser.period.get("term", ""), course])
            for column in grade_columns:
                raw_score = _cell_text(row, column)
                if not re.fullmatch(r"\d+(?:[.,]\d+)?", raw_score):
                    continue
                header = headers[column]
                assessment_id = _stable_id([stream, header])
                key = course_id, assessment_id
                record = {
                    "course_id": course_id,
                    "course_title": course,
                    "assessment_id": assessment_id,
                    "title": f"Неделя {header}" if header.isdigit() else header,
                    "record_type": "weekly" if header.isdigit() else "assessment",
                    "score": float(raw_score.replace(",", ".")),
                    "max_score": None,
                    "teacher": teacher,
                    "stream": stream,
                    "year": parser.period.get("year"),
                    "term": parser.period.get("term"),
                }
                previous = records.get(key)
                if previous and previous["score"] != record["score"]:
                    raise GradebookParseError("Platonus gradebook has conflicting marks")
                records[key] = record
        return list(records.values())

    raise GradebookParseError("Platonus student gradebook table was not found")
