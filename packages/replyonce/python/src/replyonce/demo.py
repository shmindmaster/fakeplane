"""Chaos simulation of a support agent, with and without replyonce. Port of ``src/demo.ts``."""

from __future__ import annotations

import asyncio
import heapq
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

from ._core import ReplyOnce
from ._key import provider_idempotency_key
from .stores.memory import MemoryStore


class _Timeout(Exception):
    pass


@dataclass
class Stats:
    conversations: int
    customer_messages: int
    replies_sent: int
    duplicate_answers: int
    unanswered: int
    faults: dict = field(default_factory=dict)


def _wall_ms() -> int:
    return int(time.time() * 1000)


# Simulated runs report times from 2026-01-01T00:00:00Z.
_SIM_EPOCH_MS = 1_767_225_600_000


def _loop_ms() -> int:
    return _SIM_EPOCH_MS + int(asyncio.get_running_loop().time() * 1000)


class _SimulatedLoop(asyncio.SelectorEventLoop):
    """Event loop on simulated time: whenever nothing is ready, time jumps to the next timer.

    With the in-memory store nothing else can wake the loop, so a seed always replays the same
    run, and no real time passes. Steps through CPython's ``BaseEventLoop._run_once``.
    """

    def __init__(self) -> None:
        super().__init__()
        # Starts at zero: at epoch-sized values a float cannot hold the loop's clock resolution,
        # so a timer due now would never count as ready.
        self._sim_now = 0.0

    def time(self) -> float:
        return self._sim_now

    def _run_once(self) -> None:
        while self._scheduled and self._scheduled[0]._cancelled:
            self._timer_cancelled_count -= 1
            heapq.heappop(self._scheduled)._scheduled = False
        if not self._ready and not self._stopping:
            if not self._scheduled:
                raise RuntimeError("replyonce demo: the simulation stalled")
            self._sim_now = max(self._sim_now, self._scheduled[0]._when)
        super()._run_once()


def _run_simulated(make_coro):
    loop = _SimulatedLoop()
    try:
        return loop.run_until_complete(make_coro())
    finally:
        loop.close()


@dataclass
class _World:
    rand: random.Random
    now_ms: Callable[[], int] = _wall_ms
    inbound: dict = field(default_factory=dict)
    sent: list = field(default_factory=list)
    faults: dict = field(default_factory=dict)

    def bump(self, name: str) -> None:
        self.faults[name] = self.faults.get(name, 0) + 1

    def answered(self, conv: str) -> set:
        return {a for r in self.sent if r["conv"] == conv for a in r["answers"]}


async def _sleep_ms(ms: float) -> None:
    await asyncio.sleep(ms / 1000)


async def _hang() -> None:
    await asyncio.Event().wait()


async def _provider_send(w: _World, reply: dict) -> None:
    await _sleep_ms(1 + w.rand.random() * 4)
    roll = w.rand.random()
    if roll < 0.15:
        w.sent.append(reply)
        w.bump("timeoutAfterSend")
        raise _Timeout("provider timed out")
    if roll < 0.25:
        w.bump("timeoutBeforeSend")
        raise _Timeout("provider timed out")
    w.sent.append(reply)


def _naive(w: _World):
    async def agent(job: dict, crash: bool) -> None:
        await _sleep_ms(2 + w.rand.random() * 10)
        todo = [m for m in job["inbound"] if m not in job["answered"]]
        if not todo:
            return
        for _ in range(5):
            try:
                await _provider_send(w, {"conv": job["conv"], "answers": todo, "idem": None})
                if crash:
                    await _hang()
                return
            except _Timeout:
                continue

    return agent


def _guarded(w: _World, store) -> object:
    async def reconcile(entry: dict) -> dict:
        idem = provider_idempotency_key(entry["scope"], entry["key"])
        return {"outcome": "committed"} if any(r["idem"] == idem for r in w.sent) else {"outcome": "not_applied"}

    def on_event(e: dict) -> None:
        # A settle after the claim was given up on means pending_ttl_ms was too short for this host.
        if e["type"] == "late_settle":
            w.bump("lateSettle")

    ro = ReplyOnce(store, pending_ttl_ms=2_000, max_attempts=6, lease_ttl_ms=5_000, reconcile=reconcile, on_event=on_event, clock=w.now_ms)

    async def agent(job: dict, crash: bool) -> None:
        await _sleep_ms(2 + w.rand.random() * 10)
        run = await ro.begin(job["conv"], run_id=job["id"], context_at=job["contextAt"])
        if not run.can_write:
            return
        inbound, done = job["inbound"], job["answered"]
        give_up_at = w.now_ms() + 15_000
        while w.now_ms() < give_up_at:
            todo = [m for m in inbound if m not in done]
            if not todo:
                break

            async def send(ctx, todo=todo):
                await _provider_send(w, {"conv": job["conv"], "answers": todo, "idem": ctx.idempotency_key})
                if crash:
                    await _hang()

            res = await run.once("reply", {"answers": todo}, send, summary="reply to " + ", ".join(todo), wait_ms=5_000, wait_interval_ms=10)
            if res.ok:
                break
            if res.status == "refused" and res.reason == "conversation_changed":
                # Another run's reply may still be in flight; give it a moment, then re-read.
                await _sleep_ms(25 if any(c["status"] == "pending" for c in res.conflicts or []) else 5)
                inbound = list(w.inbound.get(job["conv"], []))
                done = w.answered(job["conv"])
                continue
            if res.status == "refused":
                break
            await _sleep_ms(10)
        await run.end()

    return agent


