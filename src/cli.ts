#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentEnv } from "./agent.js";
import { evaluateAssertions } from "./assertions.js";
import { createWorld } from "./backends/index.js";
import { McpHandler, serveStdio } from "./mcp.js";
import { color, formatScenario, formatSummary, toJUnit, toMarkdown } from "./report.js";
import { buildWorld, injectTurn, runScenarios, type RunOptions } from "./runner.js";
import { AssertionSchema, loadConfig, loadScenarioFile, loadScenarios, normalizeScenario, ScenarioError, type AgentSpec, type LoadedScenario } from "./scenario.js";
import { FakeServer } from "./server.js";
import { parseTrace, traceToScenario } from "./trace.js";
import { asArray } from "./util.js";
import { VERSION } from "./version.js";
import type { World } from "./world.js";

const HELP = `fakeplane ${VERSION}: stateful fake backends for testing AI agents

Usage:
  fakeplane run [paths...]        Run scenarios against your agent (default: ./scenarios)
      --agent <cmd>               Agent command; gets each turn as JSON on stdin
      --agent-url <url>           Or POST each turn to this URL
      --agent-module <file>       Or call this JS module's default export
      --junit <file>              Write JUnit XML (for CI test reports)
      --json <file>               Write the full JSON report (calls, effects, state)
      --markdown <file>           Write a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)
      --repeat <n>                Run each scenario n times (agents are non-deterministic)
      --filter <text>             Only scenarios whose name or path contains text
      --bail                      Stop at the first failing scenario
      --verbose                   Show passing assertions too
      --config <file>             Config file (default: ./fakeplane.config.yaml if present)
  fakeplane up [--scenario f] [--port 4010] [--host 127.0.0.1] [--record f]
                                  Serve the fakes (HTTP + MCP) for manual or external runs
  fakeplane mcp [--scenario f] [--record f]
                                  Serve the fakes as an MCP server over stdio
  fakeplane report [--url u] [--assert scenario.yaml] [--json]
                                  Show what a running 'up' server recorded; optionally assert
  fakeplane from-trace <trace.json> [-o out.yaml] [--name n] [--no-redact]
                                  Turn a production trace (OTLP JSON or chat transcript) into a scenario
  fakeplane validate [paths...]   Check scenario files without running them
  fakeplane demo                  Run the bundled demo: a naive agent fails, a careful one passes
  fakeplane init [dir]            Write a starter scenario, config and example agent

Exit codes: 0 all passed, 1 a scenario failed, 2 usage or config error.
Docs: https://github.com/shmindmaster/fakeplane`;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

function fail(message: string): never {
  process.stderr.write(`${color.red("error")} ${message}\n`);
  process.exit(2);
}

function quote(p: string): string {
  return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

function agentFromFlags(v: Record<string, unknown>): AgentSpec | undefined {
  if (typeof v.agent === "string") return { command: v.agent };
  if (typeof v["agent-url"] === "string") return { url: v["agent-url"] };
  if (typeof v["agent-module"] === "string") return { module: resolve(v["agent-module"]) };
  return undefined;
}

function writeOut(file: string, content: string): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, content);
}

async function cmdRun(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      "agent-url": { type: "string" },
      "agent-module": { type: "string" },
      junit: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      repeat: { type: "string" },
      filter: { type: "string" },
      bail: { type: "boolean" },
      verbose: { type: "boolean" },
      config: { type: "string" },
      quiet: { type: "boolean" },
    },
  });
  const config = loadConfig(values.config);
  const paths = positionals.length ? positionals : config?.scenarios ? asArray(config.scenarios).map((p) => resolve(config.dir, p)) : ["scenarios"];
  const list = loadScenarios(paths);
  if (list.length === 0) fail(`no scenario files found in ${paths.join(", ")}`);
  const repeat = values.repeat ? Number(values.repeat) : config?.repeat;
  if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1)) fail("--repeat must be a positive integer");
  const options: RunOptions = {
    agent: agentFromFlags(values),
    defaultAgent: config?.agent,
    defaultAgentDir: config?.dir,
    extraAssertions: config?.assert,
    repeat,
    filter: values.filter,
    bail: values.bail,
    onScenarioDone: (r) => {
      if (!values.quiet) process.stdout.write(formatScenario(r, values.verbose) + "\n");
    },
  };
  if (!values.quiet) process.stdout.write(color.dim(`fakeplane ${VERSION}: ${list.length} scenario(s)\n\n`));
  const report = await runScenarios(list, options);
  process.stdout.write(formatSummary(report) + "\n");
  if (values.junit) writeOut(values.junit, toJUnit(report));
  if (values.json) writeOut(values.json, JSON.stringify(report, null, 2));
  if (values.markdown) writeOut(values.markdown, toMarkdown(report));
  return report.failed + report.errored === 0 ? 0 : 1;
}

function scenarioOrEmpty(file: string | undefined): { loaded?: LoadedScenario; build: () => World } {
  if (!file) return { build: () => createWorld({ scenario: "default" }) };
  const [loaded] = loadScenarioFile(file);
  if (!loaded) fail(`${file} contains no scenario`);
  return { loaded, build: () => buildWorld(loaded.scenario) };
}

