import { stringify } from "yaml";
import { createWorld } from "./backends/index.js";
import { scanValue } from "./pii.js";
import { matchPath } from "./server.js";
import type { JsonObject, JsonSchema } from "./types.js";
import { isPlainObject, stableStringify } from "./util.js";

export type TimelineEvent =
  | { type: "user"; text: string; traceId?: string }
  | { type: "tool"; name: string; args: JsonObject; result?: unknown; error?: string; status?: number; traceId?: string }
  | { type: "http"; method: string; url: string; status?: number; requestBody?: unknown; responseBody?: unknown; error?: string; traceId?: string };

export interface ParsedTrace {
  format: "otlp" | "spans" | "openai" | "anthropic" | "openai-responses" | "fakeplane";
  events: TimelineEvent[];
}

const READ_VERBS = /^(get|list|search|find|lookup|look_up|read|fetch|query|check|describe|retrieve|show|view|count)/i;
const WRITE_VERBS = /(create|update|delete|remove|send|post|reply|respond|refund|charge|cancel|close|solve|set|add|assign|issue|transfer|book|submit|escalate|notify|email|message|pay|write|apply|tag|merge|archive|approve|reject|comment|upsert|insert|patch|put)/i;

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function otlpValue(v: any): unknown {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return Boolean(v.boolValue);
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(otlpValue);
  if ("kvlistValue" in v) return attrs(v.kvlistValue?.values);
  if ("bytesValue" in v) return v.bytesValue;
  return undefined;
}

