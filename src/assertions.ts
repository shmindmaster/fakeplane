import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { matchValue } from "./matchers.js";
import { scanValue, type PiiFinding } from "./pii.js";
import type { Assertion } from "./scenario.js";
import type { CallRecord, Effect, TurnRecord } from "./types.js";
import { getPath, globMatch, stableStringify, truncate } from "./util.js";
import type { World } from "./world.js";

export interface AssertionResult {
  name: string;
  ok: boolean;
  message: string;
  /** Effect or call sequence numbers that explain the result. */
  evidence?: { effects?: number[]; calls?: number[] };
}

export interface AssertionContext {
  world: World;
  turns: TurnRecord[];
  /** Directory relative to which `script` paths resolve. */
  dir: string;
}

const DEFAULT_DUPLICATE_IGNORE = ["comment_id", "ts", "id", "identifier", "created_at", "updated_at"];

function describeCount(a: Assertion): string {
  if (a.count !== undefined) return a.count === 0 ? "no" : `exactly ${a.count}`;
  if (a.min !== undefined && a.max !== undefined) return `${a.min}-${a.max}`;
  if (a.max !== undefined) return `at most ${a.max}`;
  return `at least ${a.min ?? 1}`;
}

function countOk(a: Assertion, n: number): boolean {
  if (a.count !== undefined) return n === a.count;
  if (a.min === undefined && a.max === undefined) return n >= 1;
  return (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max);
}

function whereText(where: unknown): string {
  return where === undefined ? "" : ` matching ${truncate(JSON.stringify(where), 100)}`;
}

function defaultName(a: Assertion): string {
  if (a.effects !== undefined) return `${describeCount(a)} ${a.effects} effect(s)${whereText(a.where)}`;
  if (a.calls !== undefined) return `${describeCount(a)} ${a.calls} call(s)${whereText(a.where)}`;
  if (a.state !== undefined) return a.exists === false ? `${a.state} does not exist` : `state ${a.state}${whereText(a.match)}`;
  if (a.no_pii !== undefined) return "no PII in outbound writes";
  if (a.no_duplicate_effects !== undefined) return "no duplicate side effects";
  if (a.agent_output !== undefined) return `agent output${whereText(a.agent_output)}`;
  return `script ${a.script}`;
}

function listEffects(effects: Effect[]): string {
  const shown = effects.slice(0, 6).map((e) => `effect #${e.seq} (call #${e.callSeq}${e.turn ? `, turn ${e.turn}` : ""})`);
  return shown.join(", ") + (effects.length > 6 ? `, +${effects.length - 6} more` : "");
}

function summarizeCall(c: CallRecord): string {
  return `#${c.seq} ${c.tool ?? c.op} -> ${c.status}${c.fault ? ` (fault: ${c.fault})` : ""}${c.replayed ? " (idempotent replay)" : ""}`;
}

function inTurn<T extends { turn?: number }>(items: T[], turn: number | undefined): T[] {
  return turn === undefined ? items : items.filter((i) => i.turn === turn);
}

