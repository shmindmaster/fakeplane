import { afterEach, describe, expect, it } from "vitest";
import { createWorld, type Seed } from "../src/backends/index.js";
import { FakeServer, type ServerUrls } from "../src/server.js";

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(seed: Seed, faults: any[] = []): Promise<ServerUrls> {
  server = new FakeServer(createWorld({ seed, faults }));
  return server.start();
}

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any, headers: res.headers });

describe("HTTP fakes", () => {
  it("speaks Zendesk REST, including .json paths and audits", async () => {
    const u = await start({ zendesk: { tickets: [{ id: 7, subject: "Help", status: "open" }] } });
    const got = await json(await fetch(`${u.zendesk}/api/v2/tickets/7.json`));
    expect(got.body.ticket).toMatchObject({ id: 7, subject: "Help" });
    const upd = await json(
      await fetch(`${u.base}/api/v2/tickets/7`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: { status: "pending", comment: { body: "Checking", public: false } } }) }),
    );
    expect(upd.body.ticket.status).toBe("pending");
    expect(upd.body.audit.events).toEqual([{ type: "Change", field_name: "status", value: "pending", previous_value: "open" }]);
    const comments = await json(await fetch(`${u.zendesk}/api/v2/tickets/7/comments`));
    expect(comments.body.comments.at(-1)).toMatchObject({ body: "Checking", public: false });
    const missing = await json(await fetch(`${u.zendesk}/api/v2/tickets/404`));
    expect(missing).toMatchObject({ status: 404, body: { error: "RecordNotFound" } });
    expect(server!.world.effects.map((e) => e.kind)).toEqual(["zendesk.ticket.note", "zendesk.ticket.update"]);
  });

  it("speaks Slack Web API with form encoding and ok:false errors", async () => {
    const u = await start({ slack: { channels: [{ id: "C1", name: "ops" }] } });
    const posted = await json(await fetch(`${u.slack}/chat.postMessage`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "channel=ops&text=deploy%20done" }));
    expect(posted.body).toMatchObject({ ok: true, channel: "C1" });
    const bad = await json(await fetch(`${u.slack}/chat.postMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "nope", text: "x" }) }));
    expect(bad).toMatchObject({ status: 200, body: { ok: false, error: "channel_not_found" } });
  });

  it("speaks Linear GraphQL with per-field recording and projection", async () => {
    const u = await start({ linear: { teams: [{ id: "team_1", key: "ENG", name: "Eng" }] } });
    const gql = (query: string, variables?: object) => fetch(u.linear, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }).then(json);
    const created = await gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier state { name } } } }`, { input: { teamId: "team_1", title: "Crash" } });
    expect(created.body).toEqual({ data: { issueCreate: { success: true, issue: { identifier: "ENG-1", state: { name: "Todo" } } } } });
    const list = await gql(`{ issues(filter: { team: { key: { eq: "ENG" } } }) { nodes { identifier title } } }`);
    expect(list.body.data.issues.nodes).toEqual([{ identifier: "ENG-1", title: "Crash" }]);
    const missing = await gql(`{ issue(id: "ENG-99") { id } }`);
    expect(missing.body).toMatchObject({ data: { issue: null }, errors: [{ extensions: { code: "ENTITY_NOT_FOUND" } }] });
    const unsupported = await gql(`{ cycles { nodes { id } } }`);
    expect(unsupported.status).toBe(400);
    expect(server!.world.calls.map((c) => c.op)).toEqual(["linear.issue.create", "linear.issue.list", "linear.issue.get"]);
  });

  it("serves generic collections and custom routes at their literal path", async () => {
    const u = await start({
      generic: {
        collections: { orders: [{ id: "o1", amount: 10 }] },
        routes: [{ method: "POST", path: "/v1/refunds", response: { id: "{{id}}", amount: "{{body.amount}}", status: "succeeded" }, effect: "refund" }],
      },
    });
    expect((await json(await fetch(`${u.generic}/orders/o1`))).body).toMatchObject({ amount: 10 });
    const r = await json(await fetch(`${u.base}/v1/refunds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 10 }) }));
    expect(r).toMatchObject({ status: 201, body: { amount: 10, status: "succeeded" } });
    expect(server!.world.effects.map((e) => e.kind)).toEqual(["generic.refund"]);
    expect((await fetch(`${u.base}/nothing/here`)).status).toBe(404);
  });

  it("applies rate limits, idempotency keys and dropped connections over HTTP", async () => {
    const u = await start({ generic: { collections: { refunds: [] } } }, [
      { op: "generic.create", kind: "rate_limit", retryAfter: 2 },
      { op: "generic.update", kind: "timeout", drop: true },
    ]);
    const post = () => fetch(`${u.generic}/refunds`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "k1" }, body: JSON.stringify({ amount: 1 }) });
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    expect(server!.world.effects).toHaveLength(1);
    await expect(fetch(`${u.generic}/refunds/refunds_1`, { method: "PATCH", body: "{}" })).rejects.toThrow();
  });

  it("exposes control endpoints", async () => {
    const u = await start({ zendesk: {} });
    await fetch(`${u.zendesk}/api/v2/tickets`);
    const health = await json(await fetch(`${u.base}/_fakeplane/health`));
    expect(health.body).toMatchObject({ ok: true, calls: 1 });
    const report = await json(await fetch(`${u.base}/_fakeplane/report`));
    expect(report.body.calls[0]).toMatchObject({ op: "zendesk.ticket.list", transport: "http" });
  });
});
