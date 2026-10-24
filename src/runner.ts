import { evaluateAssertions, type AssertionResult } from "./assertions.js";
import { describeAgent, invokeAgent, type TurnPayload } from "./agent.js";
import { createWorld } from "./backends/index.js";
import { AssertionSchema, type AgentSpec, type Assertion, type LoadedScenario, type Scenario } from "./scenario.js";
import { FakeServer } from "./server.js";
import type { CallRecord, Effect, JsonObject, TurnRecord } from "./types.js";
import { sleep } from "./util.js";
import type { World } from "./world.js";
import { VERSION } from "./version.js";

export type Status = "pass" | "fail" | "error";

export interface AttemptResult {
  attempt: number;
  status: Status;
  durationMs: number;
  assertions: AssertionResult[];
  turns: TurnRecord[];
  calls: CallRecord[];
  effects: Effect[];
  state: Record<string, unknown>;
  error?: string;
}

export interface ScenarioResult {
  file: string;
  name: string;
  status: Status;
  agent: string;
  durationMs: number;
  passRate: number;
  attempts: AttemptResult[];
  /** The attempt the report shows: the first failing one, else the last. */
  shown: AttemptResult;
}

export interface RunReport {
  fakeplane: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  errored: number;
  scenarios: ScenarioResult[];
}

export interface RunOptions {
  /** Overrides the scenario's and config's agent. */
  agent?: AgentSpec;
  /** Used when neither the scenario nor `agent` sets one. */
  defaultAgent?: AgentSpec;
  defaultAgentDir?: string;
  /** Appended to every scenario's assertions. */
  extraAssertions?: Assertion[];
  repeat?: number;
  filter?: string;
  bail?: boolean;
  onScenarioStart?(s: LoadedScenario): void;
  onScenarioDone?(r: ScenarioResult): void;
}

export function buildWorld(scenario: Scenario): World {
  return createWorld({ scenario: scenario.name, clock: scenario.clock, seed: scenario.seed, faults: scenario.faults, backends: scenario.backends });
}

/** Apply a user turn to the world and return the event payload the agent receives. */
export function injectTurn(world: World, turn: Scenario["turns"][number], deliveryId: string): JsonObject {
  if (turn.event) return { ...turn.event };
  if (turn.via !== "none") {
    const backend = world.backends.get(turn.via);
    if (!backend) throw new Error(`turn uses via: ${turn.via}, but the ${turn.via} backend is not enabled in this scenario`);
    if (backend.injectTurn) return backend.injectTurn(turn as any, { world, deliveryId });
  }
  return { type: "message", id: deliveryId, text: turn.text ?? "" };
}

export async function runAttempt(loaded: LoadedScenario, agent: AgentSpec, agentDir: string, extra: Assertion[], attempt: number): Promise<AttemptResult> {
  const { scenario } = loaded;
  const started = Date.now();
  const world = buildWorld(scenario);
  const server = new FakeServer(world);
  const urls = await server.start();
  const turns: TurnRecord[] = [];
  const history: TurnPayload["history"] = [];
  let error: string | undefined;
  try {
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const turnNo = i + 1;
      world.currentTurn = turnNo;
      if (turn.delayMs) await sleep(turn.delayMs);
      const deliveryId = `evt_${String(turnNo).padStart(3, "0")}`;
      const event = injectTurn(world, turn, deliveryId);
      const copies = turn.deliver ?? 1;
      const deliver = async (delivery: number): Promise<TurnRecord> => {
        const payload: TurnPayload = { fakeplane: VERSION, scenario: scenario.name, turn: turnNo, delivery, deliveryId, via: turn.via, text: turn.text, event, history: [...history], urls };
        const r = await invokeAgent(agent, payload, agentDir);
        return { turn: turnNo, delivery, deliveryId, via: turn.via, text: turn.text, event, output: r.output, error: r.error, durationMs: r.durationMs };
      };
      const records: TurnRecord[] = [];
      if (turn.concurrent) records.push(...(await Promise.all(Array.from({ length: copies }, (_, d) => deliver(d + 1)))));
      else for (let d = 1; d <= copies; d++) records.push(await deliver(d));
      turns.push(...records);
      history.push({ turn: turnNo, text: turn.text, output: records.map((r) => r.output).filter(Boolean).join("\n") });
      const failed = records.find((r) => r.error);
      if (failed && !scenario.allowAgentErrors) {
        error = `turn ${turnNo}${copies > 1 ? ` delivery ${failed.delivery}` : ""}: ${failed.error}`;
        break;
      }
    }
    world.currentTurn = undefined;
    const assertions = await evaluateAssertions([...scenario.assert, ...extra], { world, turns, dir: loaded.dir });
    if (assertions.length === 0 && !error) {
      assertions.push({ name: "scenario has assertions", ok: false, message: "add at least one entry under `assert:`; a scenario without assertions cannot fail" });
    }
    const status: Status = error ? "error" : assertions.every((a) => a.ok) ? "pass" : "fail";
    return { attempt, status, durationMs: Date.now() - started, assertions, turns, calls: world.calls, effects: world.effects, state: world.snapshot(), error };
  } finally {
    await server.stop();
  }
}

export async function runScenario(loaded: LoadedScenario, options: RunOptions = {}): Promise<ScenarioResult> {
  const { scenario } = loaded;
  const agent = options.agent ?? scenario.agent ?? options.defaultAgent ?? {};
  const agentDir = options.agent ? process.cwd() : scenario.agent ? loaded.dir : (options.defaultAgentDir ?? process.cwd());
  const repeat = options.repeat ?? scenario.repeat;
  const extra = (options.extraAssertions ?? []).map((a) => AssertionSchema.parse(a));
  const started = Date.now();
  const attempts: AttemptResult[] = [];
  for (let i = 1; i <= repeat; i++) attempts.push(await runAttempt(loaded, agent, agentDir, extra, i));
  const passes = attempts.filter((a) => a.status === "pass").length;
  const passRate = passes / attempts.length;
  const anyError = attempts.some((a) => a.status === "error");
  const status: Status = passRate >= scenario.minPassRate ? "pass" : anyError && passes === 0 ? "error" : "fail";
  const shown = attempts.find((a) => a.status !== "pass") ?? attempts[attempts.length - 1];
  return { file: loaded.file, name: scenario.name, status, agent: describeAgent(agent), durationMs: Date.now() - started, passRate, attempts, shown };
}

export async function runScenarios(list: LoadedScenario[], options: RunOptions = {}): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results: ScenarioResult[] = [];
  const selected = options.filter ? list.filter((s) => s.scenario.name.includes(options.filter!) || s.file.includes(options.filter!)) : list;
  for (const s of selected) {
    options.onScenarioStart?.(s);
    const r = await runScenario(s, options);
    results.push(r);
    options.onScenarioDone?.(r);
    if (options.bail && r.status !== "pass") break;
  }
  return {
    fakeplane: VERSION,
    startedAt,
    durationMs: Date.now() - started,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    errored: results.filter((r) => r.status === "error").length,
    scenarios: results,
  };
}