export async function evaluateAssertion(a: Assertion, ctx: AssertionContext): Promise<AssertionResult> {
  const name = a.name ?? defaultName(a);
  const { world } = ctx;

  if (a.effects !== undefined) {
    const pattern = a.effects;
    const matched = inTurn(world.effects, a.turn).filter((e) => globMatch(pattern, e.kind) && (a.where === undefined || matchValue(e.data, a.where).ok));
    const ok = countOk(a, matched.length);
    const detail = matched.length ? `: ${listEffects(matched)}; first: ${truncate(JSON.stringify(matched[0].data), 90)}` : "";
    return {
      name,
      ok,
      message: ok ? `${matched.length} matching effect(s)` : `expected ${describeCount(a)} ${pattern} effect(s)${whereText(a.where)}, found ${matched.length}${detail}`,
      evidence: { effects: matched.map((e) => e.seq) },
    };
  }

  if (a.calls !== undefined) {
    const pattern = a.calls;
    const matched = inTurn(world.calls, a.turn).filter(
      (c) =>
        (globMatch(pattern, c.op) || (c.tool !== undefined && globMatch(pattern, c.tool))) &&
        (a.where === undefined || matchValue(c.input, a.where).ok) &&
        (a.ok === undefined || c.ok === a.ok),
    );
    const ok = countOk(a, matched.length);
    const detail = matched.length ? `: ${matched.slice(0, 5).map(summarizeCall).join("; ")}` : "";
    return {
      name,
      ok,
      message: ok ? `${matched.length} matching call(s)` : `expected ${describeCount(a)} ${pattern} call(s)${whereText(a.where)}, found ${matched.length}${detail}`,
      evidence: { calls: matched.map((c) => c.seq) },
    };
  }

  if (a.state !== undefined) {
    const value = getPath(world.snapshot(), a.state);
    if (a.exists === false) {
      return value === undefined ? { name, ok: true, message: "absent" } : { name, ok: false, message: `expected ${a.state} not to exist` };
    }
    if (value === undefined) return { name, ok: false, message: `${a.state} does not exist` };
    if (a.match === undefined) return { name, ok: true, message: "exists" };
    const r = matchValue(value, a.match);
    return { name, ok: r.ok, message: r.ok ? "matches" : `${a.state}: ${r.reason}` };
  }

  if (a.no_pii !== undefined) {
    const opts = a.no_pii === true ? {} : a.no_pii;
    const values = [...(opts.values ?? [])];
    if (opts.seeded !== false) for (const b of world.backends.values()) values.push(...(b.seededSensitiveValues?.() ?? []));
    const pattern = opts.effects ?? "*";
    const findings: (PiiFinding & { effect: number })[] = [];
    for (const e of inTurn(world.effects, a.turn)) {
      if (!globMatch(pattern, e.kind)) continue;
      // Internal notes stay inside the helpdesk; scan them only when asked explicitly.
      if (opts.effects === undefined && e.kind === "zendesk.ticket.note") continue;
      for (const f of scanValue(e.data, { allow: opts.allow, values, types: opts.types })) findings.push({ ...f, effect: e.seq });
    }
    const unique = new Map<string, (typeof findings)[number]>();
    for (const f of findings) {
      const key = `${f.effect}:${/[a-z]/i.test(f.match) ? f.match.toLowerCase() : f.match.replace(/\D/g, "")}`;
      if (!unique.has(key)) unique.set(key, f);
    }
    const list = [...unique.values()];
    return {
      name,
      ok: list.length === 0,
      message: list.length === 0 ? "no PII-shaped values found" : `found ${list.length} PII-shaped value(s): ${list.slice(0, 5).map((f) => `${f.type} "${mask(f.match)}" in effect #${f.effect} ${f.path}`).join("; ")}`,
      evidence: { effects: [...new Set(list.map((f) => f.effect))] },
    };
  }

  if (a.no_duplicate_effects !== undefined) {
    const opts = a.no_duplicate_effects === true ? {} : a.no_duplicate_effects;
    const ignore = new Set(opts.ignore ?? DEFAULT_DUPLICATE_IGNORE);
    const pattern = opts.effects ?? "*";
    const groups = new Map<string, Effect[]>();
    for (const e of inTurn(world.effects, a.turn)) {
      if (!globMatch(pattern, e.kind)) continue;
      const data = Object.fromEntries(Object.entries(e.data).filter(([k]) => !ignore.has(k)));
      const key = `${e.kind}\u0000${e.target ?? ""}\u0000${stableStringify(data)}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1);
    return {
      name,
      ok: dups.length === 0,
      message: dups.length === 0 ? "every side effect is unique" : `duplicate side effects: ${dups.slice(0, 3).map((g) => `${g.length}x ${g[0].kind}${g[0].target ? ` ${g[0].target}` : ""} (${listEffects(g)})`).join("; ")}`,
      evidence: { effects: dups.flat().map((e) => e.seq) },
    };
  }

  if (a.agent_output !== undefined) {
    const text = ctx.turns.filter((t) => a.turn === undefined || t.turn === a.turn).map((t) => t.output).join("\n");
    const expected = typeof a.agent_output === "string" ? { contains: a.agent_output } : a.agent_output;
    const r = matchValue(text, expected);
    return { name, ok: r.ok, message: r.ok ? "matches" : `agent output: ${r.reason}` };
  }

  const file = resolve(ctx.dir, a.script!);
  const mod = await import(pathToFileURL(file).href);
  const fn = mod.default ?? mod.check;
  if (typeof fn !== "function") return { name, ok: false, message: `${a.script} must export a default function` };
  const out = await fn({ calls: world.calls, effects: world.effects, state: world.snapshot(), turns: ctx.turns });
  if (out === true || out === undefined) return { name, ok: true, message: "script passed" };
  if (out === false) return { name, ok: false, message: "script returned false" };
  if (typeof out === "string") return { name, ok: false, message: out };
  return { name, ok: Boolean(out.ok), message: String(out.message ?? (out.ok ? "script passed" : "script failed")) };
}

export async function evaluateAssertions(assertions: Assertion[], ctx: AssertionContext): Promise<AssertionResult[]> {
  const out: AssertionResult[] = [];
  for (const a of assertions) {
    try {
      out.push(await evaluateAssertion(a, ctx));
    } catch (err) {
      out.push({ name: a.name ?? defaultName(a), ok: false, message: `assertion error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

function mask(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(Math.min(value.length - 4, 12)) + value.slice(-2);
}
