from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("gradebook_html.py")
SPEC = importlib.util.spec_from_file_location("gradebook_html", MODULE_PATH)
assert SPEC and SPEC.loader
gradebook_html = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gradebook_html
SPEC.loader.exec_module(gradebook_html)


def document(mark: str = "90", year: str = "2026") -> str:
    return f"""
    <form action="current_progress_gradebook_student">
      <select name="year"><option value="{year}" selected>{year}</option></select>
      <select name="term"><option value="1" selected>1</option></select>
    </form>
    <table>
      <tr>
        <td rowspan="2">Дисциплина</td><td rowspan="2">Учебный поток</td>
        <td rowspan="2">Преподаватель</td><td rowspan="2">1</td>
        <td rowspan="2">ТК1 ОБЩ.</td><td rowspan="2">РК1</td>
        <td colspan="2">Итоговая оценка</td>
      </tr>
      <tr><td>%</td><td>Буквенная</td></tr>
      <tr>
        <td rowspan="2">Mathematics</td><td>Group-L</td><td>Teacher A</td>
        <td>{mark}</td><td rowspan="2">45</td><td>75</td><td rowspan="2">0</td><td rowspan="2">F</td>
      </tr>
      <tr><td>Group-P</td><td>Teacher B</td><td>н.п.</td><td></td></tr>
    </table>
    """


class GradebookHtmlTest(unittest.TestCase):
    def test_extracts_atomic_grades_and_teacher(self) -> None:
        grades = gradebook_html.parse_gradebook_html(document())

        self.assertEqual(len(grades), 2)
        weekly = next(row for row in grades if row["record_type"] == "weekly")
        self.assertEqual(weekly["course_title"], "Mathematics")
        self.assertEqual(weekly["score"], 90)
        self.assertEqual(weekly["teacher"], "Teacher A")
        self.assertEqual(weekly["stream"], "Group-L")
        self.assertEqual({row["title"] for row in grades}, {"Неделя 1", "РК1"})

    def test_mark_change_keeps_identity_and_period_changes_it(self) -> None:
        before = gradebook_html.parse_gradebook_html(document())
        after = gradebook_html.parse_gradebook_html(document(mark="95"))
        next_year = gradebook_html.parse_gradebook_html(document(year="2027"))

        self.assertEqual(before[0]["assessment_id"], after[0]["assessment_id"])
        self.assertEqual(before[0]["course_id"], after[0]["course_id"])
        self.assertNotEqual(before[0]["course_id"], next_year[0]["course_id"])
        self.assertEqual(after[0]["score"], 95)

    def test_rejects_unrelated_page(self) -> None:
        with self.assertRaises(gradebook_html.GradebookParseError):
            gradebook_html.parse_gradebook_html("<html><body>Log in</body></html>")


if __name__ == "__main__":
    unittest.main()
