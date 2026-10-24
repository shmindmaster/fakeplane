import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { BACKEND_NAMES, type Seed } from "./backends/index.js";
import type { FaultSpec } from "./world.js";

const id = z.union([z.string(), z.number()]);
const anyObject = z.record(z.string(), z.unknown());

export const AgentSchema = z
  .object({
    command: z.string().optional(),
    url: z.string().optional(),
    module: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSchema>;

const TurnObject = z
  .object({
    via: z.enum(["zendesk", "slack", "linear", "none"]).optional(),
    text: z.string().optional(),
    // zendesk
    ticket: id.optional(),
    subject: z.string().optional(),
    from: z.union([z.string(), anyObject]).optional(),
    tags: z.array(z.string()).optional(),
    // slack
    channel: z.string().optional(),
    user: z.string().optional(),
    thread_ts: z.string().optional(),
    mention: z.boolean().optional(),
    // linear
    issue: z.string().optional(),
    team: z.string().optional(),
    title: z.string().optional(),
    /** Send this event payload verbatim instead of deriving one from the backend. */
    event: anyObject.optional(),
    /** Deliver the same event this many times (duplicate webhooks). */
    deliver: z.number().int().min(1).max(20).optional(),
    /** Deliver duplicates at the same time instead of one after another. */
    concurrent: z.boolean().optional(),
    delayMs: z.number().int().min(0).optional(),
  })
  .strict();
export type TurnSpec = z.infer<typeof TurnObject>;

const FaultObject = z
  .object({
    op: z.string().optional(),
    backend: z.enum(BACKEND_NAMES).optional(),
    where: anyObject.optional(),
    kind: z.enum(["timeout", "rate_limit", "error", "partial", "latency", "duplicate_delivery"]),
    after: z.number().int().min(0).optional(),
    times: z.union([z.number().int().min(1), z.literal("always")]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    delayMs: z.number().int().min(0).optional(),
    retryAfter: z.number().min(0).optional(),
    committed: z.boolean().optional(),
    drop: z.boolean().optional(),
    message: z.string().optional(),
    // duplicate_delivery
    turn: z.number().int().min(1).optional(),
    copies: z.number().int().min(2).max(20).optional(),
    concurrent: z.boolean().optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.kind === "duplicate_delivery" && f.turn === undefined) ctx.addIssue({ code: "custom", message: "duplicate_delivery needs `turn`" });
    if (f.kind !== "duplicate_delivery" && !f.op && !f.backend) ctx.addIssue({ code: "custom", message: "fault needs `op` or `backend`" });
  });

const matcher = z.unknown();
const countFields = {
  count: z.number().int().min(0).optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
};

export const AssertionSchema = z
  .object({
    name: z.string().optional(),
    effects: z.string().optional(),
    calls: z.string().optional(),
    where: matcher.optional(),
    ok: z.boolean().optional(),
    turn: z.number().int().min(1).optional(),
    ...countFields,
    state: z.string().optional(),
    match: matcher.optional(),
    exists: z.boolean().optional(),
    no_pii: z
      .union([
        z.literal(true),
        z
          .object({
            effects: z.string().optional(),
            allow: z.array(z.string()).optional(),
            values: z.array(z.string()).optional(),
            seeded: z.boolean().optional(),
            types: z.array(z.enum(["email", "phone", "card", "ssn", "iban", "value"])).optional(),
          })
          .strict(),
      ])
      .optional(),
    no_duplicate_effects: z.union([z.literal(true), z.object({ effects: z.string().optional(), ignore: z.array(z.string()).optional() }).strict()]).optional(),
    agent_output: matcher.optional(),
    script: z.string().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const kinds = ["effects", "calls", "state", "no_pii", "no_duplicate_effects", "agent_output", "script"].filter((k) => (a as any)[k] !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({ code: "custom", message: `each assertion needs exactly one of effects, calls, state, no_pii, no_duplicate_effects, agent_output, script (got ${kinds.join(", ") || "none"})` });
    }
    if (a.count !== undefined && (a.min !== undefined || a.max !== undefined)) ctx.addIssue({ code: "custom", message: "use `count` or `min`/`max`, not both" });
  });
export type Assertion = z.infer<typeof AssertionSchema>;

export const ScenarioSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    clock: z.string().optional(),
    backends: z.array(z.enum(BACKEND_NAMES)).optional(),
    agent: AgentSchema.optional(),
    seed: z
      .object({ zendesk: anyObject.optional(), slack: anyObject.optional(), linear: anyObject.optional(), generic: anyObject.optional() })
      .strict()
      .optional(),
    turns: z.array(z.union([z.string(), TurnObject])).optional(),
    faults: z.array(FaultObject).optional(),
    assert: z.array(AssertionSchema).optional(),
    repeat: z.number().int().min(1).max(100).optional(),
    min_pass_rate: z.number().min(0).max(1).optional(),
    allow_agent_errors: z.boolean().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    agent: AgentSchema.optional(),
    assert: z.array(AssertionSchema).optional(),
    repeat: z.number().int().min(1).max(100).optional(),
    scenarios: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();
export type FakeplaneConfig = z.infer<typeof ConfigSchema> & { dir: string };

export interface Scenario {
  name: string;
  description?: string;
  tags: string[];
  clock?: string;
  backends?: (typeof BACKEND_NAMES)[number][];
  agent?: AgentSpec;
  seed: Seed;
  turns: (TurnSpec & { via: NonNullable<TurnSpec["via"]> })[];
  faults: FaultSpec[];
  assert: Assertion[];
  repeat: number;
  minPassRate: number;
  allowAgentErrors: boolean;
}

export interface LoadedScenario {
  file: string;
  dir: string;
  index: number;
  scenario: Scenario;
}

export class ScenarioError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("\n");
}

function inferVia(turn: TurnSpec, seed: Seed): NonNullable<TurnSpec["via"]> {
  if (turn.via) return turn.via;
  if (turn.event) return "none";
  if (turn.ticket !== undefined || turn.subject !== undefined || turn.from !== undefined) return "zendesk";
  if (turn.channel !== undefined || turn.thread_ts !== undefined) return "slack";
  if (turn.issue !== undefined || turn.team !== undefined) return "linear";
  const seeded = (["zendesk", "slack", "linear"] as const).filter((b) => seed[b] !== undefined);
  return seeded.length === 1 ? seeded[0] : "none";
}

export function normalizeScenario(raw: unknown, file: string, index = 0): Scenario {
  const parsed = ScenarioSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ScenarioError(file, `invalid scenario\n${formatZodError(parsed.error)}`);
  const s = parsed.data;
  const seed = (s.seed ?? {}) as Seed;
  const turns = (s.turns ?? []).map((t) => (typeof t === "string" ? { text: t } : { ...t }));
  const faults: FaultSpec[] = [];
  for (const f of s.faults ?? []) {
    if (f.kind === "duplicate_delivery") {
      const turn = turns[f.turn! - 1];
      if (!turn) throw new ScenarioError(file, `duplicate_delivery refers to turn ${f.turn}, but there are ${turns.length} turns`);
      turn.deliver = f.copies ?? 2;
      if (f.concurrent !== undefined) turn.concurrent = f.concurrent;
      continue;
    }
    const { turn: _t, copies: _c, concurrent: _cc, ...rest } = f;
    faults.push(rest as FaultSpec);
  }
  const stem = basename(file, extname(file));
  return {
    name: s.name ?? (index > 0 ? `${stem} #${index + 1}` : stem),
    description: s.description,
    tags: s.tags ?? [],
    clock: s.clock,
    backends: s.backends,
    agent: s.agent,
    seed,
    turns: turns.map((t) => ({ ...t, via: inferVia(t, seed) })),
    faults,
    assert: s.assert ?? [],
    repeat: s.repeat ?? 1,
    minPassRate: s.min_pass_rate ?? 1,
    allowAgentErrors: s.allow_agent_errors ?? false,
  };
}

const SCENARIO_EXT = new Set([".yaml", ".yml", ".json"]);
const CONFIG_NAMES = ["fakeplane.config.yaml", "fakeplane.config.yml", "fakeplane.config.json"];

function collectFiles(path: string, out: string[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (entry.startsWith(".") || entry.startsWith("_") || entry === "node_modules") continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) collectFiles(full, out);
      else if (SCENARIO_EXT.has(extname(entry)) && !CONFIG_NAMES.includes(entry)) out.push(full);
    }
  } else {
    out.push(path);
  }
}