async def _simulate(conversations: int, seed: int, make_agent, real_time: bool = True) -> Stats:
    w = _World(random.Random(seed), now_ms=_wall_ms if real_time else _loop_ms)
    agent = make_agent(w)
    tasks: list = []
    crashed: list = []
    seq = 0
    # Shared stores outlive a run, so real-time runs keep their conversations apart.
    ns = uuid.uuid4().hex[:8] if real_time else f"seed{seed}"

    def deliver(job: dict) -> None:
        r = w.rand.random()
        if r < 0.1:
            w.bump("workerCrash")
            crashed.append(asyncio.ensure_future(agent(job, True)))

            async def redeliver():
                await _sleep_ms(60 + w.rand.random() * 60)
                await agent(job, False)

            tasks.append(asyncio.ensure_future(redeliver()))
            return
        tasks.append(asyncio.ensure_future(agent(job, False)))
        if r < 0.25:
            w.bump("duplicateDelivery")

            async def dup():
                await _sleep_ms(w.rand.random() * 8)
                await agent(job, False)

            tasks.append(asyncio.ensure_future(dup()))

    def enqueue(conv: str, msg: str) -> None:
        nonlocal seq
        w.inbound.setdefault(conv, []).append(msg)
        seq += 1
        deliver({
            "id": f"job-{seq}",
            "conv": conv,
            "inbound": list(w.inbound[conv]),
            "answered": w.answered(conv),
            "contextAt": w.now_ms(),
        })

    for i in range(conversations):
        conv = f"demo-{ns}-conversation-{i}"
        enqueue(conv, f"{conv}/m1")
        if w.rand.random() < 0.25:
            w.bump("customerBurst")

            async def burst(conv=conv):
                await _sleep_ms(1 + w.rand.random() * 12)
                enqueue(conv, f"{conv}/m2")

            tasks.append(asyncio.ensure_future(burst()))
    n = -1
    while n != len(tasks):
        n = len(tasks)
        await asyncio.gather(*list(tasks))
    await _sleep_ms(50)
    # The "crashed" workers hang forever by design; stop them now that the run is over.
    for t in crashed:
        t.cancel()
    await asyncio.gather(*crashed, return_exceptions=True)

    dup = unanswered = msgs = 0
    for conv, items in w.inbound.items():
        for m in items:
            msgs += 1
            count = sum(1 for r in w.sent if r["conv"] == conv and m in r["answers"])
            unanswered += count == 0
            dup += max(0, count - 1)
    return Stats(conversations, msgs, len(w.sent), dup, unanswered, w.faults)


async def run_demo(conversations: int = 100, seed: int = 7, store=None, real_time: Optional[bool] = None) -> tuple[Stats, Stats]:
    """Run the simulation without and with replyonce.

    Simulated time (the default without a ``store``) makes every count a function of the seed;
    real time (the default with a ``store``, since shared stores do real I/O) explores timing a
    single seed cannot.
    """
    real = store is not None if real_time is None else real_time
    st = store if store is not None else MemoryStore()

    async def both() -> tuple[Stats, Stats]:
        without = await _simulate(conversations, seed, _naive, real)
        guarded = await _simulate(conversations, seed, lambda w: _guarded(w, st), real)
        return without, guarded

    if real:
        return await both()
    # The simulated loop needs a thread of its own: this coroutine already runs on a real loop.
    return await asyncio.to_thread(_run_simulated, both)


def format_report(without: Stats, with_: Stats) -> str:
    def row(label: str, s: Stats) -> str:
        return f"  {label:<16} {s.customer_messages:>8} {s.replies_sent:>7} {s.duplicate_answers:>10} {s.unanswered:>11}"

    def faults(f: dict) -> str:
        return ", ".join(f"{k}={v}" for k, v in f.items())

    if with_.duplicate_answers == 0:
        verdict = "  No customer message was answered twice with replyonce."
    elif with_.faults.get("lateSettle"):
        verdict = "  Duplicates happened after this host stalled past pending_ttl_ms (see lateSettle): the limit described in the README."
    else:
        verdict = "  Duplicates remained with replyonce. Please report this: https://github.com/shmindmaster/replyonce/issues"
    return "\n".join([
        f"replyonce demo: {without.conversations} simulated support conversations under injected faults",
        f"  without: {faults(without.faults)}",
        f"  with:    {faults(with_.faults)}",
        "",
        f"  {'':<16} {'messages':>8} {'replies':>7} {'duplicates':>10} {'unanswered':>11}",
        row("without", without),
        row("with replyonce", with_),
        "",
        verdict,
    ])
