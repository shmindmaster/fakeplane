"""Offline checks: the committed data is internally consistent and holds no prompt text.

Run with `python -m pytest tests` or `python tests/test_dataset.py`. These tests
need no network. The full reproduction (fetch + re-score) is
`python scoring/score.py --check`.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scoring"))

from rules import CONCEPTS, overall_score  # noqa: E402

ROWS = list(csv.DictReader((REPO / "data" / "prompts.csv").open(encoding="utf-8")))
CONTROLS = list(csv.DictReader((REPO / "data" / "controls.csv").open(encoding="utf-8")))
SUMMARY = json.loads((REPO / "data" / "summary.json").read_text(encoding="utf-8"))
CONTROL_KEYS = [c.key for cs in CONCEPTS.values() for c in cs]
DIMENSIONS = list(CONCEPTS)


def _group(key: str) -> list[dict]:
    return [r for r in ROWS if r["source_category"] == key]


def test_row_counts():
    assert len(ROWS) == 356 == SUMMARY["prompts"]
    assert len(_group("production")) == 83
    assert len(_group("gpt_store")) == 273
    assert len({r["prompt_id"] for r in ROWS}) == 356


def test_scores_are_the_mean_of_their_dimensions():
    for r in ROWS:
        dims = {d: int(r[f"dim_{d}"]) for d in DIMENSIONS}
        assert overall_score(dims) == int(r["score"]), r["prompt_id"]
        assert sum(int(r[k]) for k in CONTROL_KEYS) == int(r["controls_stated"])


def test_dimension_scores_follow_from_controls():
    for r in ROWS:
        for d, concepts in CONCEPTS.items():
            k = sum(int(r[c.key]) for c in concepts)
            total = len(concepts)
            expected = 0 if not k else (100 * k + total // 2) // total
            assert int(r[f"dim_{d}"]) == expected, (r["prompt_id"], d)


def test_control_totals_match_rows():
    for c in CONTROLS:
        for key in ("production", "gpt_store"):
            hits = sum(int(r[c["control"]]) for r in _group(key))
            assert hits == int(c[f"{key}_hits"]), (c["control"], key)
            assert len(_group(key)) == int(c[f"{key}_n"])


def test_summary_distribution_matches_rows():
    for key in ("production", "gpt_store"):
        s = sorted(int(r["score"]) for r in _group(key))
        d = SUMMARY["groups"][key]
        assert d["median"] == statistics.median(s)
        assert d["q1"] == s[len(s) // 4] and d["q3"] == s[(3 * len(s)) // 4]
        assert d["zeros"] == s.count(0)
        assert d["max"] == s[-1]


def test_headline_numbers():
    g = SUMMARY["groups"]
    assert g["production"]["median"] == 10 and g["gpt_store"]["median"] == 0
    assert SUMMARY["max_score_any_prompt"] == 34
    assert SUMMARY["analysis"]["delta"] == 0.614
    assert SUMMARY["analysis"]["p_value"] == 0.0001
    assert len(SUMMARY["never_fired"]) == 5


def test_rows_carry_identifiers_and_scores_only():
    allowed = {
        "prompt_id", "source_category", "source_collection", "upstream_commit",
        "upstream_commit_date", "upstream_path", "source_url", "collection_date",
        "git_blob_sha1", "content_sha256", "text_bytes", "word_count", "score",
        "controls_stated", *(f"dim_{d}" for d in DIMENSIONS), *CONTROL_KEYS,
    }
    assert set(ROWS[0]) == allowed
    for r in ROWS:
        assert r["source_url"].startswith(
            f"https://github.com/{r['source_collection']}/blob/{r['upstream_commit']}/"
        )
        assert len(r["content_sha256"]) == 64 and len(r["git_blob_sha1"]) == 40


def test_no_free_text_columns_beyond_paths():
    # Every non-identifier value is a number, a hash, a date or a fixed label.
    free = {"upstream_path", "source_url"}
    for r in ROWS:
        for k, v in r.items():
            if k not in free:
                assert len(v) <= 64, (k, v[:20])


if __name__ == "__main__":
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    raise SystemExit(1 if failures else 0)
