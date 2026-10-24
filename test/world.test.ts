import { describe, expect, it } from "vitest";
import { createWorld } from "../src/backends/index.js";
import { parseOperation, project } from "../src/backends/graphql.js";

const zendeskSeed = {
  users: [{ id: 100, name: "Sam Lee", email: "sam.lee@example.com" }],
  tickets: [
    { id: 1, subject: "Where is my order?", requester_id: 100, status: "open", tags: ["vip"], description: "It has been two weeks." },
    { id: 2, subject: "Old", status: "closed" },
  ],
};

describe("World.dispatch", () => {
  it("records calls and effects for writes, not for reads", async () => {
    const w = createWorld({ seed: { zendesk: zendeskSeed } });
    await w.dispatch("zendesk_get_ticket", { ticket_id: 1 }, { transport: "api" });
    const r = await w.dispatch("zendesk.ticket.add_comment", { ticket_id: 1, body: "On its way" }, { transport: "api" });
    expect(r.ok).toBe(true);
    expect(w.calls.map((c) => c.op)).toEqual(["zendesk.ticket.get", "zendesk.ticket.add_comment"]);
    expect(w.effects).toHaveLength(1);
    expect(w.effects[0]).toMatchObject({ kind: "zendesk.ticket.reply", target: "ticket:1", data: { ticket_id: 1, body: "On its way", public: true }, callSeq: 2 });
  });

  it("keeps state between calls (a ticket you update stays updated)", async () => {
    const w = createWorld({ seed: { zendesk: zendeskSeed } });
    await w.dispatch("zendesk.ticket.update", { ticket_id: 1, status: "solved", add_tags: ["refund_issued"] }, { transport: "api" });
    const r = await w.dispatch("zendesk.ticket.get", { ticket_id: 1 }, { transport: "api" });
    expect(r.output).toMatchObject({ status: "solved", tags: ["vip", "refund_issued"] });
  });

  it("fails closed on bad input like the real API", async () => {
    const w = createWorld({ seed: { zendesk: zendeskSeed } });
    expect((await w.dispatch("zendesk.ticket.add_comment", { ticket_id: 2, body: "hi" }, { transport: "api" })).status).toBe(422);
    expect((await w.dispatch("zendesk.ticket.get", { ticket_id: 99 }, { transport: "api" })).status).toBe(404);
    expect((await w.dispatch("zendesk.ticket.add_tags", { ticket_id: 1, tags: [] }, { transport: "api" })).status).toBe(422);
    expect((await w.dispatch("zendesk.ticket.update", { ticket_id: 1, status: "done" }, { transport: "api" })).status).toBe(422);
    expect(w.effects).toHaveLength(0);
  });

  it("applies faults with after/times and leaves uncommitted writes unapplied", async () => {
    const w = createWorld({ seed: { zendesk: zendeskSeed }, faults: [{ op: "zendesk.ticket.add_comment", kind: "error", after: 1, times: 1 }] });
    const call = () => w.dispatch("zendesk.ticket.add_comment", { ticket_id: 1, body: "x" }, { transport: "api" });
    expect((await call()).status).toBe(200);
    const failed = await call();
    expect(failed.status).toBe(500);
    expect(failed.call.committed).toBe(false);
    expect((await call()).status).toBe(200);
    expect(w.effects).toHaveLength(2);
  });

  it("models ambiguous timeouts: the write commits but the caller sees 504", async () => {
    const w = createWorld({ seed: { zendesk: zendeskSeed }, faults: [{ op: "zendesk_add_comment", kind: "timeout", committed: true }] });
    const r = await w.dispatch("zendesk.ticket.add_comment", { ticket_id: 1, body: "x" }, { transport: "api" });
    expect(r.status).toBe(504);
    expect(r.call).toMatchObject({ committed: true, fault: "timeout", ok: false });
    expect(w.effects).toHaveLength(1);
  });

  it("returns Retry-After on rate limits and matches faults on input", async () => {
    const w = createWorld({ seed: { generic: { collections: { refunds: [] } } }, faults: [{ op: "generic.create", where: { collection: "refunds" }, kind: "rate_limit", retryAfter: 3, times: "always" }] });
    const r = await w.dispatch("generic.create", { collection: "refunds", data: { amount: 1 } }, { transport: "api" });
    expect(r.status).toBe(429);
    expect(r.error?.retryAfter).toBe(3);
    const other = await w.dispatch("generic.create", { collection: "notes", data: {} }, { transport: "api" });
    expect(other.status).toBe(200);
  });

  it("replays idempotent writes instead of writing twice", async () => {
    const w = createWorld({ seed: { generic: { collections: { refunds: [] } } }, faults: [{ op: "generic.create", kind: "timeout", committed: true }] });
    const first = await w.dispatch("generic.create", { collection: "refunds", data: { amount: 5 } }, { transport: "api", idempotencyKey: "refund:1" });
    expect(first.status).toBe(504);
    const retry = await w.dispatch("generic.create", { collection: "refunds", data: { amount: 5 } }, { transport: "api", idempotencyKey: "refund:1" });
    expect(retry.call.replayed).toBe(true);
    expect(w.effects).toHaveLength(1);
  });

  it("uses a deterministic clock and ids", async () => {
    const a = createWorld({ seed: { slack: { channels: [{ id: "C1", name: "general" }] } } });
    const b = createWorld({ seed: { slack: { channels: [{ id: "C1", name: "general" }] } } });
    const ra = await a.dispatch("slack_post_message", { channel: "general", text: "hi" }, { transport: "api" });
    const rb = await b.dispatch("slack_post_message", { channel: "#general", text: "hi" }, { transport: "api" });
    expect(ra.output).toEqual(rb.output);
  });
});

