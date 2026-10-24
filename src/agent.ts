import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSpec } from "./scenario.js";
import type { ServerUrls } from "./server.js";
import type { JsonObject } from "./types.js";
import { truncate } from "./util.js";

export interface TurnPayload {
  fakeplane: string;
  scenario: string;
  turn: number;
  delivery: number;
  /** Same for every copy of a duplicated delivery, like a webhook event id. */
  deliveryId: string;
  via: string;
  text?: string;
  event: JsonObject;
  history: { turn: number; text?: string; output: string }[];
  urls: ServerUrls;
}

export interface AgentResult {
  output: string;
  error?: string;
  durationMs: number;
}

const MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT = 120_000;

export function agentEnv(urls: ServerUrls, scenario: string): Record<string, string> {
  return {
    FAKEPLANE_URL: urls.base,
    FAKEPLANE_MCP_URL: urls.mcp,
    FAKEPLANE_ZENDESK_URL: urls.zendesk,
    FAKEPLANE_SLACK_URL: urls.slack,
    FAKEPLANE_LINEAR_URL: urls.linear,
    FAKEPLANE_GENERIC_URL: urls.generic,
    FAKEPLANE_SCENARIO: scenario,
  };
}

const moduleCache = new Map<string, Promise<(payload: TurnPayload, ctx: { env: Record<string, string> }) => unknown>>();

export function describeAgent(spec: AgentSpec): string {
  return spec.command ?? spec.url ?? spec.module ?? "(none)";
}

export async function invokeAgent(spec: AgentSpec, payload: TurnPayload, baseDir: string): Promise<AgentResult> {
  const started = Date.now();
  const env = { ...agentEnv(payload.urls, payload.scenario), FAKEPLANE_TURN_INDEX: String(payload.turn), FAKEPLANE_DELIVERY_ID: payload.deliveryId, ...(spec.env ?? {}) };
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT;
  try {
    if (spec.command) {
      const r = await runCommand(spec.command, JSON.stringify(payload), { cwd: resolve(baseDir, spec.cwd ?? "."), env, timeoutMs });
      return { ...r, durationMs: Date.now() - started };
    }
    if (spec.url) {
      const res = await fetch(spec.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fakeplane-Delivery-Id": payload.deliveryId },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = truncate(await res.text(), MAX_OUTPUT);
      return { output: text, error: res.ok ? undefined : `agent URL returned HTTP ${res.status}`, durationMs: Date.now() - started };
    }
    if (spec.module) {
      const file = resolve(baseDir, spec.module);
      if (!moduleCache.has(file)) {
        moduleCache.set(
          file,
          import(pathToFileURL(file).href).then((mod) => {
            const fn = mod.default ?? mod.handleTurn;
            if (typeof fn !== "function") throw new Error(`${spec.module} must export a default function (payload, ctx) => output`);
            return fn;
          }),
        );
      }
      const fn = await moduleCache.get(file)!;
      const out = await withTimeout(Promise.resolve(fn(payload, { env })), timeoutMs);
      return { output: out === undefined || out === null ? "" : typeof out === "string" ? out : JSON.stringify(out), durationMs: Date.now() - started };
    }
    return { output: "", error: "no agent configured: set `agent` in the scenario or config, or pass --agent", durationMs: 0 };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`agent timed out after ${ms}ms`)), ms)))]).finally(() => clearTimeout(timer));
}

function runCommand(command: string, stdin: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<{ output: string; error?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ output: stdout, error: `failed to start agent: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = stderr.trim().split("\n").slice(-8).join("\n");
      if (timedOut) return resolvePromise({ output: stdout.trim(), error: `agent timed out after ${opts.timeoutMs}ms` });
      if (code !== 0) return resolvePromise({ output: stdout.trim(), error: `agent exited with code ${code}${tail ? `: ${truncate(tail, 2000)}` : ""}` });
      resolvePromise({ output: stdout.trim() });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}