async function cmdUp(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { scenario: { type: "string" }, port: { type: "string" }, host: { type: "string" }, record: { type: "string" } } });
  const { loaded, build } = scenarioOrEmpty(values.scenario);
  const server = new FakeServer(build(), {
    host: values.host ?? "127.0.0.1",
    port: Number(values.port ?? 4010),
    hooks: {
      reset: build,
      assert: async (world, raw) => {
        const parsed = raw.map((a) => AssertionSchema.parse(a));
        const results = await evaluateAssertions(parsed, { world, turns: [], dir: loaded?.dir ?? process.cwd() });
        return { ok: results.every((r) => r.ok), results };
      },
      injectTurn: (world, raw) => {
        const s = normalizeScenario({ seed: loaded?.scenario.seed, turns: [raw] }, "turn");
        return injectTurn(world, s.turns[0], `evt_manual_${world.calls.length + 1}`);
      },
    },
  });
  const urls = await server.start();
  const out = process.stdout;
  out.write(`${color.bold("fakeplane up")} ${color.dim(loaded ? `scenario: ${loaded.scenario.name}` : "empty world (all backends)")}\n\n`);
  out.write(`  HTTP    ${urls.base}\n  MCP     ${urls.mcp}  (Streamable HTTP)\n  Control ${urls.base}/_fakeplane/{state,calls,effects,report,reset}\n\n`);
  out.write(color.dim("Point your agent at it:\n"));
  for (const [k, v] of Object.entries(agentEnv(urls, loaded?.scenario.name ?? "default"))) out.write(`  ${k}=${v}\n`);
  out.write(color.dim(`\nThen: fakeplane report --url ${urls.base}\nCtrl+C to stop.\n`));
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  if (values.record) writeOut(values.record, JSON.stringify({ calls: server.world.calls, effects: server.world.effects, state: server.world.snapshot() }, null, 2));
  await server.stop();
  return 0;
}

async function cmdMcp(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { scenario: { type: "string" }, record: { type: "string" } } });
  const { loaded, build } = scenarioOrEmpty(values.scenario);
  const world = build();
  process.stderr.write(`fakeplane mcp: ${world.tools().length} tools${loaded ? ` (scenario: ${loaded.scenario.name})` : ""}\n`);
  await serveStdio(new McpHandler(() => world));
  if (values.record) writeOut(values.record, JSON.stringify({ calls: world.calls, effects: world.effects, state: world.snapshot() }, null, 2));
  return 0;
}