function attrs(list: unknown): Record<string, unknown> {
  if (Array.isArray(list)) return Object.fromEntries(list.map((kv: any) => [kv.key, otlpValue(kv.value)]));
  return isPlainObject(list) ? list : {};
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.type === "text" || p?.type === "input_text" || p?.type === "output_text" ? (p.text ?? p.content ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (isPlainObject(content)) return String(content.text ?? content.content ?? "");
  return "";
}

function looksLikeError(result: unknown): string | undefined {
  if (typeof result === "string" && /^\s*(error|exception)\b/i.test(result)) return result.slice(0, 300);
  if (isPlainObject(result) && (result.error || result.isError === true)) {
    const e = result.error;
    return typeof e === "string" ? e : isPlainObject(e) ? String(e.message ?? e.code ?? JSON.stringify(e)) : "error";
  }
  return undefined;
}

function userMessagesFromSpan(a: Record<string, unknown>, events: any[]): string[] {
  const out: string[] = [];
  const input = parseMaybeJson(a["gen_ai.input.messages"]);
  if (Array.isArray(input)) {
    for (const m of input as any[]) if (m?.role === "user") out.push(textOf(m.parts ?? m.content));
  }
  for (let i = 0; a[`gen_ai.prompt.${i}.role`] !== undefined; i++) {
    if (a[`gen_ai.prompt.${i}.role`] === "user") out.push(String(a[`gen_ai.prompt.${i}.content`] ?? ""));
  }
  for (const ev of events ?? []) {
    if (ev?.name === "gen_ai.user.message") {
      const ea = attrs(ev.attributes);
      const body = parseMaybeJson(ea["gen_ai.event.content"] ?? ea.content ?? ea.body);
      out.push(isPlainObject(body) ? textOf(body.content ?? body) : String(body ?? ""));
    }
  }
  return out.filter((t) => t.trim() !== "");
}

function parseSpans(spans: any[], format: ParsedTrace["format"]): ParsedTrace {
  const sorted = [...spans].sort((x, y) => {
    const a = BigInt(String(x.startTimeUnixNano ?? x.start_time ?? 0).replace(/\D/g, "") || "0");
    const b = BigInt(String(y.startTimeUnixNano ?? y.start_time ?? 0).replace(/\D/g, "") || "0");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const events: TimelineEvent[] = [];
  const seenUser = new Set<string>();
  for (const span of sorted) {
    const a = attrs(span.attributes);
    const traceId = span.traceId ?? span.trace_id;
    for (const text of userMessagesFromSpan(a, span.events)) {
      const key = `${traceId}\u0000${text}`;
      if (seenUser.has(key)) continue;
      seenUser.add(key);
      events.push({ type: "user", text, traceId });
    }
    const statusCode = span.status?.code;
    const isError = statusCode === 2 || statusCode === "STATUS_CODE_ERROR" || statusCode === "ERROR";
    const errorText = isError ? String(span.status?.message || a["error.type"] || "error") : undefined;
    const httpStatus = Number(a["http.response.status_code"] ?? a["http.status_code"]) || undefined;
    if (a["gen_ai.operation.name"] === "execute_tool" || a["gen_ai.tool.name"] !== undefined) {
      const name = String(a["gen_ai.tool.name"] ?? String(span.name ?? "tool").replace(/^execute_tool\s+/, ""));
      const args = parseMaybeJson(a["gen_ai.tool.call.arguments"] ?? a["tool.arguments"] ?? a["input.value"]);
      const result = parseMaybeJson(a["gen_ai.tool.call.result"] ?? a["tool.result"] ?? a["output.value"]);
      events.push({ type: "tool", name, args: isPlainObject(args) ? args : {}, result, error: errorText ?? looksLikeError(result), status: httpStatus, traceId });
      continue;
    }
    const method = a["http.request.method"] ?? a["http.method"];
    const url = a["url.full"] ?? a["http.url"];
    if (method && url && (span.kind === 3 || span.kind === "SPAN_KIND_CLIENT" || span.kind === "CLIENT" || span.kind === undefined)) {
      events.push({
        type: "http",
        method: String(method).toUpperCase(),
        url: String(url),
        status: httpStatus,
        requestBody: parseMaybeJson(a["http.request.body"]),
        responseBody: parseMaybeJson(a["http.response.body"]),
        error: errorText ?? (httpStatus && httpStatus >= 400 ? `HTTP ${httpStatus}` : undefined),
        traceId,
      });
    }
  }
  return { format, events };
}

function parseMessages(messages: any[]): ParsedTrace {
  const events: TimelineEvent[] = [];
  const pending = new Map<string, Extract<TimelineEvent, { type: "tool" }>>();
  let format: ParsedTrace["format"] = "openai";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    // OpenAI Responses API items
    if (m.type === "function_call") {
      format = "openai-responses";
      const ev = { type: "tool" as const, name: String(m.name), args: (parseMaybeJson(m.arguments) as JsonObject) ?? {} };
      pending.set(String(m.call_id ?? m.id), ev);
      events.push(ev);
      continue;
    }
    if (m.type === "function_call_output") {
      const ev = pending.get(String(m.call_id));
      if (ev) {
        ev.result = parseMaybeJson(m.output);
        ev.error = looksLikeError(ev.result);
      }
      continue;
    }
    const role = m.role;
    if (role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result")) {
      format = "anthropic";
      for (const b of m.content) {
        if (b?.type === "tool_result") {
          const ev = pending.get(String(b.tool_use_id));
          if (ev) {
            ev.result = parseMaybeJson(textOf(b.content) || b.content);
            ev.error = b.is_error ? textOf(b.content) || "error" : looksLikeError(ev.result);
          }
        }
      }
      const text = textOf(m.content.filter((b: any) => b?.type === "text"));
      if (text.trim()) events.push({ type: "user", text });
      continue;
    }
    if (role === "user") {
      const text = textOf(m.content);
      if (text.trim()) events.push({ type: "user", text });
      continue;
    }
    if (role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        const ev = { type: "tool" as const, name: String(tc.function?.name ?? tc.name), args: (parseMaybeJson(tc.function?.arguments ?? tc.arguments) as JsonObject) ?? {} };
        pending.set(String(tc.id), ev);
        events.push(ev);
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "tool_use") {
            format = "anthropic";
            const ev = { type: "tool" as const, name: String(b.name), args: isPlainObject(b.input) ? b.input : {} };
            pending.set(String(b.id), ev);
            events.push(ev);
          }
        }
      }
      continue;
    }
    if (role === "tool") {
      const ev = pending.get(String(m.tool_call_id));
      if (ev) {
        ev.result = parseMaybeJson(textOf(m.content) || m.content);
        ev.error = looksLikeError(ev.result);
      }
    }
  }
  return { format, events };
}

