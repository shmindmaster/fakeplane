import { getPath, isPlainObject, stableStringify } from "./util.js";

const OPERATORS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "icontains",
  "not_contains",
  "matches",
  "in",
  "not_in",
  "exists",
  "length",
  "not",
]);

export interface MatchResult {
  ok: boolean;
  reason?: string;
}

const OK: MatchResult = { ok: true };

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => OPERATORS.has(k));
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && Number(b) === a) return true;
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && Number(a) === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return stableStringify(a) === stableStringify(b);
  }
  return false;
}

function toRegExp(pattern: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
}

function show(value: unknown): string {
  const s = JSON.stringify(value);
  if (s === undefined) return String(value);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

function compareNumbers(actual: unknown, expected: unknown, op: string): MatchResult {
  const a = typeof actual === "string" && actual.trim() !== "" ? Number(actual) : actual;
  const e = Number(expected);
  if (typeof a !== "number" || Number.isNaN(a)) return { ok: false, reason: `expected a number ${op} ${show(expected)}, got ${show(actual)}` };
  const ok = op === "gt" ? a > e : op === "gte" ? a >= e : op === "lt" ? a < e : a <= e;
  return ok ? OK : { ok: false, reason: `expected ${show(actual)} ${op} ${show(expected)}` };
}

function applyOperator(actual: unknown, op: string, expected: unknown): MatchResult {
  switch (op) {
    case "eq":
      return looseEqual(actual, expected) ? OK : { ok: false, reason: `expected ${show(expected)}, got ${show(actual)}` };
    case "ne":
      return !looseEqual(actual, expected) ? OK : { ok: false, reason: `expected anything but ${show(expected)}` };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareNumbers(actual, expected, op);
    case "contains":
    case "icontains": {
      if (typeof actual === "string") {
        const hay = op === "icontains" ? actual.toLowerCase() : actual;
        const needle = op === "icontains" ? String(expected).toLowerCase() : String(expected);
        return hay.includes(needle) ? OK : { ok: false, reason: `expected text to contain ${show(expected)}, got ${show(actual)}` };
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => matchValue(item, expected).ok)
          ? OK
          : { ok: false, reason: `expected list to contain ${show(expected)}, got ${show(actual)}` };
      }
      return { ok: false, reason: `expected text or list containing ${show(expected)}, got ${show(actual)}` };
    }
    case "not_contains": {
      const r = applyOperator(actual, "contains", expected);
      if (actual === undefined || actual === null) return OK;
      return r.ok ? { ok: false, reason: `expected not to contain ${show(expected)}, got ${show(actual)}` } : OK;
    }
    case "matches":
      return typeof actual === "string" && toRegExp(String(expected)).test(actual)
        ? OK
        : { ok: false, reason: `expected ${show(actual)} to match ${String(expected)}` };
    case "in":
      return Array.isArray(expected) && expected.some((e) => looseEqual(actual, e))
        ? OK
        : { ok: false, reason: `expected one of ${show(expected)}, got ${show(actual)}` };
    case "not_in":
      return Array.isArray(expected) && expected.some((e) => looseEqual(actual, e))
        ? { ok: false, reason: `expected none of ${show(expected)}, got ${show(actual)}` }
        : OK;
    case "exists": {
      const present = actual !== undefined && actual !== null;
      return present === Boolean(expected) ? OK : { ok: false, reason: expected ? "expected value to exist" : `expected no value, got ${show(actual)}` };
    }
    case "length": {
      const len = typeof actual === "string" || Array.isArray(actual) ? actual.length : undefined;
      if (len === undefined) return { ok: false, reason: `expected text or list, got ${show(actual)}` };
      const r = matchValue(len, expected);
      return r.ok ? OK : { ok: false, reason: `length ${len}: ${r.reason}` };
    }
    case "not": {
      const r = matchValue(actual, expected);
      return r.ok ? { ok: false, reason: `expected not to match ${show(expected)}` } : OK;
    }
    default:
      return { ok: false, reason: `unknown operator ${op}` };
  }
}

/**
 * Match `actual` against an expectation.
 * - Operator objects (`{ gt: 100 }`, `{ contains: "x" }`) apply each operator.
 * - Plain objects match as a subset; keys may be dotted paths.
 * - Everything else uses loose equality (`1` equals `"1"`).
 */
export function matchValue(actual: unknown, expected: unknown): MatchResult {
  if (isOperatorObject(expected)) {
    for (const [op, arg] of Object.entries(expected)) {
      const r = applyOperator(actual, op, arg);
      if (!r.ok) return r;
    }
    return OK;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return { ok: false, reason: `expected an object, got ${show(actual)}` };
    for (const [key, exp] of Object.entries(expected)) {
      const r = matchValue(getPath(actual, key), exp);
      if (!r.ok) return { ok: false, reason: `${key}: ${r.reason}` };
    }
    return OK;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return { ok: false, reason: `expected ${show(expected)}, got ${show(actual)}` };
    }
    for (let i = 0; i < expected.length; i++) {
      const r = matchValue(actual[i], expected[i]);
      if (!r.ok) return { ok: false, reason: `[${i}]: ${r.reason}` };
    }
    return OK;
  }
  return looseEqual(actual, expected) ? OK : { ok: false, reason: `expected ${show(expected)}, got ${show(actual)}` };
}
