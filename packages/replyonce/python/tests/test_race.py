import asyncio
import random

from replyonce import Key, ReplyOnce
from replyonce.demo import run_demo

from .conftest import uid


def test_parallel_workers_on_one_key_execute_once(with_store):
    async def body(store):
        hits = []
        key = Key(uid(), "refund", {"order": "o-1"})

        async def worker(i):
            ro = ReplyOnce(store)
            await asyncio.sleep(random.random() * 0.005)

            async def effect(ctx):
                hits.append(i)
                await asyncio.sleep(random.random() * 0.02)
                return f"worker-{i}"

            return await ro.once(key, effect, wait_ms=10_000, wait_interval_ms=5)

        results = await asyncio.gather(*(worker(i) for i in range(32)))
        assert len(hits) == 1
        assert [r.status for r in results].count("executed") == 1
        assert all(r.ok and r.value == f"worker-{hits[0]}" for r in results)

    with_store(body)


def test_webhook_redelivery_storm(with_store):
    async def body(store):
        ro = ReplyOnce(store)
        counts: dict = {}
        events = [(uid("ticket"), f"evt-{i}") for i in range(30)]
        deliveries = [e for e in events for _ in range(4)]
        random.shuffle(deliveries)

        async def deliver(scope, eid):
            await asyncio.sleep(random.random() * 0.01)

            async def handle(ctx):
                await asyncio.sleep(random.random() * 0.005)
                counts[eid] = counts.get(eid, 0) + 1

            await ro.once(Key(scope, "webhook", {"eventId": eid}), handle)

        await asyncio.gather(*(deliver(s, e) for s, e in deliveries))
        for s, e in events:
            await ro.once(Key(s, "webhook", {"eventId": e}), lambda ctx, e=e: counts.__setitem__(e, counts.get(e, 0) + 1), wait_ms=2000)
        assert max(counts.values()) == 1 and len(counts) == 30

    with_store(body)


def test_chaos_demo_has_no_duplicates(with_store):
    async def body(store):
        for seed in (1, 2):
            without, with_ = await run_demo(conversations=150 if with_store.kind == "memory" else 50, seed=seed, store=store)
            assert without.duplicate_answers > 0
            assert with_.duplicate_answers == 0
            assert with_.unanswered == 0

    with_store(body)