/** Detect the trace format and flatten it into user turns, tool calls and HTTP calls. */
export function parseTrace(doc: any): ParsedTrace {
  if (doc && Array.isArray(doc.resourceSpans)) {
    const spans = doc.resourceSpans.flatMap((rs: any) => (rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []).flatMap((ss: any) => ss.spans ?? []));
    return parseSpans(spans, "otlp");
  }
  if (doc && Array.isArray(doc.events) && doc.events.every((e: any) => e && typeof e.type === "string")) {
    return { format: "fakeplane", events: doc.events.map((e: any) => (e.type === "tool" ? { ...e, args: e.args ?? e.arguments ?? {} } : e)) };
  }
  const list = Array.isArray(doc) ? doc : (doc?.messages ?? doc?.input ?? doc?.spans ?? doc?.data);
  if (Array.isArray(list)) {
    if (list.some((x: any) => x && (x.spanId || x.span_id || x.startTimeUnixNano))) return parseSpans(list, "spans");
    return parseMessages(list);
  }
  throw new Error("Unrecognized trace format: expected OTLP JSON (resourceSpans), a span array, a chat transcript (messages), or { events: [...] }");
}

function redactEvents(events: TimelineEvent[]): { events: TimelineEvent[]; replaced: number } {
  const findings = scanValue(events);
  const map = new Map<string, string>();
  const counters: Record<string, number> = {};
  const placeholder = (type: string) => {
    const n = (counters[type] = (counters[type] ?? 0) + 1);
    switch (type) {
      case "email":
        return `customer${n}@example.com`;
      case "phone":
        return `+1-555-01${String(n).padStart(2, "0")}`;
      case "card":
        return "4111 1111 1111 1111";
      case "ssn":
        return `000-00-${String(n).padStart(4, "0")}`;
      default:
        return `GB00TEST${String(n).padStart(10, "0")}`;
    }
  };
  for (const f of findings) if (!map.has(f.match)) map.set(f.match, placeholder(f.type));
  if (map.size === 0) return { events, replaced: 0 };
  let json = JSON.stringify(events);
  for (const [real, fake] of [...map].sort((a, b) => b[0].length - a[0].length)) {
    json = json.split(JSON.stringify(real).slice(1, -1)).join(JSON.stringify(fake).slice(1, -1));
  }
  return { events: JSON.parse(json), replaced: map.size };
}

function inferSchema(samples: JsonObject[]): JsonSchema {
  const props: Record<string, JsonSchema> = {};
  for (const s of samples) {
    for (const [k, v] of Object.entries(s)) {
      if (props[k]) continue;
      const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "object" ? "object" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
      props[k] = { type: t === "null" ? ["string", "null"] : t };
    }
  }
  const required = Object.keys(props).filter((k) => samples.every((s) => k in s));
  return { type: "object", properties: props, required, additionalProperties: true };
}

function faultFor(error: string, status: number | undefined, write: boolean): JsonObject {
  if (status === 429 || /rate.?limit|too many requests|429/i.test(error)) return { kind: "rate_limit", retryAfter: 1 };
  if (status === 504 || status === 408 || /time(d)?[ -]?out|ETIMEDOUT|deadline|ECONNRESET|socket hang up/i.test(error)) {
    return write ? { kind: "timeout", committed: true } : { kind: "timeout" };
  }
  return { kind: "error", status: status && status >= 400 ? status : 500, message: error.slice(0, 200) };
}

export interface FromTraceOptions {
  name?: string;
  source?: string;
  /** Replace emails, phones, card numbers, SSNs and IBANs with synthetic values. Default true. */
  redact?: boolean;
}

export interface FromTraceResult {
  scenario: JsonObject;
  notes: string[];
  yaml: string;
}

