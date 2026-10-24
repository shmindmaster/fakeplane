import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenarios } from "../src/runner.js";
import { loadScenarios, normalizeScenario } from "../src/scenario.js";
import { parseTrace, traceToScenario } from "../src/trace.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

describe("parseTrace", () => {
  it("reads OTLP GenAI tool spans, user messages and HTTP client spans", () => {
    const t = parseTrace(fixture("otlp-duplicate-refund.json"));
    expect(t.format).toBe("otlp");
    expect(t.events.map((e) => (e.type === "tool" ? `tool:${e.name}${e.error ? "!" : ""}` : e.type === "http" ? `http:${e.method}:${e.status}` : "user"))).toEqual([
      "user",
      "tool:get_order",
      "tool:refund_payment!",
      "tool:refund_payment",
      "http:PUT:429",
      "http:POST:200",
    ]);
  });

  it("reads OpenAI and Anthropic transcripts", () => {
    const o = parseTrace(fixture("openai-transcript.json"));
    expect(o.format).toBe("openai");
    expect(o.events.filter((e) => e.type === "tool").map((e: any) => [e.name, Boolean(e.error)])).toEqual([
      ["lookup_shipment", false],
      ["send_customer_email", true],
      ["send_customer_email", false],
    ]);
    const a = parseTrace(fixture("anthropic-transcript.json"));
    expect(a.format).toBe("anthropic");
    expect(a.events.filter((e) => e.type === "tool")).toHaveLength(2);
  });

  it("rejects unknown formats", () => {
    expect(() => parseTrace({ foo: 1 })).toThrow(/Unrecognized trace format/);
  });
});

describe("traceToScenario", () => {
  it("builds a valid, redacted regression scenario with faults and starter assertions", () => {
    const { scenario, yaml, notes } = traceToScenario(parseTrace(fixture("otlp-duplicate-refund.json")), { source: "incident.json" });
    expect(() => normalizeScenario(scenario, "generated.yaml")).not.toThrow();
    expect(yaml).not.toContain("casey.morgan@example.net");
    expect(yaml).toContain("customer1@example.com");
    expect(notes.join(" ")).toMatch(/Replaced 1 PII-shaped value/);
    const s: any = scenario;
    expect(s.seed.generic.tools.map((t: any) => [t.name, t.effect ?? null])).toEqual([
      ["get_order", null],
      ["refund_payment", "refund_payment"],
    ]);
    expect(s.seed.zendesk.tickets[0].id).toBe(55);
    expect(s.faults).toEqual(
      expect.arrayContaining([
        { op: "refund_payment", kind: "timeout", committed: true, after: 0, times: 1 },
        { op: "zendesk.ticket.update", kind: "rate_limit", retryAfter: 1, after: 0, times: 1 },
      ]),
    );
    expect(s.assert).toEqual(expect.arrayContaining([{ name: "at most 1 refund_payment write(s) (incident had 2)", effects: "generic.refund_payment", max: 1 }]));
  });

  it("turns repeated user messages into duplicate deliveries and maps built-in tools", () => {
    const { scenario } = traceToScenario(parseTrace(fixture("anthropic-transcript.json")));
    const s: any = scenario;
    expect(s.turns).toEqual([{ via: "none", text: "Close ticket 9, it's resolved.", deliver: 2 }]);
    expect(s.seed.zendesk.tickets).toEqual([{ id: 9, subject: "(from trace)", status: "open", tags: [], description: "" }]);
    expect(s.assert).toEqual(expect.arrayContaining([{ name: "at most 1 zendesk_update_ticket call(s) (incident had 2)", calls: "zendesk_update_ticket", max: 1 }]));
  });

  it("produces a scenario that reproduces the incident and passes once the agent is fixed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakeplane-trace-"));
    const { yaml } = traceToScenario(parseTrace(fixture("otlp-duplicate-refund.json")));
    writeFileSync(join(dir, "regression.yaml"), yaml);
    const agent = (fixed: boolean) => `
      const rpc = async (url, method, params) => (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
      export default async function (turn) {
        const call = (name, args) => rpc(turn.urls.mcp, "tools/call", { name, arguments: args });
        await call("get_order", { order_id: "A-77" });
        const first = await call("refund_payment", { order_id: "A-77", amount: 19.99 });
        if (first.isError && ${!fixed}) await call("refund_payment", { order_id: "A-77", amount: 19.99 });
        return "done";
      }`;
    writeFileSync(join(dir, "buggy.mjs"), agent(false));
    writeFileSync(join(dir, "fixed.mjs"), agent(true));
    const scenarios = loadScenarios([join(dir, "regression.yaml")]);
    const buggy = await runScenarios(scenarios, { agent: { module: join(dir, "buggy.mjs") } });
    expect(buggy.scenarios[0].status).toBe("fail");
    expect(buggy.scenarios[0].shown.assertions.filter((a) => !a.ok).map((a) => a.name)).toContain("at most 1 refund_payment write(s) (incident had 2)");
    const fixed = await runScenarios(scenarios, { agent: { module: join(dir, "fixed.mjs") } });
    expect(fixed.scenarios[0].shown.assertions.filter((a) => !a.ok)).toEqual([]);
  });
});
