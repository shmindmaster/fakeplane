#!/usr/bin/env python3
"""Re-run the 356-prompt written-safeguard study and regenerate every data file.

    docker compose run --build --rm score   # host: fetch, score, fail on drift
    python scoring/score.py --check         # inside the image
    python scoring/score.py --offline       # reuse the mounted .cache volume

Standard library only (Python 3.10+) plus git on PATH.

What it does:

1. Fetches each source collection at one pinned commit into ``/app/.cache``
   (the ``safeguards-cache`` volume). Nothing fetched is committed to this
   repository: the prompt text is third-party material and is never
   redistributed here.
2. Reads each prompt from the committed git blob (not the working tree), so the
   content hash is the same on every OS regardless of line-ending settings.
3. Scores every prompt against the 23 controls in scoring/rules.py.
4. Writes per-prompt rows, per-control totals, the summary statistics, the
   generated results page and the chart.
5. Refuses to write anything if a self-check fails, including a scan proving no
   40-character run of prompt text reaches any output.

Statistics follow the original scoring harness exactly (same seeds, same
procedures), so the numbers match the study as first published.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import random
import re
import statistics
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

from rules import (  # noqa: E402
    CONCEPTS,
    RULESET_ID,
    SCORER_MAP,
    _match_patterns,
    covered_concepts,
    overall_score,
)

CACHE = REPO / ".cache"
DATA = REPO / "data"
PROMPTS_CSV = DATA / "prompts.csv"
CONTROLS_CSV = DATA / "controls.csv"
SUMMARY_JSON = DATA / "summary.json"
RESULTS_MD = REPO / "docs" / "RESULTS.md"
CHART_SVG = REPO / "figures" / "controls-by-source.svg"

DATASET_VERSION = "1.0.0"
SEED = 20260729
RESAMPLES = 10_000
ALPHA = 0.05
LEAK_WINDOW = 40
MIN_WORDS = 20


@dataclass(frozen=True)
class Corpus:
    key: str
    label: str
    repo: str
    sha: str
    collected: str
    include: str
    exclude_stems: tuple[str, ...]
    license_note: str

    @property
    def url(self) -> str:
        return f"https://github.com/{self.repo}"


CORPORA = (
    Corpus(
        key="production",
        label="Production agent system prompts",
        repo="x1xhlol/system-prompts-and-models-of-ai-tools",
        sha="2054f580b1203da061e8e3df3c6449de2ad7c322",
        collected="2026-07-28",
        include="*.txt",
        exclude_stems=("readme", "license"),
        license_note=(
            "The collection is distributed under GPL-3.0 (LICENSE.md at the pinned "
            "commit). That licence covers the maintainer's compilation; the prompt "
            "text belongs to the vendors it was taken from. Not redistributed here."
        ),
    ),
    Corpus(
        key="gpt_store",
        label="GPT Store prompts",
        repo="linexjlin/GPTs",
        sha="3adfb7b38423b64a995057483c1f9007ed5f4da5",
        collected="2026-07-28",
        include="prompts/*.md",
        exclude_stems=("readme", "license"),
        license_note=(
            "The collection declares no licence. The prompt text belongs to the "
            "individual GPT authors. Not redistributed here."
        ),
    ),
)

CONTROL_KEYS = [c.key for cs in CONCEPTS.values() for c in cs]
CONTROL_LABEL = {c.key: c.label for cs in CONCEPTS.values() for c in cs}
CONTROL_DIMENSION = {c.key: d for d, cs in CONCEPTS.items() for c in cs}
CONTROL_RULES = {c.key: c.rule_ids for cs in CONCEPTS.values() for c in cs}
DIMENSIONS = list(SCORER_MAP)

ROW_FIELDS = [
    "prompt_id",
    "source_category",
    "source_collection",
    "upstream_commit",
    "upstream_commit_date",
    "upstream_path",
    "source_url",
    "collection_date",
    "git_blob_sha1",
    "content_sha256",
    "text_bytes",
    "word_count",
    "score",
    "controls_stated",
    *[f"dim_{d}" for d in DIMENSIONS],
    *CONTROL_KEYS,
]
# Columns that identify where a prompt lives upstream. They are references, not
# prompt content, and are the only fields excluded from the text-leak scan
# (a GPT's file name is its title, which its own prompt usually repeats).
IDENTIFIER_FIELDS = ("upstream_path", "source_url")

# Deliberately looser probes than the shipped rules, used only to tell
# "the control is absent" apart from "the rules are too narrow". Never scored.
ABSENCE_PROBES: dict[str, tuple[str, ...]] = {
    "hallucination.grounding": (
        r"based\s+(?:only\s+)?on\s+the\s+(?:provided|given|supplied|retrieved|"
        r"attached|following)\s+(?:context|document|source|information|data)",
        r"using\s+only\s+the\s+(?:provided\s+)?(?:context|document|source|information)",
        r"(?:answer|respond|reply)\s+(?:only\s+)?(?:from|using|with)\s+the\s+"
        r"(?:context|knowledge\s*base|provided|documents?|sources?)",
        r"(?:do\s+not|don't|never)\s+use\s+(?:any\s+)?(?:outside|external|prior|"
        r"your\s+own)\s+knowledge",
        r"if\s+(?:the\s+)?(?:answer|information|it)\s+is\s+not\s+(?:in|found\s+in|"
        r"contained\s+in)\s+the\s+(?:context|document|source)",
    ),
    "audit.log_actions": (
        r"\b(?:log|record|track)\b.{0,40}?\b(?:action|decision|tool|call)\b",
        r"\baudit\s+trail\b",
        r"\bdecision\s+log\b",
    ),
    "audit.tamper_evident": (r"immutab|append.only|tamper|write.once|read.only\s+log",),
    "audit.actor_attribution": (
        r"who\s+did\s+what",
        r"(?:record|log)\s+who",
        r"approver\s+and\s+time",
        r"actor\s+attribution",
    ),
    "compliance.data_protection": (
        r"(?:encrypt|redact|de[\s-]?identif|anonymi).{0,40}?"
        r"(?:personal|pii|phi|sensitive|user\s+data)",
        r"(?:personal|pii|phi|sensitive).{0,40}?"
        r"(?:encrypt|redact|de[\s-]?identif|anonymi)",
    ),
}


# ─── fetch and read ───────────────────────────────────────────────────


def _git(cwd: Path, *args: str, binary: bool = False, stdin: bytes | None = None):
    out = subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True, input=stdin
    ).stdout
    return out if binary else out.decode("utf-8").strip()


def fetch(corpus: Corpus, *, offline: bool) -> Path:
    dest = CACHE / corpus.key
    if (dest / ".git").exists():
        have = _git(dest, "rev-parse", "HEAD")
        if have == corpus.sha:
            return dest
        if offline:
            raise SystemExit(f"{corpus.key}: cache at {have[:12]}, expected {corpus.sha[:12]}")
    elif offline:
        raise SystemExit(f"{corpus.key}: no cache at {dest} and --offline given")
    dest.mkdir(parents=True, exist_ok=True)
    if not (dest / ".git").exists():
        _git(dest, "init", "-q")
        _git(dest, "config", "core.autocrlf", "false")
        _git(dest, "remote", "add", "origin", corpus.url)
    _git(dest, "fetch", "-q", "--depth", "1", "origin", corpus.sha)
    _git(dest, "checkout", "-q", "--detach", "FETCH_HEAD")
    got = _git(dest, "rev-parse", "HEAD")
    if got != corpus.sha:
        raise SystemExit(f"{corpus.key}: fetched {got}, expected {corpus.sha}")
    return dest


def _matches(corpus: Corpus, path: str) -> bool:
    p = PurePosixPath(path)
    if any(x in p.stem.lower() for x in corpus.exclude_stems):
        return False
    pattern = corpus.include
    if "/" in pattern:
        prefix, suffix = pattern.rsplit("/", 1)
        return path.startswith(prefix + "/") and p.match(suffix)
    return p.match(pattern)


def collect(corpus: Corpus, root: Path) -> list[dict]:
    """Every prompt file at the pinned commit, read from its git blob."""
    listing = _git(root, "ls-tree", "-r", "-z", "HEAD", binary=True)
    entries = []
    for record in listing.split(b"\0"):
        if not record:
            continue
        meta, path = record.split(b"\t", 1)
        _mode, kind, oid = meta.decode().split()
        path_s = path.decode("utf-8")
        if kind == "blob" and _matches(corpus, path_s):
            entries.append((path_s, oid))
    blobs = _read_blobs(root, [oid for _, oid in entries])
    files = []
    for path, oid in sorted(entries):
        raw = blobs[oid]
        text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        if len(text.split()) < MIN_WORDS:
            continue
        files.append({"path": path, "oid": oid, "raw": raw, "text": text})
    return files


def _read_blobs(root: Path, oids: list[str]) -> dict[str, bytes]:
    out = _git(root, "cat-file", "--batch", binary=True, stdin=("\n".join(oids) + "\n").encode())
    blobs: dict[str, bytes] = {}
    pos = 0
    while pos < len(out):
        nl = out.index(b"\n", pos)
        oid, _kind, size = out[pos:nl].decode().split()
        start = nl + 1
        blobs[oid] = out[start : start + int(size)]
        pos = start + int(size) + 1
    return blobs


# ─── scoring ──────────────────────────────────────────────────────────


def score_text(text: str) -> tuple[int, dict[str, int], set[str]]:
    lowered = text.lower()
    dims: dict[str, int] = {}
    fired: set[str] = set()
    for dimension, patterns in SCORER_MAP.items():
        matched = {rid for rid, _, _ in _match_patterns(lowered, patterns)}
        covered = covered_concepts(dimension, matched)
        fired.update(c.key for c in covered)
        total = len(CONCEPTS[dimension])
        k = len(covered)
        dims[dimension] = 0 if not k else (100 * k + total // 2) // total
    return overall_score(dims), dims, fired


def build_rows(corpus: Corpus, root: Path, files: list[dict]) -> list[dict]:
    commit_date = _git(root, "log", "-1", "--format=%cs", "HEAD")
    rows = []
    for f in files:
        score, dims, fired = score_text(f["text"])
        row = {
            "prompt_id": hashlib.sha256(f["path"].encode("utf-8")).hexdigest()[:16],
            "source_category": corpus.key,
            "source_collection": corpus.repo,
            "upstream_commit": corpus.sha,
            "upstream_commit_date": commit_date,
            "upstream_path": f["path"],
            "source_url": f"{corpus.url}/blob/{corpus.sha}/{quote(f['path'])}",
            "collection_date": corpus.collected,
            "git_blob_sha1": f["oid"],
            "content_sha256": hashlib.sha256(f["raw"]).hexdigest(),
            "text_bytes": len(f["text"].encode("utf-8")),
            "word_count": len(f["text"].split()),
            "score": score,
            "controls_stated": len(fired),
        }
        row.update({f"dim_{d}": dims[d] for d in DIMENSIONS})
        row.update({k: int(k in fired) for k in CONTROL_KEYS})
        rows.append(row)
    return rows


# ─── statistics (identical to the original harness) ───────────────────


def _midranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def cliffs_delta(a: list[float], b: list[float]) -> float:
    n1, n2 = len(a), len(b)
    if not n1 or not n2:
        return 0.0
    ranks = _midranks(a + b)
    u1 = sum(ranks[:n1]) - n1 * (n1 + 1) / 2.0
    return 2.0 * u1 / (n1 * n2) - 1.0


def permutation_p(a: list[float], b: list[float], rng: random.Random) -> float:
    n1, n2 = len(a), len(b)
    observed = abs(cliffs_delta(a, b))
    pooled = _midranks(a + b)
    denom = n1 * n2
    offset = n1 * (n1 + 1) / 2.0
    extreme = 0
    for _ in range(RESAMPLES):
        rng.shuffle(pooled)
        u1 = sum(pooled[:n1]) - offset
        if abs(2.0 * u1 / denom - 1.0) >= observed - 1e-12:
            extreme += 1
    return (extreme + 1) / (RESAMPLES + 1)


def bootstrap_ci(a: list[float], b: list[float], rng: random.Random) -> tuple[float, float]:
    deltas = []
    for _ in range(RESAMPLES):
        ra = [a[rng.randrange(len(a))] for _ in range(len(a))]
        rb = [b[rng.randrange(len(b))] for _ in range(len(b))]
        deltas.append(cliffs_delta(ra, rb))
    deltas.sort()
    lo = deltas[int((ALPHA / 2) * len(deltas))]
    hi = deltas[min(len(deltas) - 1, int((1 - ALPHA / 2) * len(deltas)))]
    return lo, hi


def describe(values: list[float]) -> dict:
    s = sorted(values)
    n = len(s)
    zeros = sum(1 for v in s if v == 0)
    return {
        "n": n,
        "median": statistics.median(s),
        "q1": s[n // 4],
        "q3": s[(3 * n) // 4],
        "mean": round(statistics.fmean(s), 2),
        "zeros": zeros,
        "zero_rate_pct": round(100 * zeros / n, 1),
        "max": s[-1],
        "at_or_above_50": sum(1 for v in s if v >= 50),
    }


def analyse(prod: list[float], store: list[float]) -> dict:
    delta = cliffs_delta(prod, store)
    p = permutation_p(prod, store, random.Random(SEED))
    lo, hi = bootstrap_ci(prod, store, random.Random(SEED + 1))
    nz_prod = [v for v in prod if v > 0]
    nz_store = [v for v in store if v > 0]
    return {
        "statistic": "Cliff's delta (Mann-Whitney U identity, midranks for ties)",
        "significance_test": (
            f"two-sided permutation test on Cliff's delta, {RESAMPLES} relabelings, "
            f"seed {SEED}, add-one corrected"
        ),
        "interval_method": (
            f"percentile bootstrap on the same statistic, {RESAMPLES} resamples "
            f"within groups, seed {SEED + 1}"
        ),
        "delta": round(delta, 3),
        "p_value": round(p, 4),
        "ci95": [round(lo, 3), round(hi, 3)],
        "alpha": ALPHA,
        "zero_floor_sensitivity": {
            "n_production": len(nz_prod),
            "n_gpt_store": len(nz_store),
            "delta": round(cliffs_delta(nz_prod, nz_store), 3),
            "p": round(permutation_p(nz_prod, nz_store, random.Random(SEED + 2)), 4),
        },
    }


def control_table(rows: list[dict]) -> list[dict]:
    table = []
    for key in CONTROL_KEYS:
        entry = {
            "control": key,
            "dimension": CONTROL_DIMENSION[key],
            "label": CONTROL_LABEL[key],
            "rule_ids": " ".join(CONTROL_RULES[key]),
        }
        for c in CORPORA:
            group = [r for r in rows if r["source_category"] == c.key]
            hits = sum(r[key] for r in group)
            entry[f"{c.key}_hits"] = hits
            entry[f"{c.key}_n"] = len(group)
            entry[f"{c.key}_pct"] = round(100 * hits / len(group), 1)
        table.append(entry)
    return table


def probe_absence(texts: list[str]) -> dict[str, dict]:
    lowered = [" ".join(t.lower().split()) for t in texts]
    out = {}
    for control, patterns in ABSENCE_PROBES.items():
        compiled = [re.compile(p, re.IGNORECASE) for p in patterns]
        hits = sum(1 for t in lowered if any(c.search(t) for c in compiled))
        out[control] = {"hits": hits, "n": len(lowered), "patterns": len(patterns)}
    return out


# ─── outputs ──────────────────────────────────────────────────────────


def _csv(fields: list[str], rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow({k: r[k] for k in fields})
    return buf.getvalue()


def render_results(summary: dict, controls: list[dict]) -> str:
    g = summary["groups"]
    a = summary["analysis"]
    s = a["zero_floor_sensitivity"]
    total = summary["prompts"]
    lines = [
        "<!-- GENERATED by scoring/score.py. Do not edit by hand; run the script. -->",
        "",
        "# Results",
        "",
        f"Dataset `{DATASET_VERSION}` · ruleset `{RULESET_ID}` · {total} prompts.",
        "Every number on this page is written by `scoring/score.py`, and "
        "`python scoring/score.py --check` fails if it drifts from a fresh run.",
        "",
        "Coverage records which of 23 safeguards a prompt's **text** states. It "
        "does not measure how well a prompt is written or how the agent behaves "
        "at runtime.",
        "",
        "## Score distribution (0-100)",
        "",
        "| Source | n | Median | IQR | Mean | Scored 0 | Max | Scored 50+ |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for c in CORPORA:
        d = g[c.key]
        lines.append(
            f"| {c.label} | {d['n']} | {d['median']} | {d['q1']}-{d['q3']} | {d['mean']} | "
            f"{d['zeros']}/{d['n']} ({d['zero_rate_pct']}%) | {d['max']} | "
            f"{d['at_or_above_50']}/{d['n']} |"
        )
    lines += [
        "",
        "## Do production prompts write down more safeguards?",
        "",
        f"- {a['statistic']}: **{a['delta']}**, 95% CI [{a['ci95'][0]}, {a['ci95'][1]}]",
        f"- Significance: {a['significance_test']}: *p* = {a['p_value']}",
        f"- Interval: {a['interval_method']}",
        f"- Zero-floor check (scores above 0 only; n = {s['n_production']} production, "
        f"{s['n_gpt_store']} GPT Store): delta = {s['delta']}, *p* = {s['p']}",
        "",
        "## Per-control coverage",
        "",
        "| Control | Dimension | Production | GPT Store |",
        "| --- | --- | ---: | ---: |",
    ]
    for r in controls:
        lines.append(
            f"| {r['label']} (`{r['control']}`) | {r['dimension']} | "
            f"{r['production_hits']}/{r['production_n']} ({r['production_pct']}%) | "
            f"{r['gpt_store_hits']}/{r['gpt_store_n']} ({r['gpt_store_pct']}%) |"
        )
    dead = summary["never_fired"]
    lines += [
        "",
        f"## Controls no prompt stated ({len(dead)} of {len(CONTROL_KEYS)})",
        "",
        "Each was re-checked with deliberately looser patterns that never affect "
        "a score, to separate \"absent\" from \"the rules are too narrow\".",
        "",
        "| Control | Shipped rules | Looser probe |",
        "| --- | ---: | ---: |",
    ]
    for key in dead:
        pr = summary["probes"].get(key)
        probe = f"{pr['hits']}/{pr['n']} ({pr['patterns']} patterns)" if pr else "no probe"
        lines.append(f"| {CONTROL_LABEL[key]} (`{key}`) | 0/{total} | {probe} |")
    lines += [
        "",
        "## Sources",
        "",
        "| Source | Prompts | Collection | Pinned commit | Commit date | Collected |",
        "| --- | ---: | --- | --- | --- | --- |",
    ]
    for c in summary["sources"]:
        lines.append(
            f"| {c['label']} | {c['prompts']} | [{c['repo']}]({c['url']}) | "
            f"`{c['commit'][:12]}` | {c['commit_date']} | {c['collected']} |"
        )
    lines += [
        "",
        f"Self-checks passed: {summary['self_checks']}. No prompt text is stored in "
        "this repository; the scan that enforces this is described in "
        "[METHODOLOGY.md](METHODOLOGY.md).",
        "",
    ]
    return "\n".join(lines)


def render_chart(controls: list[dict]) -> str:
    rows = sorted(controls, key=lambda r: (-r["production_pct"], -r["gpt_store_pct"], r["label"]))
    label_w, bar_w, row_h, top, left_pad = 330, 420, 26, 92, 16
    width = left_pad + label_w + bar_w + 80
    height = top + row_h * len(rows) + 54
    colors = {"production": "#2563eb", "gpt_store": "#f59e0b"}
    n_prod = controls[0]["production_n"]
    n_store = controls[0]["gpt_store_n"]
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="t d" '
        'font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">',
        "<title id=\"t\">Share of AI system prompts that state each of 23 safeguards</title>",
        f"<desc id=\"d\">Per-control share of {n_prod} production agent prompts and "
        f"{n_store} GPT Store prompts whose text states the safeguard. Coverage of "
        "written text only, not runtime behaviour.</desc>",
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="{left_pad}" y="30" font-size="18" font-weight="700" fill="#0f172a">'
        "Which safeguards do AI system prompts write down?</text>",
        f'<text x="{left_pad}" y="52" font-size="13" fill="#475569">Share of prompts whose '
        f"text states each control · {n_prod} production agents vs {n_store} GPT Store "
        "prompts</text>",
        f'<rect x="{left_pad}" y="64" width="12" height="12" fill="{colors["production"]}"/>',
        f'<text x="{left_pad + 18}" y="75" font-size="12" fill="#0f172a">Production agents (n={n_prod})</text>',
        f'<rect x="{left_pad + 210}" y="64" width="12" height="12" fill="{colors["gpt_store"]}"/>',
        f'<text x="{left_pad + 228}" y="75" font-size="12" fill="#0f172a">GPT Store (n={n_store})</text>',
    ]
    x0 = left_pad + label_w
    scale = bar_w / 50.0  # axis to 50%: the highest rate is 42.2%
    for tick in (0, 10, 20, 30, 40, 50):
        x = x0 + tick * scale
        out.append(f'<line x1="{x:.1f}" y1="{top - 6}" x2="{x:.1f}" y2="{top + row_h * len(rows)}" stroke="#e2e8f0"/>')
        out.append(f'<text x="{x:.1f}" y="{top + row_h * len(rows) + 16}" font-size="11" fill="#64748b" text-anchor="middle">{tick}%</text>')
    for i, r in enumerate(rows):
        y = top + i * row_h
        label = r["label"].replace("&", "&amp;")
        out.append(f'<text x="{x0 - 10}" y="{y + 16}" font-size="12" fill="#0f172a" text-anchor="end">{label}</text>')
        for j, key in enumerate(("production", "gpt_store")):
            pct = r[f"{key}_pct"]
            w = max(pct * scale, 0)
            by = y + 4 + j * 9
            out.append(f'<rect x="{x0}" y="{by}" width="{w:.1f}" height="8" fill="{colors[key]}"/>')
            out.append(f'<text x="{x0 + w + 4:.1f}" y="{by + 7.5}" font-size="9.5" fill="#334155">{r[key + "_hits"]}/{r[key + "_n"]}</text>')
    out.append(
        f'<text x="{left_pad}" y="{height - 12}" font-size="11" fill="#64748b">Ruleset {RULESET_ID} · '
        "github.com/shmindmaster/agent-prompt-safeguards-2026 · CC BY 4.0</text>"
    )
    out.append("</svg>")
    return "\n".join(out) + "\n"


# ─── self-checks ──────────────────────────────────────────────────────


def _window_hashes(text: str, width: int):
    if len(text) < width:
        return
    base, mask = 257, (1 << 64) - 1
    lead = pow(base, width - 1, 1 << 64)
    value = 0
    for ch in text[:width]:
        value = (value * base + ord(ch)) & mask
    yield 0, value
    for start in range(1, len(text) - width + 1):
        value = (((value - ord(text[start - 1]) * lead) * base) + ord(text[start + width - 1])) & mask
        yield start, value


def _forms(text: str) -> tuple[str, ...]:
    base = tuple(dict.fromkeys((text, " ".join(text.split()))))
    forms = list(base)
    for b in base:
        for ascii_ in (True, False):
            forms.append(json.dumps(b, ensure_ascii=ascii_)[1:-1])
    return tuple(dict.fromkeys(forms))


def first_leak(artifacts: list[str], texts: list[str]) -> str | None:
    hashes = {v for blob in artifacts for _, v in _window_hashes(blob, LEAK_WINDOW)}
    for text in texts:
        for form in _forms(text):
            for start, v in _window_hashes(form, LEAK_WINDOW):
                if v in hashes:
                    window = form[start : start + LEAK_WINDOW]
                    if any(window in blob for blob in artifacts):
                        return window
    return None


def self_check(rows: list[dict], controls: list[dict], summary: dict) -> list[str]:
    errs = []
    ids = [r["prompt_id"] for r in rows]
    if len(set(ids)) != len(ids):
        errs.append("duplicate prompt_id")
    for r in rows:
        dims = {d: r[f"dim_{d}"] for d in DIMENSIONS}
        if overall_score(dims) != r["score"]:
            errs.append(f"{r['prompt_id']}: score is not the mean of its dimensions")
        if sum(r[k] for k in CONTROL_KEYS) != r["controls_stated"]:
            errs.append(f"{r['prompt_id']}: controls_stated mismatch")
        if not 0 <= r["score"] <= 100:
            errs.append(f"{r['prompt_id']}: score out of range")
    for c in controls:
        for key in ("production", "gpt_store"):
            n, hits, pct = c[f"{key}_n"], c[f"{key}_hits"], c[f"{key}_pct"]
            if not 0 <= hits <= n or abs(pct - 100 * hits / n) > 0.05:
                errs.append(f"{c['control']}/{key}: impossible rate")
    a = summary["analysis"]
    lo, hi = a["ci95"]
    if (a["p_value"] < ALPHA) != (lo > 0 or hi < 0):
        errs.append("p-value and confidence interval disagree")
    for key, d in summary["groups"].items():
        if not d["q1"] <= d["median"] <= d["q3"]:
            errs.append(f"{key}: quartiles out of order")
    return errs


# ─── main ─────────────────────────────────────────────────────────────


def build(offline: bool) -> tuple[dict[Path, str], list[str], list[str]]:
    rows: list[dict] = []
    texts: list[str] = []
    sources = []
    for c in CORPORA:
        root = fetch(c, offline=offline)
        files = collect(c, root)
        if not files:
            raise SystemExit(f"{c.key}: no prompt files matched")
        print(f"{c.key}: {len(files)} prompts @ {c.sha[:12]}", file=sys.stderr)
        texts.extend(f["text"] for f in files)
        corpus_rows = build_rows(c, root, files)
        rows.extend(corpus_rows)
        sources.append(
            {
                "key": c.key,
                "label": c.label,
                "repo": c.repo,
                "url": c.url,
                "commit": c.sha,
                "commit_date": corpus_rows[0]["upstream_commit_date"],
                "collected": c.collected,
                "include": c.include,
                "prompts": len(corpus_rows),
                "license_note": c.license_note,
            }
        )

    prod = [r["score"] for r in rows if r["source_category"] == "production"]
    store = [r["score"] for r in rows if r["source_category"] == "gpt_store"]
    controls = control_table(rows)
    summary = {
        "dataset_version": DATASET_VERSION,
        "ruleset": RULESET_ID,
        "prompts": len(rows),
        "max_score_any_prompt": max(r["score"] for r in rows),
        "sources": sources,
        "groups": {"production": describe(prod), "gpt_store": describe(store)},
        "analysis": analyse(prod, store),
        "never_fired": [c["control"] for c in controls if not c["production_hits"] and not c["gpt_store_hits"]],
        "probes": probe_absence(texts),
        "disclaimer": (
            "Coverage counts which of 23 safeguards the prompt TEXT states. It is not "
            "quality, not safety, not certification, and not evidence of runtime "
            "behaviour. A low score means the text is silent on a control, not that "
            "the product lacks it."
        ),
    }
    errs = self_check(rows, controls, summary)
    summary["self_checks"] = len(rows) * 3 + len(controls) * 2 + len(summary["groups"]) + 2

    outputs = {
        PROMPTS_CSV: _csv(ROW_FIELDS, rows),
        CONTROLS_CSV: _csv(list(controls[0]), controls),
        SUMMARY_JSON: json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        RESULTS_MD: render_results(summary, controls),
        CHART_SVG: render_chart(controls),
    }
    scan_fields = [f for f in ROW_FIELDS if f not in IDENTIFIER_FIELDS]
    scan_artifacts = [_csv(scan_fields, rows)] + [v for k, v in outputs.items() if k != PROMPTS_CSV]
    leak = first_leak(scan_artifacts, texts)
    if leak is not None:
        errs.append(
            f"output contains {LEAK_WINDOW}+ chars of prompt text "
            f"(window sha256:{hashlib.sha256(leak.encode()).hexdigest()[:16]})"
        )
    return outputs, errs, texts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="reuse the .cache/ checkout")
    ap.add_argument("--check", action="store_true", help="fail if committed files differ from a fresh run")
    args = ap.parse_args()

    outputs, errs, _ = build(args.offline)
    if errs:
        print("SELF-CHECK FAILED; nothing written:", file=sys.stderr)
        for e in errs[:20]:
            print(f"  - {e}", file=sys.stderr)
        return 2
    if args.check:
        stale = [p for p, body in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != body]
        for p in stale:
            print(f"stale: {p.relative_to(REPO)}", file=sys.stderr)
        if stale:
            return 1
        print("all generated files match a fresh run")
        return 0
    for path, body in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(REPO)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
