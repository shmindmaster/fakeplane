export interface PiiFinding {
  type: "email" | "phone" | "card" | "ssn" | "iban" | "value";
  match: string;
  path: string;
}

export interface PiiOptions {
  /** Strings or `/regex/` patterns that are allowed to appear (e.g. your support address). */
  allow?: string[];
  /** Extra sensitive literal values to look for (e.g. a seeded customer's date of birth). */
  values?: string[];
  /** Detector types to run. Defaults to all. */
  types?: PiiFinding["type"][];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w.])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\w)|(?<![\w.])\+\d{10,14}(?!\w)/g;
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function allowed(match: string, allow: string[]): boolean {
  return allow.some((a) => {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(a);
    if (m) return new RegExp(m[1], m[2]).test(match);
    return a.toLowerCase() === match.toLowerCase();
  });
}

/** Scan one string for PII-shaped values. Regex-based: expect false positives and misses. */
export function scanText(text: string, path: string, options: PiiOptions = {}): PiiFinding[] {
  const types = new Set(options.types ?? ["email", "phone", "card", "ssn", "iban", "value"]);
  const allow = options.allow ?? [];
  const findings: PiiFinding[] = [];
  const push = (type: PiiFinding["type"], match: string) => {
    if (!allowed(match, allow)) findings.push({ type, match, path });
  };
  if (types.has("email")) for (const m of text.match(EMAIL) ?? []) push("email", m);
  if (types.has("ssn")) for (const m of text.match(SSN) ?? []) push("ssn", m);
  if (types.has("card")) {
    for (const m of text.match(CARD) ?? []) {
      const digits = m.replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) push("card", m.trim());
    }
  }
  if (types.has("phone")) {
    for (const m of text.match(PHONE) ?? []) {
      if (!/^\d{3}-\d{2}-\d{4}$/.test(m.trim())) push("phone", m.trim());
    }
  }
  if (types.has("iban")) for (const m of text.match(IBAN) ?? []) push("iban", m);
  if (types.has("value")) {
    for (const v of options.values ?? []) {
      if (v && text.toLowerCase().includes(v.toLowerCase())) push("value", v);
    }
  }
  return findings;
}

/** Scan every string leaf of a JSON value. */
export function scanValue(value: unknown, options: PiiOptions = {}, path = ""): PiiFinding[] {
  if (typeof value === "string") return scanText(value, path || ".", options);
  if (Array.isArray(value)) return value.flatMap((v, i) => scanValue(v, options, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => scanValue(v, options, path ? `${path}.${k}` : k));
  }
  return [];
}
