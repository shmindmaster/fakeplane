import asyncio
import time

from replyonce import ReplyOnce

from .conftest import FakeClock, uid, until


def test_newest_run_owns_the_conversation(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        a = await ro.begin(conv)
        b = await ro.begin(conv)
        assert b.fencing_token > a.fencing_token
        assert (await a.once("reply", {"to": "m1"}, lambda ctx: "a")).reason == "superseded"
        assert (await b.once("reply", {"to": "m1"}, lambda ctx: "b")).status == "executed"
        assert await a.heartbeat() is False

    with_store(body)


def test_failed_newer_run_without_writes_does_not_silence_older(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        a = await ro.begin(conv)
        b = await ro.begin(conv)
        await b.end("failed")
        assert (await a.once("reply", 1, lambda ctx: 1)).status == "executed"

    with_store(body)


def test_duplicate_reply_race_is_closed(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        sent = []
        gate = asyncio.Event()
        a = await ro.begin(conv)

        started = asyncio.Event()

        async def a_send(ctx):
            started.set()
            await gate.wait()
            sent.append("A: m1")

        a_task = asyncio.ensure_future(a.once("reply", {"answers": ["m1"]}, a_send, summary="answer to m1"))
        await until(started.is_set)
        b = await ro.begin(conv)
        r1 = await b.once("reply", {"answers": ["m1", "m2"]}, lambda ctx: sent.append("B: m1+m2"))
        assert (r1.reason, r1.conflicts[0]["status"], r1.conflicts[0]["summary"]) == ("conversation_changed", "pending", "answer to m1")
        gate.set()
        await a_task
        r2 = await b.once("reply", {"answers": ["m2"]}, lambda ctx: sent.append("B: m2"))
        assert (r2.reason, r2.conflicts[0]["status"]) == ("conversation_changed", "committed")
        assert (await b.once("reply", {"answers": ["m2"]}, lambda ctx: sent.append("B: m2"))).status == "executed"
        assert sent == ["A: m1", "B: m2"]

    with_store(body)


def test_context_at_orders_runs_and_catches_snapshot_gap(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        t = int(time.time() * 1000)
        a = await ro.begin(conv, context_at=t - 200)
        await a.once("reply", ["m1"], lambda ctx: "a")
        b = await ro.begin(conv, context_at=t - 50)
        assert (await b.once("reply", ["m1", "m2"], lambda ctx: "b")).reason == "conversation_changed"
        older = await ro.begin(conv, context_at=t - 10_000)
        assert older.state == "superseded" and not older.can_write

    with_store(body)


def test_redelivery_resumes_fences_and_replays(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        sends = []
        first = await ro.begin(conv, run_id="job-7")
        await first.once("reply", {"to": "m1"}, lambda ctx: sends.append(1) or len(sends))
        second = await ro.begin(conv, run_id="job-7")
        assert (second.state, second.already_wrote) == ("resumed", True)
        assert (await second.once("reply", {"to": "m1"}, lambda ctx: sends.append(1))).status == "replayed"
        assert (await first.once("add_tag", "x", lambda ctx: 1)).reason == "superseded"
        await first.end()
        assert (await second.once("add_tag", "x", lambda ctx: 1)).status == "executed"
        assert (await second.once("reply", {"answers": ["m1", "m2"]}, lambda ctx: 1)).reason == "conversation_changed"
        await second.end()
        assert (await ro.begin(conv, run_id="job-7")).state == "ended"
        assert len(sends) == 1

    with_store(body)


def test_runs_with_same_context_time_are_not_fenced_by_begin_order(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        sent = []
        # m1 and m2 arrive in the same millisecond, and m2's job happens to begin first.
        t = int(time.time() * 1000) - 10
        for_m2 = await ro.begin(conv, run_id="job-m2", context_at=t)
        for_m1 = await ro.begin(conv, run_id="job-m1", context_at=t)
        assert (for_m2.state, for_m1.state) == ("new", "new")
        assert (await for_m1.once("reply", {"answers": ["m1"]}, lambda ctx: sent.append(["m1"]))).status == "executed"
        await for_m1.end()
        # m2's run must not be refused as superseded by a run that never saw m2.
        r = await for_m2.once("reply", {"answers": ["m1", "m2"]}, lambda ctx: sent.append(["m1", "m2"]))
        assert (r.status, r.reason) == ("refused", "conversation_changed")
        assert (await for_m2.once("reply", {"answers": ["m2"]}, lambda ctx: sent.append(["m2"]))).status == "executed"
        assert sent == [["m1"], ["m2"]]

    with_store(body)


def test_without_context_at_later_begin_is_newer_within_one_millisecond(with_store):
    async def body(store):
        ro = ReplyOnce(store, clock=FakeClock())
        conv = uid()
        a = await ro.begin(conv)
        b = await ro.begin(conv)
        assert (await a.once("reply", 1, lambda ctx: "a")).reason == "superseded"
        assert (await b.once("reply", 1, lambda ctx: "b")).status == "executed"

    with_store(body)


def test_redelivered_older_run_does_not_outrank_newer(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        t = int(time.time() * 1000) - 10
        await ro.begin(conv, run_id="older", context_at=t - 1)
        newer = await ro.begin(conv, run_id="newer", context_at=t)
        # The redelivery gets the highest fencing token, but supersession follows context time.
        redelivered = await ro.begin(conv, run_id="older", context_at=t - 1)
        assert redelivered.fencing_token > newer.fencing_token
        assert redelivered.state == "superseded"
        assert (await newer.once("reply", {"to": "m2"}, lambda ctx: 1)).status == "executed"

    with_store(body)


def test_redelivered_run_does_not_outrank_peer_with_same_context_time(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        t = int(time.time() * 1000) - 10
        await ro.begin(conv, run_id="first", context_at=t)
        peer = await ro.begin(conv, run_id="second", context_at=t)
        redelivered = await ro.begin(conv, run_id="first", context_at=t)
        assert redelivered.state == "resumed"
        assert (await peer.once("reply", {"to": "m2"}, lambda ctx: 1)).status == "executed"

    with_store(body)


def test_exclusive_lease_and_takeover(with_store):
    async def body(store):
        clock = FakeClock()
        ro = ReplyOnce(store, clock=clock, lease_ttl_ms=1000)
        conv = uid()
        a = await ro.begin(conv, mode="exclusive", run_id="worker-a")
        b = await ro.begin(conv, mode="exclusive", run_id="worker-b")
        assert (a.state, b.state, b.busy_holder["runId"]) == ("new", "busy", "worker-a")
        assert (await b.once("x", 1, lambda ctx: 1)).reason == "busy"
        clock.advance(1001)
        c = await ro.begin(conv, mode="exclusive", run_id="worker-c")
        assert c.state == "new" and c.fencing_token > a.fencing_token
        assert (await a.once("x", 1, lambda ctx: "stale")).reason == "superseded"
        assert (await c.once("x", 1, lambda ctx: "fresh")).status == "executed"

    with_store(body)


def test_cancel(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        conv = uid()
        a = await ro.begin(conv, run_id="a")
        b = await ro.begin(conv, run_id="b")
        assert await ro.cancel(conv, "b")
        assert (await b.once("reply", 1, lambda ctx: 1)).reason == "run_cancelled"
        assert (await a.once("reply", 1, lambda ctx: 1)).status == "executed"

    with_store(body)