/** Turn a captured production trace into a scenario: same user turns, same tool surface, same faults, plus starter assertions. */
export function traceToScenario(parsed: ParsedTrace, options: FromTraceOptions = {}): FromTraceResult {
  const notes: string[] = [];
  let events = parsed.events;
  if (options.redact !== false) {
    const r = redactEvents(events);
    events = r.events;
    if (r.replaced) notes.push(`Replaced ${r.replaced} PII-shaped value(s) with synthetic ones. Check the file for anything the detector missed (names, addresses, order numbers).`);
  }

  const probe = createWorld();
  const builtIn = (name: string) => probe.tools().some((op) => op.tool?.name === name);

  // User turns; identical consecutive messages from different deliveries become duplicate deliveries.
  const turns: JsonObject[] = [];
  let lastUser: { text: string; traceId?: string } | undefined;
  for (const ev of events) {
    if (ev.type !== "user") continue;
    const prev = turns[turns.length - 1];
    if (prev && lastUser && lastUser.text === ev.text && (lastUser.traceId !== ev.traceId || ev.traceId === undefined)) {
      prev.deliver = Number(prev.deliver ?? 1) + 1;
      continue;
    }
    turns.push({ via: "none", text: ev.text });
    lastUser = ev;
  }
  if (turns.some((t) => Number(t.deliver ?? 1) > 1)) notes.push("The same user message arrived more than once; those turns are delivered as duplicates (`deliver`).");
  if (turns.length === 0) {
    turns.push({ via: "none", text: "TODO: the trace had no user message. Describe the inbound request here." });
    notes.push("No user message found in the trace; edit the placeholder turn.");
  }

  const toolEvents = events.filter((e): e is Extract<TimelineEvent, { type: "tool" }> => e.type === "tool");
  const httpEvents = events.filter((e): e is Extract<TimelineEvent, { type: "http" }> => e.type === "http");
  const byTool = new Map<string, typeof toolEvents>();
  for (const e of toolEvents) byTool.set(e.name, [...(byTool.get(e.name) ?? []), e]);

  const tools: JsonObject[] = [];
  const faults: JsonObject[] = [];
  const assertions: JsonObject[] = [{ name: "no duplicate side effects", no_duplicate_effects: true }];
  const seedZendeskTickets = new Map<string, JsonObject>();

  for (const [name, calls] of byTool) {
    const isWrite = !READ_VERBS.test(name) && WRITE_VERBS.test(name);
    const native = builtIn(name);
    calls.forEach((c, index) => {
      if (c.error) faults.push({ op: name, ...faultFor(c.error, c.status, isWrite), after: index, times: 1 });
    });
    const distinct = new Set(calls.filter((c) => !c.error || isWrite).map((c) => stableStringify({ ...c.args, idempotency_key: undefined }))).size;
    if (native) {
      for (const c of calls) {
        const tid = c.args.ticket_id ?? c.args.id;
        if (name.startsWith("zendesk_") && tid !== undefined) {
          // Only reads describe the state before the incident; write results show the state after it.
          const r = !isWrite && isPlainObject(c.result) ? ((c.result.ticket as JsonObject) ?? c.result) : {};
          if (isWrite && seedZendeskTickets.has(String(tid))) continue;
          seedZendeskTickets.set(String(tid), { id: Number(tid) || tid, subject: r.subject ?? "(from trace)", status: r.status ?? "open", tags: r.tags ?? [], description: r.description ?? "" });
        }
      }
      if (isWrite) {
        assertions.push({ name: `at most ${distinct} ${name} call(s) (incident had ${calls.length})`, calls: name, max: distinct });
      }
      continue;
    }
    const ok = calls.filter((c) => !c.error && c.result !== undefined).map((c) => c.result);
    const tool: JsonObject = { name, description: `Replayed from trace (${calls.length} call(s) in the incident)`, inputSchema: inferSchema(calls.map((c) => c.args)) };
    if (isWrite) tool.effect = name;
    else tool.write = false;
    if (ok.length > 1 && new Set(ok.map((r) => stableStringify(r))).size > 1) tool.responses = ok;
    else if (ok.length) tool.response = ok[0];
    tools.push(tool);
    if (isWrite) {
      assertions.push({ name: `at most ${distinct} ${name} write(s) (incident had ${calls.length})`, effects: `generic.${name}`, max: distinct });
    }
  }

  // HTTP calls: known SaaS hosts map to the built-in fakes; anything else becomes a custom route.
  const routes: JsonObject[] = [];
  const allRoutes = [...probe.backends.values()].flatMap((b) => b.routes().map((r) => ({ backend: b.name, ...r })));
  const httpCount = new Map<string, number>();
  const usedBackends = new Set<string>();
  for (const h of httpEvents) {
    let u: URL;
    try {
      u = new URL(h.url);
    } catch {
      continue;
    }
    const path = u.pathname.replace(/\.json$/, "");
    const host = u.hostname;
    const backendHint = /zendesk\.com$/.test(host) ? "zendesk" : /(^|\.)slack\.com$/.test(host) ? "slack" : /linear\.app$/.test(host) ? "linear" : undefined;
    const known = backendHint ? allRoutes.find((r) => r.backend === backendHint && r.method === h.method && matchPath(r.path, path)) : undefined;
    const opName = known ? known.op : `generic.route.${h.method} ${path}`;
    if (known) {
      usedBackends.add(known.backend);
      const tid = matchPath(known.path, path)?.id;
      if (known.backend === "zendesk" && tid && !seedZendeskTickets.has(tid)) seedZendeskTickets.set(tid, { id: Number(tid) || tid, subject: "(from trace)", status: "open" });
    }
    const index = httpCount.get(opName) ?? 0;
    httpCount.set(opName, index + 1);
    if (!known && !routes.some((r) => r.method === h.method && r.path === path)) {
      routes.push({ method: h.method, path, ...(h.responseBody !== undefined ? { response: h.responseBody } : {}), ...(h.status && h.status < 400 ? { status: h.status } : {}) });
    }
    if (h.error) faults.push({ op: opName, ...faultFor(h.error, h.status, h.method !== "GET"), after: index, times: 1 });
  }
  if (httpEvents.length) notes.push(`Found ${httpEvents.length} HTTP call(s). Point the agent's API base URLs at fakeplane (FAKEPLANE_URL) so they hit the fakes.`);
  for (const [opName, n] of httpCount) {
    if (opName.startsWith("generic.route.") && !opName.startsWith("generic.route.GET")) {
      assertions.push({ name: `at most ${n} ${opName.slice(14)} request(s)`, calls: opName, max: n });
    }
  }

  assertions.push({ name: "no PII in outbound writes", no_pii: true });
  assertions.push({ name: "TODO: assert the outcome that should have happened", calls: "*", min: 1 });

  const seed: JsonObject = {};
  if (tools.length || routes.length) seed.generic = { ...(tools.length ? { tools } : {}), ...(routes.length ? { routes } : {}) };
  if (seedZendeskTickets.size) seed.zendesk = { tickets: [...seedZendeskTickets.values()] };
  for (const b of usedBackends) if (!seed[b]) seed[b] = {};
  for (const [name] of byTool) {
    const backend = name.split("_")[0];
    if (builtIn(name) && !seed[backend]) seed[backend] = {};
  }
  if (!seed.generic && !seed.zendesk) seed.generic = { collections: {} };
  if (faults.length) notes.push(`Re-created ${faults.length} fault(s) from failed calls. Timeouts on writes are marked committed: the write landed but the agent saw a failure, the case that causes duplicates.`);

  const scenario: JsonObject = {
    name: options.name ?? "regression from incident trace",
    description: `Generated by fakeplane from-trace${options.source ? ` from ${options.source}` : ""} (${parsed.format}). Review every assertion: they should state what SHOULD have happened.`,
    tags: ["regression", "from-trace"],
    seed,
    turns,
    ...(faults.length ? { faults } : {}),
    assert: assertions,
  };
  const header = [
    "Generated by `fakeplane from-trace`. Review before committing:",
    "- assertions are starting points; replace the TODO with the real expected outcome",
    "- check that no customer data survived redaction",
    ...notes.map((n) => `- ${n}`),
  ];
  const yaml = header.map((l) => `# ${l}`).join("\n") + "\n" + stringify(scenario, { lineWidth: 0 });
  return { scenario, notes, yaml };
}
