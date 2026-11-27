# The Evaluation Playbook (production edition)

## 1. Separate completion from success

**Run completion** measures whether a run finished in a valid, well-formed
state (no crash, no timeout, schema-valid output). **Task success** measures
whether the outcome was right. Conflating them hides reliability problems
inside quality scores — a 90% "success" number means nothing if 8% of runs
never completed and were silently scored as failures by a different pipeline.

Report both, always. They have different owners and different fixes.

## 2. Golden sets, not anecdotes

- Every behavior you care about gets a frozen case set: input, expected
  outcome, the checks that decide it, and the window in which it was written.
- Cases come from three buckets, deliberately mixed: historical wins,
  historical incidents, and adversarial edge cases (empty input, hostile
  input, schema edge cases).
- Golden sets are versioned like code. A golden-set change is a reviewable
  event, because loosening a test is how regressions ship.

## 3. Outcome labeling closes the loop

Online, each resolved interaction gets a cheap label: resolved / reopened /
escalated / corrected-by-human. This is the only number that reflects reality;
offline scores are estimates of it. Label coverage and label lag are tracked
metrics in their own right.

## 4. Shadow mode before any customer sees a thing

New agent versions run against live (or replayed) traffic with outputs
recorded but not served. Compare candidate vs incumbent on completion,
success proxy, and cost. Promotion is an evidence decision with a written
rationale, not a deploy event.

## 5. Release gates are numeric and pre-agreed

A gate looks like: completion ≥ 99% on the suite AND success ≥ incumbent −
0.5pp on matched categories AND p95 latency inside budget AND cost per
resolved item inside ledger bounds. Failing one metric fails the gate;
metrics are never blended into a composite score that can launder a miss.

## 6. Cost is an eval metric

Every suite run records token/price consumption. An improvement that doubles
accuracy and triples cost is a business decision, not an engineering win, and
it should arrive pre-decided rather than discovered in the invoice.
Uninstrumented auxiliary calls (the $1k/month blind spot class of bug) are
themselves a finding the harness should surface.

## 7. Consequential writes keep an approval lane

Scores govern read paths and suggestions. Anything that refunds, tickets,
replies, or mutates state stays behind an idempotency key plus (where the
domain demands it) a human gate — no matter how the evals scored. Evals bound
confidence; they do not confer permission.

## 8. Regressions become permanent fixtures

Every production incident produces at least one new golden-set case carrying
the incident's shape, retained forever. The suite grows monotonically; the
platform's memory of its own mistakes is versioned and never deleted to make
a number look better.
