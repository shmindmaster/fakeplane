"""The replyonce API (asyncio). Mirrors the TypeScript package."""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, Optional, Protocol, TypeVar, Union

from . import _logic as logic
from ._key import MISSING, effect_key, provider_idempotency_key

T = TypeVar("T")

MAX_ROUNDS = 5


class NotApplied(Exception):
    """Raise this (or any exception with ``replyonce = "not_applied"``) when the effect definitely did not happen."""

    replyonce = "not_applied"


def default_classify_error(err: BaseException) -> str:
    if isinstance(err, NotApplied) or getattr(err, "replyonce", None) == "not_applied":
        return "not_applied"
    return "ambiguous"


class Store(Protocol):
    async def transact(self, scope: str, fn: Callable[[Optional[dict]], tuple[Optional[dict], Any]]) -> Any: ...

    async def read(self, scope: str) -> Optional[dict]: ...


@dataclass(frozen=True)
class Key:
    """A scope (usually the conversation), an intent, and the business identity of the effect."""

    scope: str
    intent: str
    payload: Any = MISSING


KeyLike = Union[str, Key, dict]


@dataclass
class EffectContext:
    key: str
    scope: str
    intent: str
    attempt: int
    idempotency_key: str
    """Stable across attempts and workers. Pass it to providers that accept an idempotency key."""
    fencing_token: Optional[int]
    deadline_ms: int
    """Epoch ms after which the claim is treated as abandoned. Finish (or give up) before it."""


@dataclass
class OnceResult(Generic[T]):
    status: str
    """executed, replayed, in_flight, ambiguous, failed or refused."""
    ok: bool
    key: str
    value: Any = None
    attempt: Optional[int] = None
    entry: Optional[dict] = None
    error: Optional[BaseException] = None
    retryable: bool = False
    reason: Optional[str] = None
    conflicts: Optional[list] = None
    late_settle: bool = False


@dataclass
class CheckResult:
    done: bool
    status: str
    entry: Optional[dict]


class ReplyOnceError(Exception):
    def __init__(self, result: OnceResult):
        detail = f"{result.status}: {result.reason}" if result.status == "refused" else result.status
        super().__init__(f"replyonce: effect {result.key} not executed ({detail})")
        self.result = result


def unwrap(result: OnceResult[T]) -> T:
    """Return the value of a successful result, or raise ``ReplyOnceError``."""
    if result.ok:
        return result.value
    raise ReplyOnceError(result)


Effect = Callable[[EffectContext], Union[Awaitable[T], T]]
Reconciler = Callable[[dict], Awaitable[dict]]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _assert_scope(scope: Any) -> None:
    if not isinstance(scope, str) or not scope or len(scope) > 512:
        raise TypeError("replyonce: scope must be a non-empty string of at most 512 characters")


def _describe(err: BaseException) -> str:
    return f"{type(err).__name__}: {err}"[:500]


