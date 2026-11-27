import asyncio

import pytest

from replyonce import Key, NotApplied, ReplyOnce, ReplyOnceError, unwrap

from .conftest import FakeClock, uid, until


def test_executes_once_and_replays(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        hits = []
        key = Key(uid(), "refund", {"order": "o-1"})
        first = await ro.once(key, lambda ctx: hits.append(1) or {"refund_id": "re_1"})
        second = await ro.once(key, lambda ctx: hits.append(1) or {"refund_id": "re_2"})
        assert (first.status, first.value, first.attempt) == ("executed", {"refund_id": "re_1"}, 1)
        assert (second.status, second.value) == ("replayed", {"refund_id": "re_1"})
        assert len(hits) == 1

    with_store(body)


def test_retries_only_after_not_applied(with_store):
    async def body(store):
        ro = ReplyOnce(store, max_attempts=2)
        key = Key(uid(), "ticket", {"m": 1})
        seen = []

        def fail(ctx):
            seen.append(ctx.idempotency_key)
            raise NotApplied("400")

        r1 = await ro.once(key, fail)
        r2 = await ro.once(key, fail)
        r3 = await ro.once(key, lambda ctx: "never")
        assert (r1.status, r1.retryable, r2.retryable) == ("failed", True, False)
        assert (r3.status, r3.reason) == ("refused", "exhausted")
        assert seen[0] == seen[1]

    with_store(body)


def test_ambiguous_is_not_retried(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        hits = []
        key = Key(uid(), "send", 1)

        def boom(ctx):
            hits.append(1)
            raise TimeoutError("timed out")

        assert (await ro.once(key, boom)).status == "ambiguous"
        assert (await ro.once(key, lambda ctx: hits.append(1))).status == "ambiguous"
        assert len(hits) == 1
        assert (await ro.check(key)).status == "ambiguous"

    with_store(body)


def test_reconciler_and_resolve(with_store):
    async def body(store):
        sent = set()

        async def reconcile(entry):
            return {"outcome": "committed", "result": "found"} if entry["key"] in sent else {"outcome": "not_applied"}

        ro = ReplyOnce(store, reconcile=reconcile)
        landed = Key(uid(), "reply", {"m": 1})

        def send_then_timeout(ctx):
            sent.add(ctx.key)
            raise ConnectionError("reset")

        await ro.once(landed, send_then_timeout)
        r = await ro.once(landed, lambda ctx: "no")
        assert (r.status, r.value) == ("replayed", "found")

        lost = Key(uid(), "reply", {"m": 2})

        def fail(ctx):
            raise ConnectionError("reset before write")

        await ro.once(lost, fail)
        r2 = await ro.once(lost, lambda ctx: "sent")
        assert (r2.status, r2.attempt) == ("executed", 2)

        manual = Key(uid(), "refund", 1)
        await ro.once(manual, fail)
        plain = ReplyOnce(store)
        assert (await plain.resolve(manual, "committed", "checked"))["status"] == "committed"
        assert (await plain.once(manual, lambda ctx: 1)).value == "checked"

    with_store(body)


def test_in_flight_and_wait(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        key = Key(uid(), "reply", 1)
        gate = asyncio.Event()
        started = asyncio.Event()

        async def slow(ctx):
            started.set()
            await gate.wait()
            return "done"

        first = asyncio.ensure_future(ro.once(key, slow))
        await until(started.is_set)
        assert (await ro.once(key, lambda ctx: "dup")).status == "in_flight"
        waiting = asyncio.ensure_future(ro.once(key, lambda ctx: "dup", wait_ms=2000, wait_interval_ms=5))
        await asyncio.sleep(0.02)
        gate.set()
        assert (await first).status == "executed"
        w = await waiting
        assert (w.status, w.value) == ("replayed", "done")

    with_store(body)


def test_abandoned_claim_becomes_ambiguous(with_store):
    async def body(store):
        clock = FakeClock()
        ro = ReplyOnce(store, clock=clock, pending_ttl_ms=1000)
        key = Key(uid(), "reply", 1)
        started = asyncio.Event()

        async def crash(ctx):
            started.set()
            await asyncio.Event().wait()

        hung = asyncio.ensure_future(ro.once(key, crash))
        await until(started.is_set)
        assert (await ro.once(key, lambda ctx: 1)).status == "in_flight"
        clock.advance(1000)
        assert (await ro.check(key)).status == "ambiguous"
        assert (await ro.once(key, lambda ctx: 1)).status == "ambiguous"
        hung.cancel()

    with_store(body)


def test_check_history_unwrap_and_events(with_store):
    async def body(store):
        events = []
        ro = ReplyOnce(store, on_event=lambda e: events.append(e["type"]))
        key = Key(uid(), "create_ticket", {"email": "msg-1"})
        assert (await ro.check(key)).status == "none"
        assert unwrap(await ro.once(key, lambda ctx: "T-1", summary="Ticket for msg-1")) == "T-1"
        assert (await ro.check(key)).done is True
        h = await ro.history(key.scope)
        assert h[0]["summary"] == "Ticket for msg-1" and h[0]["result"] == "T-1"
        bad = await ro.once(Key(key.scope, "x", 2), lambda ctx: (_ for _ in ()).throw(TimeoutError()))
        with pytest.raises(ReplyOnceError):
            unwrap(bad)
        assert events[:2] == ["claimed", "committed"]

    with_store(body)


def test_string_key_is_its_own_scope(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        k = uid("evt")
        n = []
        await ro.once(k, lambda ctx: n.append(1))
        assert (await ro.once(k, lambda ctx: n.append(1))).status == "replayed"
        assert len(n) == 1

    with_store(body)