async function cmdReport(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { url: { type: "string" }, assert: { type: "string" }, json: { type: "boolean" } } });
  const base = (values.url ?? process.env.FAKEPLANE_URL ?? "http://127.0.0.1:4010").replace(/\/+$/, "");
  let report: any;
  try {
    const res = await fetch(`${base}/_fakeplane/report`);
    report = await res.json();
  } catch {
    fail(`could not reach a fakeplane server at ${base}. Start one with: fakeplane up`);
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${color.bold(`Scenario: ${report.scenario}`)}  ${report.calls.length} calls, ${report.effects.length} side effects\n\n`);
    for (const c of report.calls) {
      const mark = c.ok ? color.green(String(c.status)) : color.red(String(c.status));
      process.stdout.write(`  #${String(c.seq).padEnd(3)} ${mark} ${c.transport.padEnd(4)} ${c.tool ?? c.op}${c.fault ? color.yellow(` [fault: ${c.fault}${c.committed ? ", committed" : ""}]`) : ""}${c.replayed ? color.dim(" [idempotent replay]") : ""}\n`);
    }
    if (report.effects.length) process.stdout.write(`\n${color.bold("Side effects (what the real systems would have seen):")}\n`);
    for (const e of report.effects) process.stdout.write(`  #${String(e.seq).padEnd(3)} ${e.kind} ${color.dim(e.target ?? "")} ${JSON.stringify(e.data).slice(0, 140)}\n`);
  }
  if (!values.assert) return 0;
  const [loaded] = loadScenarioFile(values.assert);
  const res = await fetch(`${base}/_fakeplane/assert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assert: loaded.scenario.assert }) });
  const body: any = await res.json();
  if (!res.ok) fail(body?.error?.message ?? `assert failed with HTTP ${res.status}`);
  process.stdout.write(`\n${color.bold("Assertions:")}\n`);
  for (const r of body.results) process.stdout.write(r.ok ? `  ${color.green("✓")} ${r.name}\n` : `  ${color.red("✗")} ${r.name}\n    ${color.dim(r.message)}\n`);
  return body.ok ? 0 : 1;
}

function readTrace(file: string): unknown {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl") || file.endsWith(".ndjson")) {
    const lines = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (lines.every((l) => Array.isArray(l?.resourceSpans))) return { resourceSpans: lines.flatMap((l) => l.resourceSpans) };
    return lines;
  }
  return JSON.parse(text);
}

async function cmdFromTrace(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { output: { type: "string", short: "o" }, name: { type: "string" }, "no-redact": { type: "boolean" } } });
  const file = positionals[0];
  if (!file) fail("usage: fakeplane from-trace <trace.json> [-o scenario.yaml]");
  let doc: unknown;
  try {
    doc = readTrace(file);
  } catch (err) {
    fail(`could not read ${file}: ${(err as Error).message}`);
  }
  const parsed = parseTrace(doc);
  const result = traceToScenario(parsed, { name: values.name, source: file.replace(/\\/g, "/").split("/").pop(), redact: !values["no-redact"] });
  normalizeScenario(result.scenario, values.output ?? "generated scenario");
  if (values.output) {
    writeOut(values.output, result.yaml);
    process.stderr.write(`${color.green("wrote")} ${values.output} (${parsed.format}: ${parsed.events.length} events)\n`);
  } else {
    process.stdout.write(result.yaml);
  }
  for (const n of result.notes) process.stderr.write(`${color.dim("note:")} ${n}\n`);
  return 0;
}

function cmdValidate(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const list = loadScenarios(positionals.length ? positionals : ["scenarios"]);
  for (const s of list) process.stdout.write(`${color.green("ok")} ${s.scenario.name} ${color.dim(`(${s.scenario.turns.length} turns, ${s.scenario.faults.length} faults, ${s.scenario.assert.length} assertions)`)}\n`);
  process.stdout.write(`${list.length} scenario(s) valid\n`);
  return 0;
}

async function cmdDemo(): Promise<number> {
  const scenarios = loadScenarios([join(packageRoot, "demo", "scenarios")]);
  const node = quote(process.execPath);
  const out = process.stdout;
  out.write(`${color.bold("fakeplane demo")}: the same scenarios against two support agents.\n`);
  out.write(color.dim("Both agents resolve a refund ticket over the fake Zendesk + order API + Slack.\nThe scenarios inject an ambiguous timeout, a duplicate webhook and a large refund.\n\n"));
  out.write(`${color.bold("1. naive agent")} ${color.dim("(retries blindly, no idempotency keys, pastes customer details into Slack)")}\n\n`);
  const naive = await runScenarios(scenarios, { agent: { command: `${node} ${quote(join(packageRoot, "demo", "agents", "naive.mjs"))}` }, onScenarioDone: (r) => out.write(formatScenario(r) + "\n") });
  out.write(formatSummary(naive) + "\n\n");
  out.write(`${color.bold("2. careful agent")} ${color.dim("(reads back before retrying, idempotency keys, redacts, escalates large refunds)")}\n\n`);
  const careful = await runScenarios(scenarios, { agent: { command: `${node} ${quote(join(packageRoot, "demo", "agents", "careful.mjs"))}` }, onScenarioDone: (r) => out.write(formatScenario(r) + "\n") });
  out.write(formatSummary(careful) + "\n\n");
  const shown = naive.failed > 0 && careful.failed + careful.errored === 0;
  out.write(shown ? `${color.green("fakeplane caught the naive agent's bugs before any customer saw them.")}\nNext: fakeplane init, then point the scenario at your agent.\n` : color.red("Unexpected demo result.\n"));
  return shown ? 0 : 1;
}

function cmdInit(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const dir = resolve(positionals[0] ?? ".");
  const files: [string, string][] = [
    [join(packageRoot, "demo", "scenarios", "refund-ambiguous-timeout.yaml"), join(dir, "scenarios", "refund-ambiguous-timeout.yaml")],
    [join(packageRoot, "demo", "agents", "careful.mjs"), join(dir, "example-agent.mjs")],
  ];
  for (const [from, to] of files) {
    if (existsSync(to)) {
      process.stdout.write(`${color.dim("exists")} ${to}\n`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    process.stdout.write(`${color.green("created")} ${to}\n`);
  }
  const config = join(dir, "fakeplane.config.yaml");
  if (!existsSync(config)) {
    writeFileSync(
      config,
      `# fakeplane config: applies to every scenario under scenarios/\nscenarios: scenarios\nagent:\n  # Replace with your agent. It receives each turn as JSON on stdin and\n  # finds the fakes through FAKEPLANE_* environment variables.\n  command: node example-agent.mjs\n# Assertions added to every scenario\nassert:\n  - no_duplicate_effects: true\n  - no_pii: true\n`,
    );
    process.stdout.write(`${color.green("created")} ${config}\n`);
  }
  process.stdout.write(`\nNext: ${color.bold("npx fakeplane run")}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "up":
      return cmdUp(rest);
    case "mcp":
      return cmdMcp(rest);
    case "report":
      return cmdReport(rest);
    case "from-trace":
      return cmdFromTrace(rest);
    case "validate":
      return cmdValidate(rest);
    case "demo":
      return cmdDemo();
    case "init":
      return cmdInit(rest);
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(VERSION + "\n");
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ScenarioError || (err as any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (err as any)?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") fail(err.message);
    process.stderr.write(`${color.red("error")} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(2);
  },
);