describe("Slack fake", () => {
  it("threads, history and reactions", async () => {
    const w = createWorld({ seed: { slack: { channels: [{ id: "C1", name: "support" }], messages: [{ channel: "C1", user: "U1", text: "help", ts: "1767225600.000001" }] } } });
    await w.dispatch("slack_post_message", { channel: "C1", text: "on it", thread_ts: "1767225600.000001" }, { transport: "api" });
    const thread: any = (await w.dispatch("slack_get_thread", { channel: "C1", ts: "1767225600.000001" }, { transport: "api" })).output;
    expect(thread.messages.map((m: any) => m.text)).toEqual(["help", "on it"]);
    const hist: any = (await w.dispatch("slack_get_history", { channel: "support" }, { transport: "api" })).output;
    expect(hist.messages).toHaveLength(1);
    expect(hist.messages[0].reply_count).toBe(1);
    await w.dispatch("slack_add_reaction", { channel: "C1", timestamp: "1767225600.000001", name: ":eyes:" }, { transport: "api" });
    expect((await w.dispatch("slack_add_reaction", { channel: "C1", timestamp: "1767225600.000001", name: "eyes" }, { transport: "api" })).error?.code).toBe("already_reacted");
    expect((await w.dispatch("slack_post_message", { channel: "nope", text: "x" }, { transport: "api" })).error?.code).toBe("channel_not_found");
  });
});

describe("Linear fake", () => {
  it("creates, updates and comments with workflow states", async () => {
    const w = createWorld({ seed: { linear: { teams: [{ key: "SUP", name: "Support" }], users: [{ id: "u1", name: "Ana", email: "ana@team.example" }] } } });
    const created: any = (await w.dispatch("linear_create_issue", { team: "SUP", title: "Refund bug", priority: 2, labels: ["bug"] }, { transport: "api" })).output;
    expect(created).toMatchObject({ identifier: "SUP-1", priority: 2, state: { name: "Todo" }, labels: { nodes: [{ name: "bug" }] } });
    await w.dispatch("linear_update_issue", { issue: "sup-1", state: "In Progress", assignee: "ana@team.example" }, { transport: "api" });
    await w.dispatch("linear_add_comment", { issue: "SUP-1", body: "Looking" }, { transport: "api" });
    const got: any = (await w.dispatch("linear_get_issue", { issue: "SUP-1" }, { transport: "api" })).output;
    expect(got).toMatchObject({ state: { name: "In Progress", type: "started" }, assignee: { id: "u1" }, comments: { nodes: [{ body: "Looking" }] } });
    expect(w.effects.map((e) => e.kind)).toEqual(["linear.issue.create", "linear.issue.update", "linear.comment.create"]);
    expect((await w.dispatch("linear_update_issue", { issue: "SUP-1", state: "Shipped" }, { transport: "api" })).status).toBe(400);
  });
});

describe("generic fake", () => {
  it("serves custom tools backed by collections, with reject rules and response sequences", async () => {
    const w = createWorld({
      seed: {
        generic: {
          collections: { orders: [{ id: "o1", amount: 30 }] },
          tools: [
            { name: "lookup_order", collection: "orders", action: "get", id_field: "order_id" },
            { name: "issue_refund", collection: "refunds", action: "create", reject: [{ when: { amount: { gt: 100 } }, status: 403, message: "over limit" }] },
            { name: "weather", responses: [{ temp: 1 }, { temp: 2 }] },
          ],
        },
      },
    });
    expect((await w.dispatch("lookup_order", { order_id: "o1" }, { transport: "api" })).output).toMatchObject({ amount: 30 });
    expect((await w.dispatch("issue_refund", { amount: 500 }, { transport: "api" })).status).toBe(403);
    expect((await w.dispatch("issue_refund", { amount: 30, order_id: "o1" }, { transport: "api" })).ok).toBe(true);
    expect(w.effects.map((e) => e.kind)).toEqual(["generic.refunds.create"]);
    const temps = [];
    for (let i = 0; i < 3; i++) temps.push(((await w.dispatch("weather", {}, { transport: "api" })).output as any).temp);
    expect(temps).toEqual([1, 2, 2]);
    expect(w.tools().map((t) => t.tool!.name)).toContain("generic_create");
  });
});

describe("graphql reader", () => {
  it("parses variables, inline literals, aliases and fragments, and projects results", () => {
    const op = parseOperation(
      `mutation Create($t: String!) { made: issueCreate(input: { teamId: "ENG", title: $t, priority: 2, labelIds: ["a"] }) { success issue { id identifier ...F } } }
       fragment F on Issue { title }`,
      { t: "Hello" },
    );
    expect(op.type).toBe("mutation");
    expect(op.fields[0]).toMatchObject({ alias: "made", name: "issueCreate", args: { input: { teamId: "ENG", title: "Hello", priority: 2, labelIds: ["a"] } } });
    expect(project({ success: true, extra: 1, issue: { id: "1", identifier: "ENG-1", title: "x" } }, [{ name: "success", args: {} }, { name: "issue", args: {}, selection: [{ name: "id", args: {} }] }])).toEqual({ success: true, issue: { id: "1" } });
  });
});
