from replyonce import MemoryStore, NotApplied, ReplyOnce
from replyonce.adapters import (
    check_tool,
    dispatch_tool,
    guard_tool,
    http_status_for,
    to_anthropic_tool,
    to_openai_tool,
    webhook_once,
)

from .conftest import arun, uid


def make_reply_tool(sent):
    return guard_tool(
        name="send_reply",
        description="Send a reply to the customer.",
        parameters={"type": "object", "properties": {"in_reply_to": {"type": "string"}, "text": {"type": "string"}}},
        identity=lambda a: {"inReplyTo": a["in_reply_to"]},
        summarize=lambda a: a["text"],
        execute=lambda a, ctx: sent.append(a["text"]) or {"message_id": f"msg-{len(sent)}"},
    )


def test_tool_dedupes_by_identity_and_check_tool():
    async def main():
        ro = ReplyOnce(MemoryStore())
        sent = []
        tool = make_reply_tool(sent)
        check = check_tool([tool])
        run = await ro.begin(uid())
        assert (await check.call(run, {"tool": "send_reply", "arguments": {"in_reply_to": "m1"}})).message == "Not done yet."
        r1 = await tool.call(run, {"in_reply_to": "m1", "text": "Refund on its way."})
        r2 = await dispatch_tool(run, [tool, check], "send_reply", {"in_reply_to": "m1", "text": "Refunded!"})
        assert (r1.status, r2.status, r2.output) == ("executed", "replayed", {"message_id": "msg-1"})
        found = await check.call(run, {"tool": "send_reply", "arguments": {"in_reply_to": "m1"}})
        assert found.output == {"status": "committed", "done": True, "summary": "Refund on its way."}
        assert len((await check.call(run, {"tool": "send_reply"})).output) == 1
        assert sent == ["Refund on its way."]
        assert (await dispatch_tool(run, [tool], "missing", {})).ok is False
        assert to_openai_tool(tool)["function"]["name"] == "send_reply"
        assert to_openai_tool(tool, "responses")["name"] == "send_reply"
        assert to_anthropic_tool(tool)["input_schema"] == tool.parameters
        assert r2.to_dict()["ok"] is True

    arun(main())


def test_webhook_once():
    async def main():
        ro = ReplyOnce(MemoryStore())
        n = []
        scope = uid("ticket")
        r1, s1, _ = await webhook_once(ro, scope=scope, event_id="e1", handler=lambda ctx: n.append(1))
        r2, s2, _ = await webhook_once(ro, scope=scope, event_id="e1", handler=lambda ctx: n.append(1))
        assert (s1, s2, r2.status, len(n)) == (200, 200, "replayed", 1)

        def fail(ctx):
            raise NotApplied("400")

        _, s3, _ = await webhook_once(ro, scope=scope, event_id="e2", handler=fail)
        assert s3 == 500

    arun(main())


def test_http_status_for_in_flight():
    from replyonce import OnceResult

    assert http_status_for(OnceResult("in_flight", False, "k")) == (503, 5)
    assert http_status_for(OnceResult("ambiguous", False, "k")) == (200, None)
