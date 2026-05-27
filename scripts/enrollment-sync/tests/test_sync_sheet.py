import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import sync_sheet


UPDATED_AT = "27 May 2026 12:00 UTC"


def _by_range(updates):
    return {u["range"]: u["values"] for u in updates}


def test_writes_each_known_program_by_sheet_row():
    counts = {
        "Grade 1 Teaching - Renewal 2026 In-Person": {"registered": 13, "cancelled": 0, "waitlisted": 0},
        "Grade 1 Teaching - Renewal 2026 Online": {"registered": 12, "cancelled": 1, "waitlisted": 2},
    }
    label_to_row = {
        "Grade 1 Teaching - Renewal 2026 In-Person": 2,
        "Grade 1 Teaching - Renewal 2026 Online": 13,
    }

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)
    by_range = _by_range(updates)

    assert by_range["C2:F2"] == [["13", "0", "0", UPDATED_AT]]
    assert by_range["C13:F13"] == [["12", "1", "2", UPDATED_AT]]


def test_applies_community_gatherings_alias():
    counts = {
        "Morning Community Gatherings Only - Renewal 2026 Online": {"registered": 5, "cancelled": 0, "waitlisted": 0},
    }
    label_to_row = {"Community Gatherings Only": 21}

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)
    by_range = _by_range(updates)

    assert by_range["C21:F21"] == [["5", "0", "0", UPDATED_AT]]


def test_skips_sheet_rows_without_supabase_data():
    """Rows Elsy added that aren't synced (e.g. Physical Science) must be left alone."""
    counts = {}
    label_to_row = {"Teaching Physical Science in Grades 6, 7, & 8": 22}

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)

    assert updates == []


def test_total_in_person_sums_only_in_person_programs():
    counts = {
        "Grade 1 Teaching - Renewal 2026 In-Person": {"registered": 13, "cancelled": 1, "waitlisted": 0},
        "Grade 2 Teaching - Renewal 2026 In-Person": {"registered": 9, "cancelled": 0, "waitlisted": 2},
        "Grade 1 Teaching - Renewal 2026 Online": {"registered": 99, "cancelled": 99, "waitlisted": 99},
    }
    label_to_row = {
        "Grade 1 Teaching - Renewal 2026 In-Person": 2,
        "Grade 2 Teaching - Renewal 2026 In-Person": 3,
        "Grade 1 Teaching - Renewal 2026 Online": 13,
        "Total In-Person": 12,
    }

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)
    by_range = _by_range(updates)

    assert by_range["C12:F12"] == [["22", "1", "2", UPDATED_AT]]


def test_total_online_sums_only_online_programs_including_community_gatherings():
    counts = {
        "Grade 1 Teaching - Renewal 2026 Online": {"registered": 12, "cancelled": 0, "waitlisted": 0},
        "Grade 2 Teaching - Renewal 2026 Online": {"registered": 7, "cancelled": 1, "waitlisted": 0},
        "Morning Community Gatherings Only - Renewal 2026 Online": {"registered": 5, "cancelled": 0, "waitlisted": 3},
        "Grade 1 Teaching - Renewal 2026 In-Person": {"registered": 99, "cancelled": 99, "waitlisted": 99},
    }
    label_to_row = {
        "Grade 1 Teaching - Renewal 2026 Online": 13,
        "Grade 2 Teaching - Renewal 2026 Online": 14,
        "Community Gatherings Only": 21,
        "Grade 1 Teaching - Renewal 2026 In-Person": 2,
        "Total-Online": 23,
    }

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)
    by_range = _by_range(updates)

    assert by_range["C23:F23"] == [["24", "1", "3", UPDATED_AT]]


def test_totals_not_written_when_no_total_row_on_sheet():
    counts = {
        "Grade 1 Teaching - Renewal 2026 In-Person": {"registered": 13, "cancelled": 0, "waitlisted": 0},
    }
    label_to_row = {"Grade 1 Teaching - Renewal 2026 In-Person": 2}

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)
    ranges = {u["range"] for u in updates}

    assert ranges == {"C2:F2"}


def test_total_rows_are_not_treated_as_unknown_programs():
    """Even when no in-person/online programs are synced, the total label itself
    must not be misinterpreted as a missing program (which would skip it silently)."""
    counts = {}
    label_to_row = {"Total In-Person": 12, "Total-Online": 23}

    updates = sync_sheet.build_updates(counts, label_to_row, UPDATED_AT)
    by_range = _by_range(updates)

    assert by_range["C12:F12"] == [["0", "0", "0", UPDATED_AT]]
    assert by_range["C23:F23"] == [["0", "0", "0", UPDATED_AT]]
