#!/usr/bin/env python3
"""Minimal production-style eval harness for LLM/agent behaviors.

Zero dependencies (Python 3.9+ stdlib). Distinguishes RUN COMPLETION from
TASK SUCCESS, reports a per-check breakdown, and writes results.json.

Usage:
  python run_evals.py <suite_dir_or_file>... [--target stub|openai]
                      [--model MODEL] [--out results.json]

OpenAI-compatible targets use OPENAI_BASE_URL (or OPENAI_API_BASE) and
OPENAI_API_KEY from the environment.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path


def call_openai(prompt: str, model: str):
    base = os.environ.get("OPENAI_BASE_URL") or os.environ.get("OPENAI_API_BASE") \
        or "https://api.openai.com/v1"
    key = os.environ.get("OPENAI_API_KEY", "")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    choice = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return choice, usage


def call_stub(prompt: str):
    """Deterministic echo target: echoes the prompt. Useful to exercise the
    harness itself; contains-style suites can be written to pass against it."""
    return prompt, {}


def run_checks(output: str, checks):
    """Return list of {check, ok} for the case's check list."""
    results = []
    for c in checks:
        kind = c.get("check")
        ok = False
        if kind == "exact":
            ok = output.strip() == c["value"].strip()
        elif kind == "contains_any":
            ok = any(v.lower() in output.lower() for v in c["values"])
        elif kind == "contains_all":
            ok = all(v.lower() in output.lower() for v in c["values"])
        elif kind == "regex":
            ok = re.search(c["pattern"], output, re.S) is not None
        elif kind == "max_len":
            ok = len(output) <= int(c["limit"])
        elif kind == "json_valid":
            try:
                json.loads(output)
                ok = True
            except Exception:
                ok = False
        elif kind == "json_field":
            try:
                obj = json.loads(output)
                cur = obj
                for part in c["path"].split("."):
                    cur = cur[part]
                ok = cur == c["value"]
            except Exception:
                ok = False
        else:
            ok = False
            results.append({"check": kind, "ok": False,
                            "note": "unknown check type"})
            continue
        results.append({"check": kind, "ok": ok})
    return results


def evaluate_suite(path: Path, target, model):
    suite = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for case in suite["cases"]:
        started = time.time()
        completed, error = False, None
        try:
            if target == "openai":
                output, usage = call_openai(case["prompt"], model)
            else:
                output, usage = call_stub(case["prompt"])
            completed = True
        except Exception as exc:  # noqa: BLE001 - completion is what we measure
            output, usage, error = "", {}, str(exc)
        checks = run_checks(output, case.get("checks", [])) if completed else []
        rows.append({
            "id": case["id"],
            "completed": completed,
            "success": completed and all(c["ok"] for c in checks) and bool(checks),
            "checks": checks,
            "error": error,
            "ms": int((time.time() - started) * 1000),
            "usage": usage,
        })
    return suite.get("suite", path.stem), rows


def summarize(name, rows):
    n = len(rows)
    done = sum(1 for r in rows if r["completed"])
    succ = sum(1 for r in rows if r["success"])
    per_check = {}
    for r in rows:
        for c in r["checks"]:
            k = c["check"]
            tot, ok = per_check.get(k, (0, 0))
            per_check[k] = (tot + 1, ok + (1 if c["ok"] else 0))
    return {
        "suite": name,
        "cases": n,
        "run_completion": round(100.0 * done / n, 1) if n else None,
        "task_success": round(100.0 * succ / n, 1) if n else None,
        "checks_by_type": {k: f"{ok}/{tot}" for k, (tot, ok) in per_check.items()},
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("suites", nargs="+", help="suite .json files or directories")
    ap.add_argument("--target", choices=["stub", "openai"], default="stub")
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--out", default=None, help="write machine-readable results here")
    args = ap.parse_args(argv)

    paths = []
    for s in args.suites:
        p = Path(s)
        if p.is_dir():
            paths.extend(sorted(p.glob("*.json")))
        else:
            paths.append(p)
    if not paths:
        print("no suites found", file=sys.stderr)
        return 2

    all_results, summaries = [], []
    for p in paths:
        name, rows = evaluate_suite(p, args.target, args.model)
        summ = summarize(name, rows)
        summaries.append(summ)
        all_results.extend({"suite": name, **r} for r in rows)
        print(f"[{name}] cases={summ['cases']} "
              f"completion={summ['run_completion']}% "
              f"success={summ['task_success']}% "
              f"checks={summ['checks_by_type']}")
        for r in rows:
            flag = "PASS" if r["success"] else ("INCOMPLETE" if not r["completed"] else "FAIL")
            print(f"   {flag:10s} {r['id']}")

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"summaries": summaries, "results": all_results}, indent=2),
            encoding="utf-8")
        print(f"results written: {args.out}")

    gate = all(s["run_completion"] == 100.0 and s["task_success"] == 100.0
               for s in summaries)
    print("GATE:", "PASS" if gate else "FAIL")
    return 0 if gate else 1


if __name__ == "__main__":
    sys.exit(main())
