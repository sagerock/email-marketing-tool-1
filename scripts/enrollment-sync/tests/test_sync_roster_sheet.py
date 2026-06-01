import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import sync_roster_sheet as s


UPDATED_AT = "1 Jun 2026 09:00 UTC"


def _by_range(updates):
    return {u["range"]: u["values"] for u in updates}


# --- program_to_session_label ---


def test_label_grade_online():
    assert s.program_to_session_label("Grade 3 Teaching - Renewal 2026 Online") == "Grade 3 – Online"


def test_label_grade_in_person():
    assert s.program_to_session_label("Grade 8 Teaching - Renewal 2026 In-Person") == "Grade 8 – In-Person"


def test_label_special_subjects():
    assert s.program_to_session_label("Teaching Special Subjects - Renewal 2026 In-Person") == "Special Subjects"


def test_label_movement_education():
    assert s.program_to_session_label(
        "Movement Education and Renewal Through the Grades - Renewal 2026 In-Person"
    ) == "Movement Education"


def test_label_community_gatherings():
    assert s.program_to_session_label("Morning Community Gatherings Only - Renewal 2026 Online") == "Community Gatherings Only"


def test_label_unknown_returns_none():
    assert s.program_to_session_label("Some Random Program 2027") is None


# --- build_attendees_values ---


def test_attendees_values_stamp_only_on_first_row():
    rows = [
        {"session": "Grade 1 – Online", "type": "Online", "first_name": "Ana", "last_name": "Adams", "email": "a@x"},
        {"session": "Grade 1 – Online", "type": "Online", "first_name": "Bo", "last_name": "Brown", "email": "b@x"},
    ]
    values = s.build_attendees_values(rows, UPDATED_AT)
    assert values[0] == ["Grade 1 – Online", "Online", "Ana", "Adams", "a@x", UPDATED_AT]
    assert values[1] == ["Grade 1 – Online", "Online", "Bo", "Brown", "b@x", ""]


def test_attendees_values_empty_when_no_rows():
    assert s.build_attendees_values([], UPDATED_AT) == []


# --- build_summary_updates ---


def test_summary_writes_count_for_each_label():
    counts = {"Grade 1 – Online": 12, "Grade 1 – In-Person": 14}
    label_to_row = {"Grade 1 – Online": 2, "Grade 1 – In-Person": 10}
    by_range = _by_range(s.build_summary_updates(counts, label_to_row, UPDATED_AT))
    assert by_range["C2:D2"] == [["12", UPDATED_AT]]
    assert by_range["C10:D10"] == [["14", UPDATED_AT]]


def test_summary_total_row_sums_all_counts():
    counts = {"Grade 1 – Online": 12, "Grade 1 – In-Person": 14, "Special Subjects": 6}
    label_to_row = {
        "Grade 1 – Online": 2,
        "Grade 1 – In-Person": 10,
        "Special Subjects": 18,
        "TOTAL": 21,
    }
    by_range = _by_range(s.build_summary_updates(counts, label_to_row, UPDATED_AT))
    assert by_range["C21:D21"] == [["32", UPDATED_AT]]


def test_summary_total_treated_as_label_not_session():
    """If TOTAL appears in counts (it shouldn't), don't double-count it."""
    counts = {"Grade 1 – Online": 5}
    label_to_row = {"Grade 1 – Online": 2, "TOTAL": 21}
    updates = s.build_summary_updates(counts, label_to_row, UPDATED_AT)
    by_range = _by_range(updates)
    assert by_range["C21:D21"] == [["5", UPDATED_AT]]
    # TOTAL row shouldn't appear in the non-total updates
    assert by_range["C2:D2"] == [["5", UPDATED_AT]]


def test_summary_skips_labels_without_counts():
    """Rows Elsy added (e.g. a session we don't track) leave the count untouched."""
    counts = {"Grade 1 – Online": 12}
    label_to_row = {"Grade 1 – Online": 2, "Some Future Session": 5}
    by_range = _by_range(s.build_summary_updates(counts, label_to_row, UPDATED_AT))
    assert "C5:D5" not in by_range
    assert by_range["C2:D2"] == [["12", UPDATED_AT]]


# --- session order / rank ---


def test_session_rank_puts_online_grades_before_in_person():
    assert s.SESSION_RANK["Grade 8 – Online"] < s.SESSION_RANK["Grade 1 – In-Person"]


def test_session_rank_puts_grade_8_in_person_before_special_subjects():
    assert s.SESSION_RANK["Grade 8 – In-Person"] < s.SESSION_RANK["Special Subjects"]


def test_session_rank_puts_community_gatherings_last():
    assert s.SESSION_RANK["Community Gatherings Only"] == max(s.SESSION_RANK.values())