class ReplyOnce:
    def __init__(
        self,
        store: Store,
        *,
        pending_ttl_ms: int = 15 * 60_000,
        max_attempts: int = 3,
        retention_ms: int = 7 * 24 * 3_600_000,
        lease_ttl_ms: int = 60_000,
        classify_error: Optional[Callable[[BaseException], str]] = None,
        reconcile: Optional[Reconciler] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        clock: Optional[Callable[[], int]] = None,
    ) -> None:
        if store is None:
            raise TypeError("replyonce: a store is required")
        if pending_ttl_ms <= 0 or max_attempts < 1 or retention_ms <= 0:
            raise ValueError("replyonce: pending_ttl_ms, max_attempts and retention_ms must be positive")
        self.store = store
        self.policy = logic.Policy(pending_ttl_ms, max_attempts, retention_ms)
        self.lease_ttl_ms = lease_ttl_ms
        self._classify = classify_error or default_classify_error
        self._reconcile = reconcile
        self._on_event = on_event
        self._now = clock or _now_ms

    # -------------------------------------------------------------- helpers

    def _emit(self, event: dict) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(event)
        except Exception:
            pass  # an observer must never change the outcome

    def resolve_key(self, key: KeyLike) -> tuple[str, str, str]:
        if isinstance(key, str):
            _assert_scope(key)
            return key, key, "once"
        if isinstance(key, dict):
            key = Key(key["scope"], key["intent"], key.get("payload", MISSING))
        _assert_scope(key.scope)
        return key.scope, effect_key(key.intent, key.payload), key.intent

    def key(self, intent: str, payload: Any = MISSING) -> str:
        return effect_key(intent, payload)

    # -------------------------------------------------------------- public API

    async def once(
        self,
        key: KeyLike,
        effect: Effect,
        *,
        summary: Optional[str] = None,
        classify_error: Optional[Callable[[BaseException], str]] = None,
        reconcile: Optional[Reconciler] = None,
        wait_ms: Optional[int] = None,
        wait_interval_ms: int = 100,
    ) -> OnceResult:
        """Run ``effect`` at most once for this key."""
        scope, ledger_key, intent = self.resolve_key(key)
        return await self._execute(
            scope, ledger_key, intent, None, effect,
            summary=summary, classify_error=classify_error, reconcile=reconcile,
            wait_ms=wait_ms, wait_interval_ms=wait_interval_ms, conflict="none", ack=False,
        )

    async def check(self, key: KeyLike) -> CheckResult:
        """Was this already done? Read-only; safe to expose to a model."""
        scope, ledger_key, _ = self.resolve_key(key)
        state = await self.store.read(scope)
        entry = (state or {}).get("effects", {}).get(ledger_key)
        if entry is None:
            return CheckResult(False, "none", None)
        status = logic.effective_status(entry, self._now(), self.policy)
        return CheckResult(status == "committed", status, entry)

    async def history(self, scope: str) -> list[dict]:
        state = await self.store.read(scope)
        if not state:
            return []
        now = self._now()
        out = [{**e, "status": logic.effective_status(e, now, self.policy)} for e in state["effects"].values()]
        return sorted(out, key=lambda e: e["createdAt"])

    async def resolve(self, key: KeyLike, outcome: str, result: Any = logic._UNSET) -> Optional[dict]:
        """Record what an operator or reconciler found out about an ambiguous effect."""
        if outcome not in ("committed", "not_applied"):
            raise ValueError("outcome must be 'committed' or 'not_applied'")
        scope, ledger_key, _ = self.resolve_key(key)
        now = self._now()
        entry = await self.store.transact(
            scope, lambda s: logic.resolve(s, key=ledger_key, outcome=outcome, now=now, policy=self.policy, result=result)
        )
        if entry is not None:
            self._emit({"type": "reconciled", "scope": scope, "key": ledger_key, "outcome": outcome})
        return entry

    async def begin(
        self,
        scope: str,
        *,
        run_id: Optional[str] = None,
        mode: str = "supersede",
        lease_ttl_ms: Optional[int] = None,
        context_at: Optional[int] = None,
    ) -> "Run":
        """Start (or, with the same ``run_id``, resume) a unit of work on a scope."""
        _assert_scope(scope)
        if mode not in ("supersede", "exclusive"):
            raise ValueError("mode must be 'supersede' or 'exclusive'")
        rid = run_id or str(uuid.uuid4())
        ttl = lease_ttl_ms if lease_ttl_ms is not None else self.lease_ttl_ms
        now = self._now()
        outcome = await self.store.transact(
            scope,
            lambda s: logic.begin(s, run_id=rid, mode=mode, lease_ttl_ms=ttl, now=now, context_at=context_at, policy=self.policy),
        )
        return Run(self, scope, rid, ttl, outcome)

    async def cancel(self, scope: str, run_id: str) -> bool:
        now = self._now()
        r = await self.store.transact(scope, lambda s: logic.end_run(s, run_id=run_id, reason="cancelled", now=now, policy=self.policy))
        return r is not None

    # -------------------------------------------------------------- internals

    async def _renew(self, scope: str, run_id: str, token: int, ttl: int) -> bool:
        now = self._now()
        r = await self.store.transact(
            scope, lambda s: logic.renew(s, run_id=run_id, token=token, lease_ttl_ms=ttl, now=now, policy=self.policy)
        )
        return r["ok"]

    async def _end(self, scope: str, run_id: str, token: int, reason: str) -> None:
        now = self._now()
        await self.store.transact(
            scope, lambda s: logic.end_run(s, run_id=run_id, reason=reason, now=now, policy=self.policy, token=token)
        )

    async def _execute(
        self,
        scope: str,
        key: str,
        intent: str,
        run: Optional[tuple[str, int, int]],
        effect: Effect,
        *,
        summary: Optional[str],
        classify_error,
        reconcile,
        wait_ms: Optional[int],
        wait_interval_ms: int,
        conflict: str,
        ack: bool,
    ) -> OnceResult:
        run_id, token, ttl = run if run else (None, None, self.lease_ttl_ms)
        classify = classify_error or self._classify
        reconciler = reconcile or self._reconcile
        wait_until = self._now() + wait_ms if wait_ms else 0
        reconciled = False

        for _ in range(MAX_ROUNDS):
            attempt_id = str(uuid.uuid4())
            now = self._now()
            claimed = await self.store.transact(
                scope,
                lambda s: logic.claim(
                    s, scope, key=key, intent=intent, summary=summary, run_id=run_id, token=token,
                    attempt_id=attempt_id, conflict=conflict, ack=ack, lease_ttl_ms=ttl, now=now, policy=self.policy,
                ),
            )
            kind = claimed["kind"]
            if kind == "replay":
                self._emit({"type": "replayed", "scope": scope, "key": key})
                return OnceResult("replayed", True, key, value=claimed["entry"].get("result"), entry=claimed["entry"])
            if kind == "refused":
                self._emit({"type": "refused", "scope": scope, "key": key, "reason": claimed["reason"], "runId": run_id})
                return OnceResult(
                    "refused", False, key, reason=claimed["reason"],
                    conflicts=claimed.get("conflicts"), entry=claimed.get("entry"),
                )
            if kind == "in_flight":
                if wait_ms and self._now() < wait_until:
                    await self._wait_for_settle(scope, key, wait_until, wait_interval_ms)
                    continue
                self._emit({"type": "in_flight", "scope": scope, "key": key})
                return OnceResult("in_flight", False, key, entry=claimed["entry"])
            if kind == "ambiguous":
                if reconciler is not None and not reconciled:
                    reconciled = True
                    try:
                        verdict = await reconciler(claimed["entry"])
                    except Exception:
                        verdict = {"outcome": "unknown"}
                    outcome = (verdict or {}).get("outcome", "unknown")
                    if outcome in ("committed", "not_applied"):
                        at = self._now()
                        res = verdict.get("result", logic._UNSET) if outcome == "committed" else logic._UNSET
                        resolved = await self.store.transact(
                            scope,
                            lambda s: logic.resolve(
                                s, key=key, outcome=outcome, now=at, policy=self.policy, result=res,
                                attempt_id=claimed["entry"]["attemptId"],
                            ),
                        )
                        if resolved is not None:
                            self._emit({"type": "reconciled", "scope": scope, "key": key, "outcome": outcome})
                        continue
                self._emit({"type": "ambiguous", "scope": scope, "key": key})
                return OnceResult("ambiguous", False, key, entry=claimed["entry"])
            return await self._run_acquired(scope, key, claimed["entry"], effect, classify)

        state = await self.store.read(scope)
        entry = (state or {}).get("effects", {}).get(key)
        if entry and entry["status"] == "committed":
            return OnceResult("replayed", True, key, value=entry.get("result"), entry=entry)
        if entry:
            return OnceResult("in_flight", False, key, entry=entry)
        raise RuntimeError("replyonce: could not claim key after several rounds")

    async def _run_acquired(self, scope, key, entry, effect, classify) -> OnceResult:
        attempt, attempt_id, run_id = entry["attempt"], entry["attemptId"], entry["runId"]
        self._emit({"type": "claimed", "scope": scope, "key": key, "attempt": attempt, "runId": run_id})
        ctx = EffectContext(
            key=key, scope=scope, intent=entry["intent"], attempt=attempt,
            idempotency_key=provider_idempotency_key(scope, key), fencing_token=entry["token"],
            deadline_ms=entry["claimedAt"] + self.policy.pending_ttl_ms,
        )
        try:
            value = effect(ctx)
            if inspect.isawaitable(value):
                value = await value
        except Exception as err:  # noqa: BLE001 - classified below
            try:
                cls = "not_applied" if classify(err) == "not_applied" else "ambiguous"
            except Exception:
                cls = "ambiguous"
            outcome = "failed" if cls == "not_applied" else "ambiguous"
            try:
                await self._settle(scope, key=key, attempt_id=attempt_id, outcome=outcome, error=_describe(err))
            except Exception:
                pass
            if outcome == "failed":
                self._emit({"type": "failed", "scope": scope, "key": key, "attempt": attempt, "error": err})
                return OnceResult("failed", False, key, attempt=attempt, error=err, retryable=attempt < self.policy.max_attempts)
            self._emit({"type": "ambiguous", "scope": scope, "key": key, "error": err})
            try:
                current = ((await self.store.read(scope)) or {}).get("effects", {}).get(key) or entry
            except Exception:
                current = entry
            return OnceResult("ambiguous", False, key, entry=current, error=err)

        try:
            stored = None if value is None else json.loads(json.dumps(value))
        except (TypeError, ValueError):
            stored = None
            self._emit({"type": "unserializable_result", "scope": scope, "key": key})
        try:
            settled = await self._settle(scope, key=key, attempt_id=attempt_id, outcome="committed", result=stored)
        except Exception:
            self._emit({"type": "late_settle", "scope": scope, "key": key, "attempt": attempt})
            return OnceResult("executed", True, key, value=value, attempt=attempt, late_settle=True)
        self._emit({"type": "committed", "scope": scope, "key": key, "attempt": attempt, "runId": run_id})
        if settled["kind"] == "stale" or settled.get("wasAbandoned"):
            self._emit({"type": "late_settle", "scope": scope, "key": key, "attempt": attempt})
            return OnceResult("executed", True, key, value=value, attempt=attempt, late_settle=True)
        return OnceResult("executed", True, key, value=value, attempt=attempt)

    async def _settle(self, scope: str, **kw) -> dict:
        last: Optional[BaseException] = None
        for i in range(4):
            try:
                now = self._now()
                return await self.store.transact(scope, lambda s: logic.settle(s, now=now, policy=self.policy, **kw))
            except Exception as err:  # noqa: BLE001
                last = err
                await asyncio.sleep(0.025 * 4**i)
        assert last is not None
        raise last

    async def _wait_for_settle(self, scope: str, key: str, until: int, interval_ms: int) -> None:
        while self._now() < until:
            await asyncio.sleep(min(interval_ms, max(1, until - self._now())) / 1000)
            e = ((await self.store.read(scope)) or {}).get("effects", {}).get(key)
            if e is None or logic.effective_status(e, self._now(), self.policy) != "pending":
                return


