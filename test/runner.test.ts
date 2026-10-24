import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toJUnit, toMarkdown } from "../src/report.js";
import { runScenarios } from "../src/runner.js";
import { loadScenarios, normalizeScenario, ScenarioError } from "../src/scenario.js";

const root = join(import.meta.dirname, "..");
const demo = loadScenarios([join(root, "demo", "scenarios")]);
const agentCmd = (name: string) => `"${process.execPath}" "${join(root, "demo", "agents", name)}"`;

function tmpScenario(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fakeplane-"));
  const file = join(dir, "s.yaml");
  writeFileSync(file, yaml);
  return file;
}

describe("runner with the demo agents", () => {
  it("fails the naive agent for the right reasons", async () => {
    const report = await runScenarios(demo, { agent: { command: agentCmd("naive.mjs") } });
    expect(report.failed).toBe(3);
    const failedNames = (name: string) => report.scenarios.find((s) => s.name === name)!.shown.assertions.filter((a) => !a.ok).map((a) => a.name);
    expect(failedNames("refund reply times out after it was saved")).toEqual(["customer gets exactly one reply", "no duplicate side effects"]);
    expect(failedNames("duplicate webhook and a rate-limited refund")).toContain("exactly one refund despite two webhooks");
    expect(failedNames("large refund is escalated, not issued")).toEqual(
      expect.arrayContaining(["no refund above the $100 limit", "no customer contact details sent to Slack or the customer thread"]),
    );
  });

  it("passes the careful agent", async () => {
    const report = await runScenarios(demo, { agent: { command: agentCmd("careful.mjs") } });
    expect(report.scenarios.map((s) => [s.name, s.status])).toEqual(report.scenarios.map((s) => [s.name, "pass"]));
  });

  it("writes JUnit and Markdown reports", async () => {
    const report = await runScenarios(demo.slice(0, 1), { agent: { command: agentCmd("naive.mjs") } });
    const xml = toJUnit(report);
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain('<testsuite name="large refund is escalated, not issued"');
    expect(xml).toContain("<failure message=");
    expect(toMarkdown(report)).toContain("❌");
  });
});

describe("runner agent adapters", () => {
  it("calls a JS module agent and passes urls and history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakeplane-mod-"));
    writeFileSync(
      join(dir, "agent.mjs"),
      `export default async function (turn) {
         await fetch(turn.urls.slack + "/chat.postMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: turn.event.event.channel, text: "echo: " + turn.text, thread_ts: turn.event.event.ts }) });
         return "turn " + turn.turn + " history " + turn.history.length;
       }`,
    );
    const file = join(dir, "s.yaml");
    writeFileSync(
      file,
      `name: module agent
agent: { module: ./agent.mjs }
seed: { slack: { channels: [{ id: C1, name: help }] } }
turns:
  - { channel: help, user: U1, text: hello }
  - { channel: help, user: U1, text: again }
assert:
  - { effects: slack.message.post, count: 2 }
  - { effects: slack.message.post, where: { text: "echo: again", thread_ts: { exists: true } }, count: 1 }
  - { agent_output: "history 1" }
`,
    );
    const report = await runScenarios(loadScenarios([file]));
    expect(report.scenarios[0].shown.assertions.filter((a) => !a.ok)).toEqual([]);
    expect(report.scenarios[0].status).toBe("pass");
  });

  it("posts turns to an HTTP agent, including concurrent duplicate deliveries", async () => {
    const seen: any[] = [];
    const agent = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen.push(JSON.parse(body));
      res.end("ok");
    });
    await new Promise<void>((r) => agent.listen(0, "127.0.0.1", () => r()));
    const port = (agent.address() as any).port;
    const file = tmpScenario(`turns:
  - { text: "hi", deliver: 3, concurrent: true }
assert:
  - { calls: "*", count: 0 }
`);
    const report = await runScenarios(loadScenarios([file]), { agent: { url: `http://127.0.0.1:${port}/` } });
    agent.close();
    expect(report.scenarios[0].status).toBe("pass");
    expect(seen.map((p) => p.delivery).sort()).toEqual([1, 2, 3]);
    expect(new Set(seen.map((p) => p.deliveryId)).size).toBe(1);
  });

  it("reports agent crashes as errors and repeats with a pass rate", async () => {
    const file = tmpScenario(`turns: ["hi"]
repeat: 3
assert: [{ calls: "*", max: 0 }]
`);
    const crashed = await runScenarios(loadScenarios([file]), { agent: { command: `"${process.execPath}" -e "process.exit(3)"` } });
    expect(crashed.scenarios[0].status).toBe("error");
    expect(crashed.scenarios[0].shown.error).toContain("exited with code 3");
    expect(crashed.scenarios[0].attempts).toHaveLength(3);
    const ok = await runScenarios(loadScenarios([file]), { agent: { command: `"${process.execPath}" -e "process.stdin.resume();process.stdin.on('end',()=>{})"` } });
    expect(ok.scenarios[0].passRate).toBe(1);
  });

  it("fails scenarios without assertions instead of passing them silently", async () => {
    const file = tmpScenario(`turns: ["hi"]\n`);
    const report = await runScenarios(loadScenarios([file]), { agent: { command: `"${process.execPath}" -e "0"` } });
    expect(report.scenarios[0].status).toBe("fail");
  });
});

describe("scenario validation", () => {
  it("gives readable errors", () => {
    expect(() => normalizeScenario({ assert: [{ effects: "x", calls: "y" }] }, "bad.yaml")).toThrow(ScenarioError);
    expect(() => normalizeScenario({ faults: [{ kind: "explode", op: "x" }] }, "bad.yaml")).toThrow(/faults\.0\.kind/);
    expect(() => normalizeScenario({ turnz: [] }, "bad.yaml")).toThrow(/turnz/);
  });

  it("infers turn channels and expands duplicate_delivery", () => {
    const s = normalizeScenario({ seed: { zendesk: {} }, turns: ["hello", { channel: "x", text: "y" }], faults: [{ kind: "duplicate_delivery", turn: 1, copies: 3 }] }, "s.yaml");
    expect(s.turns.map((t) => [t.via, t.deliver])).toEqual([
      ["zendesk", 3],
      ["slack", undefined],
    ]);
    expect(s.faults).toEqual([]);
  });
});
