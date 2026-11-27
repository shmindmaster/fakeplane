"""The replyonce state machine.

A line-for-line port of ``src/logic.ts``. Every function is pure: it takes a scope's state
(a JSON-compatible dict, the same shape the TypeScript package stores) and returns
``(next_state_or_None, result)``. Stores only make each call atomic.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Optional

SUMMARY_MAX = 2000

State = dict
Run = dict
Effect = dict


@dataclass(frozen=True)
class Policy:
    pending_ttl_ms: int
    max_attempts: int
    retention_ms: int


def empty_state() -> State:
    return {"v": 1, "seq": 0, "tokenSeq": 0, "runs": {}, "effects": {}}


def _load(state: Optional[State], now: int, policy: Policy) -> State:
    s = copy.deepcopy(state) if state else empty_state()
    if s.get("v") != 1:
        raise ValueError(f"replyonce: unsupported state version {s.get('v')!r}")
    horizon = now - policy.retention_ms
    for k in list(s["effects"].keys()):
        e = s["effects"][k]
        settled = e["settledAt"] if e["settledAt"] is not None else e["claimedAt"]
        if e["status"] in ("committed", "failed") and settled < horizon:
            del s["effects"][k]
    for rid in list(s["runs"].keys()):
        r = s["runs"][rid]
        last = r["endedAt"] if r["endedAt"] is not None else r["leaseExpiresAt"]
        if last < horizon:
            del s["runs"][rid]
    return s


def _tick(s: State) -> int:
    s["seq"] += 1
    return s["seq"]


def is_abandoned(e: Effect, now: int, policy: Policy) -> bool:
    return e["status"] == "pending" and now - e["claimedAt"] >= policy.pending_ttl_ms


def effective_status(e: Effect, now: int, policy: Policy) -> str:
    return "ambiguous" if is_abandoned(e, now, policy) else e["status"]


def _is_live(r: Run, now: int) -> bool:
    return r["endedAt"] is None and r["leaseExpiresAt"] > now


def _is_newer(a: Run, b: Run) -> bool:
    # Never order supersede-mode runs by token: a redelivery bumps an old run's token.
    if a["mode"] == "exclusive" and b["mode"] == "exclusive":
        return a["token"] > b["token"]
    if a["orderAt"] != b["orderAt"]:
        return a["orderAt"] > b["orderAt"]
    # Equal context times order by begin only if neither run gave a contextAt (each read its
    # context as it began). Otherwise neither is newer: fencing out the wrong one would leave
    # its message unanswered. Both may write; conflict checks prevent double answers.
    if a["baseContextAt"] is not None or b["baseContextAt"] is not None:
        return False
    return a["baseSeq"] > b["baseSeq"]


def superseding_run(s: State, run: Run, now: int) -> Optional[Run]:
    best = None
    for r in s["runs"].values():
        if r["runId"] == run["runId"] or r["endReason"] == "cancelled" or not _is_newer(r, run):
            continue
        if r["wrote"] or _is_live(r, now):
            if best is None or _is_newer(r, best):
                best = r
    return best


def _mark_seen(run: Run, seq: int, now: int) -> None:
    run["seenSeq"] = max(run["seenSeq"], seq)
    run["seenAt"] = max(run["seenAt"], now)
    run["contextAt"] = None


# ------------------------------------------------------------------ begin


def begin(
    state: Optional[State],
    *,
    run_id: str,
    mode: str,
    lease_ttl_ms: int,
    now: int,
    context_at: Optional[int],
    policy: Policy,
) -> tuple[Optional[State], dict]:
    s = _load(state, now, policy)
    existing = s["runs"].get(run_id)
    if existing is not None:
        prior = [e for e in s["effects"].values() if e["runId"] == run_id]
        if existing["endedAt"] is not None:
            return None, {"state": "ended", "run": existing, "priorEffects": prior}
        existing["leaseExpiresAt"] = max(existing["leaseExpiresAt"], now + lease_ttl_ms)
        _tick(s)
        s["tokenSeq"] += 1
        existing["token"] = s["tokenSeq"]
        existing["seenSeq"] = existing["baseSeq"]
        existing["seenAt"] = existing["baseContextAt"] if existing["baseContextAt"] is not None else existing["startedAt"]
        existing["contextAt"] = existing["baseContextAt"]
        if context_at is not None and context_at > existing["seenAt"]:
            fresh = min(context_at, now)
            for e in s["effects"].values():
                if e["settleSeq"] is not None and e["settledAt"] is not None and e["settledAt"] < fresh:
                    existing["seenSeq"] = max(existing["seenSeq"], e["settleSeq"])
            existing["seenAt"] = fresh
            existing["contextAt"] = fresh
        newer = superseding_run(s, existing, now)
        return s, {"state": "superseded" if newer else "resumed", "run": existing, "priorEffects": prior}

    if mode == "exclusive":
        holder = None
        for r in s["runs"].values():
            if _is_live(r, now) and (holder is None or r["token"] > holder["token"]):
                holder = r
        if holder is not None:
            return None, {
                "state": "busy",
                "holder": {"runId": holder["runId"], "token": holder["token"], "leaseExpiresAt": holder["leaseExpiresAt"]},
            }

    seq = _tick(s)
    s["tokenSeq"] += 1
    ctx = None if context_at is None else min(context_at, now)
    run = {
        "runId": run_id,
        "token": s["tokenSeq"],
        "mode": mode,
        "startedAt": now,
        "orderAt": now if mode == "exclusive" else (ctx if ctx is not None else now),
        "leaseExpiresAt": now + lease_ttl_ms,
        "seenSeq": seq,
        "seenAt": ctx if ctx is not None else now,
        "contextAt": ctx,
        "baseSeq": seq,
        "baseContextAt": ctx,
        "wrote": False,
        "endedAt": None,
        "endReason": None,
    }
    s["runs"][run_id] = run
    newer = superseding_run(s, run, now)
    return s, {"state": "superseded" if newer else "new", "run": run, "priorEffects": []}


# ------------------------------------------------------------------ heartbeat / end


def renew(state, *, run_id: str, token: int, lease_ttl_ms: int, now: int, policy: Policy):
    s = _load(state, now, policy)
    r = s["runs"].get(run_id)
    if r is None:
        return None, {"ok": False, "reason": "unknown_run"}
    if r["token"] != token:
        return None, {"ok": False, "reason": "superseded"}
    if r["endReason"] == "cancelled":
        return None, {"ok": False, "reason": "run_cancelled"}
    if r["endedAt"] is not None:
        return None, {"ok": False, "reason": "run_ended"}
    if superseding_run(s, r, now):
        return None, {"ok": False, "reason": "superseded"}
    r["leaseExpiresAt"] = max(r["leaseExpiresAt"], now + lease_ttl_ms)
    _tick(s)
    return s, {"ok": True, "run": r}


def end_run(state, *, run_id: str, reason: str, now: int, policy: Policy, token: Optional[int] = None):
    s = _load(state, now, policy)
    r = s["runs"].get(run_id)
    if r is None:
        return None, None
    if token is not None and r["token"] != token:
        return None, None
    if r["endedAt"] is not None and not (reason == "cancelled" and r["endReason"] != "cancelled"):
        return None, r
    r["endedAt"] = r["endedAt"] if r["endedAt"] is not None else now
    r["endReason"] = reason
    _tick(s)
    return s, r


# ------------------------------------------------------------------ claim


def conflicts_for(s: State, run: Run, key: str, intent: str, mode: str, now: int, policy: Policy) -> list[dict]:
    if mode == "none":
        return []
    out = []
    for e in s["effects"].values():
        if e["key"] == key:
            continue
        if e["runId"] == run["runId"]:
            if e["token"] == run["token"] or e["intent"] != intent:
                continue
        if mode == "same-intent" and e["intent"] != intent:
            continue
        abandoned = is_abandoned(e, now, policy)
        conflict = False
        if e["status"] == "pending" and not abandoned:
            conflict = True
        elif abandoned:
            conflict = e["claimedAt"] + policy.pending_ttl_ms >= run["seenAt"]
        elif e["status"] in ("committed", "ambiguous"):
            conflict = (e["settleSeq"] or 0) > run["seenSeq"] or (
                run["contextAt"] is not None and (e["settledAt"] or 0) >= run["contextAt"]
            )
        if conflict:
            out.append(
                {
                    "key": e["key"],
                    "intent": e["intent"],
                    "status": "ambiguous" if abandoned else e["status"],
                    "runId": e["runId"],
                    "summary": e["summary"],
                    "at": e["settledAt"] if e["settledAt"] is not None else e["claimedAt"],
                }
            )
    out.sort(key=lambda c: c["at"])
    return out[:10]


def claim(
    state,
    scope: str,
    *,
    key: str,
    intent: str,
    summary: Optional[str],
    run_id: Optional[str],
    token: Optional[int],
    attempt_id: str,
    conflict: str,
    ack: bool,
    lease_ttl_ms: int,
    now: int,
    policy: Policy,
):
    s = _load(state, now, policy)
    prior = s["effects"].get(key)

    if prior is not None:
        if prior["status"] == "committed":
            return None, {"kind": "replay", "entry": prior}
        if prior["status"] == "pending":
            if not is_abandoned(prior, now, policy):
                return None, {"kind": "in_flight", "entry": prior}
            seq = _tick(s)
            prior["status"] = "ambiguous"
            prior["settledAt"] = prior["claimedAt"] + policy.pending_ttl_ms
            prior["settleSeq"] = seq
            prior["error"] = prior["error"] or "abandoned: not settled within pendingTtlMs"
            return s, {"kind": "ambiguous", "entry": prior}
        if prior["status"] == "ambiguous":
            return None, {"kind": "ambiguous", "entry": prior}
        if prior["attempt"] >= policy.max_attempts:
            return None, {"kind": "refused", "reason": "exhausted", "entry": prior}

    run = None
    if run_id is not None:
        run = s["runs"].get(run_id)
        if run is None:
            return None, {"kind": "refused", "reason": "unknown_run"}
        if run["endReason"] == "cancelled":
            return None, {"kind": "refused", "reason": "run_cancelled"}
        if run["endedAt"] is not None:
            return None, {"kind": "refused", "reason": "run_ended"}
        if (token is not None and run["token"] != token) or superseding_run(s, run, now):
            return None, {"kind": "refused", "reason": "superseded"}
        found = conflicts_for(s, run, key, intent, conflict, now, policy)
        if found:
            if not ack:
                return None, {"kind": "refused", "reason": "conversation_changed", "conflicts": found}
            _mark_seen(run, _tick(s), now)
            return s, {"kind": "refused", "reason": "conversation_changed", "conflicts": found}

    seq = _tick(s)
    entry = {
        "key": key,
        "scope": scope,
        "intent": intent,
        "status": "pending",
        "attempt": (prior["attempt"] if prior else 0) + 1,
        "attemptId": attempt_id,
        "runId": run_id,
        "token": run["token"] if run else None,
        "summary": None if summary is None else summary[:SUMMARY_MAX],
        "error": None,
        "createdAt": prior["createdAt"] if prior else now,
        "claimedAt": now,
        "settledAt": None,
        "claimSeq": seq,
        "settleSeq": None,
    }
    s["effects"][key] = entry
    if run is not None:
        # A claim does not mark anything seen: writes this check deliberately skipped (other
        # intents, or "none") must still be reported to a later check that covers them.
        run["wrote"] = True
        run["leaseExpiresAt"] = max(run["leaseExpiresAt"], now + lease_ttl_ms)
    return s, {"kind": "acquired", "entry": entry}


# ------------------------------------------------------------------ settle / resolve

_UNSET: Any = object()


def settle(state, *, key: str, attempt_id: str, outcome: str, now: int, policy: Policy, result: Any = _UNSET, error: Optional[str] = None):
    s = _load(state, now, policy)
    e = s["effects"].get(key)
    late_truth = e is not None and e["status"] == "failed" and outcome == "committed"
    if e is None or e["attemptId"] != attempt_id or (e["status"] not in ("pending", "ambiguous") and not late_truth):
        return None, {"kind": "stale", "entry": e}
    was_abandoned = e["status"] != "pending" or is_abandoned(e, now, policy)
    e["status"] = outcome
    e["settledAt"] = now
    e["settleSeq"] = _tick(s)
    e["error"] = error
    if outcome == "committed" and result is not _UNSET:
        e["result"] = result
    return s, {"kind": "settled", "entry": e, "wasAbandoned": was_abandoned}


def resolve(state, *, key: str, outcome: str, now: int, policy: Policy, result: Any = _UNSET, attempt_id: Optional[str] = None):
    s = _load(state, now, policy)
    e = s["effects"].get(key)
    if e is None:
        return None, None
    if attempt_id is not None and e["attemptId"] != attempt_id:
        return None, None
    if effective_status(e, now, policy) != "ambiguous":
        return None, None
    e["settledAt"] = now
    e["settleSeq"] = _tick(s)
    if outcome == "committed":
        e["status"] = "committed"
        e["error"] = None
        if result is not _UNSET:
            e["result"] = result
    else:
        e["status"] = "failed"
        e["error"] = "reconciled: not applied"
    return s, e