export function parseDocuments(text: string, file: string): unknown[] {
  if (file.endsWith(".json")) {
    try {
      return [JSON.parse(text)];
    } catch (err) {
      throw new ScenarioError(file, `invalid JSON: ${(err as Error).message}`);
    }
  }
  const docs = parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [docs];
  return list
    .map((doc) => {
      if (doc.errors.length) throw new ScenarioError(file, `invalid YAML: ${doc.errors[0].message}`);
      return doc.toJS();
    })
    .filter((d) => d !== null && d !== undefined);
}

export function loadScenarioFile(file: string): LoadedScenario[] {
  const abs = resolve(file);
  const docs = parseDocuments(readFileSync(abs, "utf8"), abs);
  return docs.map((doc, index) => ({ file: abs, dir: dirname(abs), index, scenario: normalizeScenario(doc, abs, index) }));
}

export function loadScenarios(paths: string[]): LoadedScenario[] {
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new ScenarioError(p, "no such file or directory");
    collectFiles(resolve(p), files);
  }
  return files.flatMap((f) => loadScenarioFile(f));
}

export function loadConfig(explicit?: string, cwd = process.cwd()): FakeplaneConfig | undefined {
  const file = explicit ? resolve(explicit) : CONFIG_NAMES.map((n) => join(cwd, n)).find((f) => existsSync(f));
  if (!file) return undefined;
  if (!existsSync(file)) throw new ScenarioError(file, "config file not found");
  const [doc] = parseDocuments(readFileSync(file, "utf8"), file);
  const parsed = ConfigSchema.safeParse(doc ?? {});
  if (!parsed.success) throw new ScenarioError(file, `invalid config\n${formatZodError(parsed.error)}`);
  return { ...parsed.data, dir: dirname(file) };
}
