"""Tool-calling and webhook adapters. No SDK dependencies: they produce plain dicts."""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Union

from ._core import EffectContext, OnceResult, ReplyOnce, Run


@dataclass
class ToolOutcome:
    ok: bool
    status: str
    terminal: bool
    retryable: bool
    message: str
    output: Any = None
    conflicts: Optional[list] = None

    def to_dict(self) -> dict:
        d = {"ok": self.ok, "status": self.status, "terminal": self.terminal, "retryable": self.retryable, "message": self.message}
        if self.output is not None:
            d["output"] = self.output
        if self.conflicts is not None:
            d["conflicts"] = self.conflicts
        return d


def describe_outcome(result: OnceResult) -> ToolOutcome:
    """Turn a ``once`` result into a model-friendly tool result."""
    s = result.status
    if s == "executed":
        return ToolOutcome(True, s, False, False, "Done.", result.value)
    if s == "replayed":
        return ToolOutcome(True, s, False, False, "This exact action was already done earlier. It was not repeated.", result.value)
    if s == "in_flight":
        return ToolOutcome(False, s, False, False, "This exact action is already in progress elsewhere. Do not repeat it.")
    if s == "ambiguous":
        return ToolOutcome(
            False, s, False, False,
            "This action may or may not have happened (the outcome is unknown). Do not repeat it. "
            "Tell the user it is being checked, or escalate to a human.",
        )
    if s == "failed":
        err = str(result.error)[:300]
        if result.retryable:
            return ToolOutcome(False, s, False, True, f"The action failed and did not happen: {err}. You may retry.")
        return ToolOutcome(False, s, False, False, f"The action failed and did not happen: {err}. Retry limit reached; escalate.")
    if result.reason == "conversation_changed":
        return ToolOutcome(
            False, s, False, True,
            "Not done: the conversation changed since you last read it. Another run did the following. "
            "Re-read the conversation and decide whether your action is still needed; if it is, call the tool again.",
            conflicts=[{"intent": c["intent"], "status": c["status"], "summary": c["summary"]} for c in (result.conflicts or [])],
        )
    if result.reason == "exhausted":
        return ToolOutcome(False, s, False, False, "Not done: this action already failed too many times. Escalate to a human.")
    return ToolOutcome(False, s, True, False, f"Stop: this run may no longer act on this conversation ({result.reason}).")


@dataclass
class GuardedTool:
    """A side-effecting tool a run executes at most once per business identity."""

    name: str
    description: str
    parameters: dict
    identity: Callable[[dict], Any]
    execute: Callable[[dict, EffectContext], Union[Awaitable[Any], Any]]
    summarize: Optional[Callable[[dict], str]] = None
    intent: Optional[str] = None
    conflict: str = "any"

    @property
    def ledger_intent(self) -> str:
        return self.intent or self.name

    async def call(self, run: Run, args: dict) -> ToolOutcome:
        result = await run.once(
            self.ledger_intent,
            self.identity(args),
            lambda ctx: self.execute(args, ctx),
            summary=self.summarize(args) if self.summarize else None,
            conflict=self.conflict,
        )
        return describe_outcome(result)


def guard_tool(
    *,
    name: str,
    description: str,
    parameters: dict,
    identity: Callable[[dict], Any],
    execute: Callable[[dict, EffectContext], Union[Awaitable[Any], Any]],
    summarize: Optional[Callable[[dict], str]] = None,
    intent: Optional[str] = None,
    conflict: str = "any",
) -> GuardedTool:
    return GuardedTool(name, description, parameters, identity, execute, summarize, intent, conflict)


class CheckTool:
    """A read-only "was this already done?" tool for the model."""

    def __init__(self, tools: list[GuardedTool], name: str = "check_already_done") -> None:
        self._by_name = {t.name: t for t in tools}
        self.name = name
        self.description = (
            "Check whether a side-effecting action was already done on this conversation before doing it again. "
            "Pass the tool name and the arguments you would call it with. Omit arguments to list every recorded call of that tool."
        )
        self.parameters = {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "enum": [t.name for t in tools]},
                "arguments": {"type": "object", "description": "The arguments you would pass to that tool."},
            },
            "required": ["tool"],
            "additionalProperties": False,
        }

    async def call(self, run: Run, args: dict) -> ToolOutcome:
        tool = self._by_name.get((args or {}).get("tool"))
        if tool is None:
            return ToolOutcome(False, "failed", False, False, f"Unknown tool {(args or {}).get('tool')}.")
        if args.get("arguments") is not None:
            found = await run.check(tool.ledger_intent, tool.identity(args["arguments"]))
            message = {
                "none": "Not done yet.",
                "committed": "Already done. Do not repeat it.",
                "failed": "Tried before and it did not happen. It may be retried.",
                "pending": "In progress right now. Do not repeat it.",
            }.get(found.status, "Outcome unknown. Do not repeat it; escalate.")
            summary = found.entry["summary"] if found.entry else None
            return ToolOutcome(True, "executed", False, False, message, {"status": found.status, "done": found.done, "summary": summary})
        rows = [e for e in await run.history() if e["intent"] == tool.ledger_intent]
        out = [
            {
                "status": e["status"],
                "summary": e["summary"],
                "at": _dt.datetime.fromtimestamp((e["settledAt"] or e["claimedAt"]) / 1000, _dt.timezone.utc).isoformat(),
            }
            for e in rows
        ]
        return ToolOutcome(True, "executed", False, False, "No calls recorded." if not out else f"{len(out)} call(s) recorded.", out)


def check_tool(tools: list[GuardedTool], name: str = "check_already_done") -> CheckTool:
    return CheckTool(tools, name)


async def dispatch_tool(run: Run, tools: list, name: str, args: dict) -> ToolOutcome:
    for t in tools:
        if t.name == name:
            return await t.call(run, args)
    return ToolOutcome(False, "failed", False, False, f"Unknown tool {name}.")


def to_openai_tool(tool: Any, api: str = "chat") -> dict:
    """OpenAI tool shape: ``chat`` for Chat Completions, ``responses`` for the Responses API."""
    if api == "responses":
        return {"type": "function", "name": tool.name, "description": tool.description, "parameters": tool.parameters}
    return {"type": "function", "function": {"name": tool.name, "description": tool.description, "parameters": tool.parameters}}


def to_anthropic_tool(tool: Any) -> dict:
    """Anthropic Messages API tool shape."""
    return {"name": tool.name, "description": tool.description, "input_schema": tool.parameters}


def http_status_for(result: OnceResult) -> tuple[int, Optional[int]]:
    """(status, retry_after_seconds) to return to a webhook provider. See the TypeScript docs for the reasoning."""
    if result.status in ("executed", "replayed"):
        return 200, None
    if result.status == "in_flight":
        return 503, 5
    if result.status == "failed":
        return (500, None) if result.retryable else (200, None)
    return 200, None


async def webhook_once(
    ro: ReplyOnce, *, scope: str, event_id: str, handler: Callable, intent: str = "webhook", **once_kwargs: Any
) -> tuple[OnceResult, int, Optional[int]]:
    """Handle one webhook delivery at most once per (scope, event_id)."""
    result = await ro.once({"scope": scope, "intent": intent, "payload": {"eventId": event_id}}, handler, **once_kwargs)
    status, retry_after = http_status_for(result)
    return result, status, retry_after