class Run:
    """A unit of agent work on one scope, holding a fencing token."""

    def __init__(self, ro: ReplyOnce, scope: str, run_id: str, lease_ttl_ms: int, outcome: dict) -> None:
        self._ro = ro
        self.scope = scope
        self.run_id = run_id
        self._ttl = lease_ttl_ms
        self.state: str = outcome["state"]
        if self.state == "busy":
            self.fencing_token: Optional[int] = None
            self.prior_effects: list[dict] = []
            self.busy_holder: Optional[dict] = outcome["holder"]
        else:
            self.fencing_token = outcome["run"]["token"]
            self.prior_effects = outcome["priorEffects"]
            self.busy_holder = None

    @property
    def can_write(self) -> bool:
        return self.state in ("new", "resumed")

    @property
    def already_wrote(self) -> bool:
        return any(e["status"] != "failed" for e in self.prior_effects)

    async def once(self, intent: str, payload: Any, effect: Effect, *, summary: Optional[str] = None,
                   conflict: str = "any", ack: bool = True, classify_error=None, reconcile=None,
                   wait_ms: Optional[int] = None, wait_interval_ms: int = 100) -> OnceResult:
        """Run ``effect`` at most once per (scope, intent, payload), fenced to this run."""
        key = effect_key(intent, payload)
        if self.fencing_token is None:
            return OnceResult("refused", False, key, reason="busy")
        return await self._ro._execute(
            self.scope, key, intent, (self.run_id, self.fencing_token, self._ttl), effect,
            summary=summary, classify_error=classify_error, reconcile=reconcile,
            wait_ms=wait_ms, wait_interval_ms=wait_interval_ms, conflict=conflict, ack=ack,
        )

    async def check(self, intent: str, payload: Any = MISSING) -> CheckResult:
        return await self._ro.check(Key(self.scope, intent, payload))

    async def history(self) -> list[dict]:
        return await self._ro.history(self.scope)

    async def heartbeat(self) -> bool:
        if self.fencing_token is None:
            return False
        return await self._ro._renew(self.scope, self.run_id, self.fencing_token, self._ttl)

    async def end(self, reason: str = "completed") -> None:
        if self.fencing_token is None:
            return
        await self._ro._end(self.scope, self.run_id, self.fencing_token, reason)
