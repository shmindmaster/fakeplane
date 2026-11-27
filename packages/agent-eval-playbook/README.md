# Agent Evaluation Playbook

How production AI agents actually get judged — a short playbook plus a runnable,
dependency-free eval harness. Methodology distilled from production agent
platforms running tens of thousands of tickets and 90,000+ agent runs per
30-day window; all data here is synthetic.

**The thesis:** demo quality is not evidence. An agent earns the right to ship
past a gate made of measured things: golden sets, outcome labels, shadow-mode
comparisons, and run-completion — not vibes.

## Contents

| Path | What it is |
|---|---|
| `playbook.md` | The methodology: golden sets, outcome labeling, shadow mode, release gates, cost ledgers |
| `harness/run_evals.py` | A ~200-line, zero-dependency eval runner (Python 3.9+, stdlib only) |
| `examples/support_triage.json` | A golden set for support-ticket triage (synthetic) |
| `examples/tool_call_validity.json` | Golden set for JSON tool-call validity (synthetic) |

## Quick start

Run the suites against the built-in echo/stub target (tests the harness itself):

```bash
python harness/run_evals.py examples/ --target stub
```

Run them against any OpenAI-compatible chat endpoint:

```bash
set OPENAI_BASE_URL=...      # or OPENAI_API_BASE
set OPENAI_API_KEY=***
python harness/run_evals.py examples/ --target openai --model <model>
```

You get per-case pass/fail, **run completion** (did the run finish validly —
distinct from task success), check-type breakdown, and a machine-readable
`results.json`.

## Checks included

- `exact`, `contains_any`, `contains_all`, `regex` — text outcomes
- `json_valid` + `json_field` — tool-call shape and field correctness
- `max_len` — output discipline

## What the gate looks like in practice

1. New behavior never touches customers until it passes its golden set.
2. Candidates run **shadow-mode** against live traffic; the incumbent stays serving.
3. Promotion requires measured parity or better on completion **and** success,
   with cost per resolved ticket inside ledger bounds.
4. Every consequential write stays behind an approval lane regardless of score.

Methodology and harness by Sarosh Hussain ([github.com/shmindmaster](https://github.com/shmindmaster)).
Synthetic data only; no client content.
