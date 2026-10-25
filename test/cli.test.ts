import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
// Plain output for text assertions, even where the runner sets FORCE_COLOR.
const plainEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
};
const cli = (args: string[], cwd = root, env = plainEnv()) => spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], { cwd, encoding: "utf8", env });

describe("cli", () => {
  it("prints version and help", () => {
    expect(cli(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli(["--help"]).stdout).toContain("fakeplane run");
    expect(cli(["bogus"]).status).toBe(2);
  });

  it("validates scenarios", () => {
    const r = cli(["validate", "demo/scenarios"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3 scenario(s) valid");
  });

  it("exits 1 and writes JUnit when a scenario fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "fakeplane-cli-"));
    const junit = join(dir, "junit.xml");
    const md = join(dir, "summary.md");
    const r = cli(["run", "demo/scenarios", "--agent", `"${process.execPath}" demo/agents/naive.mjs`, "--junit", junit, "--markdown", md]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL");
    expect(readFileSync(junit, "utf8")).toContain("<testsuites");
    expect(existsSync(md)).toBe(true);
  });

  it("exits 0 when every scenario passes", () => {
    const r = cli(["run", "demo/scenarios", "--agent", `"${process.execPath}" demo/agents/careful.mjs`]);
    expect(r.stdout).toContain("3 passed");
    expect(r.status).toBe(0);
  });

  it("converts a trace to a scenario", () => {
    const r = cli(["from-trace", "test/fixtures/openai-transcript.json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("send_customer_email");
    expect(r.stdout).not.toContain("415-555-0199");
  });

  it("init writes a runnable starter project", () => {
    const dir = mkdtempSync(join(tmpdir(), "fakeplane-init-"));
    expect(cli(["init", dir]).status).toBe(0);
    const r = cli(["run"], dir);
    expect(r.stdout).toContain("1 passed");
    expect(r.status).toBe(0);
  });

  it("runs the MCP SDK example agent against the example scenarios", () => {
    const r = cli(["run", "examples/scenarios", "--agent", `"${process.execPath}" examples/mcp-client/agent.mjs`]);
    expect(r.stdout).toContain("2 passed");
    expect(r.status).toBe(0);
  });

  it("serves fakes with `up` and reports and asserts with `report`", async () => {
    const { spawn } = await import("node:child_process");
    const port = 40000 + Math.floor(Math.random() * 20000);
    const up = spawn(process.execPath, [join(root, "dist", "cli.js"), "up", "--scenario", "demo/scenarios/refund-ambiguous-timeout.yaml", "--port", String(port)], { cwd: root, env: plainEnv() });
    try {
      await new Promise<void>((resolve, reject) => {
        up.stdout.on("data", (d) => String(d).includes("Ctrl+C") && resolve());
        up.on("exit", (code) => reject(new Error(`up exited ${code}`)));
      });
      const base = `http://127.0.0.1:${port}`;
      await fetch(`${base}/_fakeplane/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: 1, from: "jordan.rivera@example.com", text: "refund ord_1001" }) });
      await fetch(`${base}/zendesk/api/v2/tickets/1`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: { comment: { body: "done" } } }) });
      const r = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "report", "--url", base, "--assert", "demo/scenarios/refund-ambiguous-timeout.yaml"], { cwd: root, encoding: "utf8", env: plainEnv() });
      expect(r.stdout).toContain("zendesk.ticket.reply");
      expect(r.stdout).toContain("✓ customer gets exactly one reply");
      expect(r.stdout).toContain("✗ exactly one refund for the order");
      expect(r.status).toBe(1);
    } finally {
      up.kill();
    }
  });

  it("honours FORCE_COLOR when output is not a terminal", () => {
    const ansi = /\x1b\[\d+m/;
    const forced = cli(["validate", "demo/scenarios"], root, { ...plainEnv(), FORCE_COLOR: "1" });
    expect(forced.stdout).toMatch(ansi);
    const off = { ...process.env, FORCE_COLOR: "0" };
    delete off.NO_COLOR;
    expect(cli(["validate", "demo/scenarios"], root, off).stdout).not.toMatch(ansi);
    expect(cli(["validate", "demo/scenarios"]).stdout).not.toMatch(ansi);
  });

  it("runs the demo", () => {
    const r = cli(["demo"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("caught the naive agent");
  });
});
