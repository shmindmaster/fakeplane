/**
 * A deliberately small GraphQL reader: enough to route root fields to fake
 * operations, resolve arguments (literals and variables), and project results
 * onto the requested selection set. No schema validation, no directives.
 */

export interface GqlField {
  alias?: string;
  name: string;
  args: Record<string, unknown>;
  /** undefined = leaf; "*" = contains fragments, return everything at this level. */
  selection?: GqlField[] | "*";
}

export interface GqlOperation {
  type: "query" | "mutation" | "subscription";
  name?: string;
  fields: GqlField[];
}

type Token = { kind: "punct" | "name" | "number" | "string" | "spread"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/[\s,\uFEFF]/.test(c)) {
      i++;
    } else if (src.startsWith("...", i)) {
      tokens.push({ kind: "spread", value: "..." });
      i += 3;
    } else if ("!$():=@[]{}|&".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0] });
      i += m[0].length;
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new GraphQLSyntaxError(`Unexpected character ${c}`);
      tokens.push({ kind: "number", value: m[0] });
      i += m[0].length;
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end < 0) throw new GraphQLSyntaxError("Unterminated block string");
      tokens.push({ kind: "string", value: dedentBlock(src.slice(i + 3, end)) });
      i = end + 3;
    } else if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const n = src[j + 1];
          if (n === "u") {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
          j += 2;
          continue;
        }
        out += src[j++];
      }
      if (j >= src.length) throw new GraphQLSyntaxError("Unterminated string");
      tokens.push({ kind: "string", value: out });
      i = j + 1;
    } else {
      throw new GraphQLSyntaxError(`Unexpected character ${c}`);
    }
  }
  return tokens;
}

function dedentBlock(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), Infinity);
  return lines
    .map((l, idx) => (idx === 0 || !Number.isFinite(indent) ? l : l.slice(indent)))
    .join("\n")
    .trim();
}

export class GraphQLSyntaxError extends Error {}

export function parseOperation(query: string, variables: Record<string, unknown> = {}, operationName?: string): GqlOperation {
  const tokens = tokenize(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => {
    const t = tokens[pos++];
    if (!t) throw new GraphQLSyntaxError("Unexpected end of query");
    return t;
  };
  const expect = (value: string) => {
    const t = next();
    if (t.value !== value) throw new GraphQLSyntaxError(`Expected ${value}, got ${t.value}`);
  };

  const parseValue = (): unknown => {
    const t = next();
    if (t.kind === "punct" && t.value === "$") return variables[next().value];
    if (t.kind === "number") return Number(t.value);
    if (t.kind === "string") return t.value;
    if (t.kind === "name") return t.value === "true" ? true : t.value === "false" ? false : t.value === "null" ? null : t.value;
    if (t.value === "[") {
      const list: unknown[] = [];
      while (peek()?.value !== "]") list.push(parseValue());
      next();
      return list;
    }
    if (t.value === "{") {
      const o: Record<string, unknown> = {};
      while (peek()?.value !== "}") {
        const key = next().value;
        expect(":");
        o[key] = parseValue();
      }
      next();
      return o;
    }
    throw new GraphQLSyntaxError(`Unexpected ${t.value}`);
  };

  const parseArgs = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    if (peek()?.value !== "(") return args;
    next();
    while (peek()?.value !== ")") {
      const key = next().value;
      expect(":");
      args[key] = parseValue();
    }
    next();
    return args;
  };

  const skipDirectives = () => {
    while (peek()?.value === "@") {
      next();
      next();
      parseArgs();
    }
  };

  const parseSelection = (): GqlField[] | "*" => {
    expect("{");
    const fields: GqlField[] = [];
    let star = false;
    while (peek()?.value !== "}") {
      if (peek()?.kind === "spread") {
        next();
        star = true;
        if (peek()?.value === "on") {
          next();
          next();
        } else if (peek()?.kind === "name") next();
        skipDirectives();
        if (peek()?.value === "{") parseSelection();
        continue;
      }
      let name = next().value;
      let alias: string | undefined;
      if (peek()?.value === ":") {
        next();
        alias = name;
        name = next().value;
      }
      const args = parseArgs();
      skipDirectives();
      const selection = peek()?.value === "{" ? parseSelection() : undefined;
      fields.push({ alias, name, args, selection });
    }
    next();
    return star ? "*" : fields;
  };

  const skipVariableDefs = () => {
    if (peek()?.value !== "(") return;
    let depth = 0;
    do {
      const t = next();
      if (t.value === "(") depth++;
      if (t.value === ")") depth--;
    } while (depth > 0);
  };

  const ops: GqlOperation[] = [];
  while (pos < tokens.length) {
    const t = peek();
    if (t.value === "{") {
      const sel = parseSelection();
      ops.push({ type: "query", fields: sel === "*" ? [] : sel });
    } else if (t.value === "fragment") {
      next();
      next();
      next();
      next();
      skipDirectives();
      parseSelection();
    } else if (t.value === "query" || t.value === "mutation" || t.value === "subscription") {
      next();
      const name = peek()?.kind === "name" ? next().value : undefined;
      skipVariableDefs();
      skipDirectives();
      const sel = parseSelection();
      ops.push({ type: t.value, name, fields: sel === "*" ? [] : sel });
    } else {
      throw new GraphQLSyntaxError(`Unexpected ${t.value}`);
    }
  }
  if (ops.length === 0) throw new GraphQLSyntaxError("No operation in document");
  if (operationName) {
    const op = ops.find((o) => o.name === operationName);
    if (!op) throw new GraphQLSyntaxError(`Unknown operation ${operationName}`);
    return op;
  }
  return ops[0];
}

/** Keep only the fields the query asked for. */
export function project(value: unknown, selection: GqlField[] | "*" | undefined): unknown {
  if (selection === undefined || selection === "*" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, selection));
  if (typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of selection) {
    if (f.name === "__typename") out[f.alias ?? f.name] = src.__typename ?? null;
    else out[f.alias ?? f.name] = project(src[f.name] ?? null, f.selection);
  }
  return out;
}
