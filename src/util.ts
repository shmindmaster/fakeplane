export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Glob match where `*` matches any run of characters (including dots). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true;
  const re = new RegExp(
    "^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return re.test(value);
}

/** Read a dotted path (`a.b.0.c`) from a value. Keys containing dots can be quoted with [""]. */
export function getPath(value: unknown, path: string): unknown {
  if (path === "" || path === ".") return value;
  let current: unknown = value;
  for (const key of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function splitPath(path: string): string[] {
  const keys: string[] = [];
  const re = /\["([^"]*)"\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) keys.push(m[1] ?? m[2]);
  return keys;
}

/** Replace `{{path}}` placeholders in strings (recursively) with values from `vars`. */
export function renderTemplate(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    if (whole) return getPath(vars, whole[1]);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, p: string) => {
      const v = getPath(vars, p);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, vars));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplate(v, vars);
    return out;
  }
  return value;
}

/** Stable JSON stringify with sorted keys, used to compare payloads. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (isPlainObject(value)) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `… [${text.length - max} more chars]`;
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
