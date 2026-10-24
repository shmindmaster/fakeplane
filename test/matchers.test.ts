import { describe, expect, it } from "vitest";
import { matchValue } from "../src/matchers.js";
import { scanText, scanValue } from "../src/pii.js";
import { getPath, globMatch, renderTemplate } from "../src/util.js";

describe("matchValue", () => {
  it("matches subsets with dotted paths and loose number/string equality", () => {
    expect(matchValue({ ticket_id: 1, a: { b: "x" } }, { ticket_id: "1", "a.b": "x" }).ok).toBe(true);
    expect(matchValue({ ticket_id: 2 }, { ticket_id: 1 }).ok).toBe(false);
  });

  it("supports comparison operators", () => {
    expect(matchValue(150, { gt: 100 }).ok).toBe(true);
    expect(matchValue(50, { gt: 100 }).ok).toBe(false);
    expect(matchValue("42.5", { lte: 42.5 }).ok).toBe(true);
    expect(matchValue(5, { gte: 1, lt: 10 }).ok).toBe(true);
  });

  it("supports contains for text and lists, plus negations", () => {
    expect(matchValue(["vip", "refund_issued"], { contains: "refund_issued" }).ok).toBe(true);
    expect(matchValue("We refunded you", { icontains: "REFUNDED" }).ok).toBe(true);
    expect(matchValue("hello", { not_contains: "refund" }).ok).toBe(true);
    expect(matchValue(undefined, { not_contains: "refund" }).ok).toBe(true);
    expect(matchValue("x", { not: "x" }).ok).toBe(false);
  });

  it("supports matches, in, exists and length", () => {
    expect(matchValue("Order ORD-12", { matches: "/ord-\\d+/i" }).ok).toBe(true);
    expect(matchValue("solved", { in: ["solved", "closed"] }).ok).toBe(true);
    expect(matchValue(null, { exists: false }).ok).toBe(true);
    expect(matchValue([1, 2, 3], { length: { gte: 3 } }).ok).toBe(true);
  });

  it("explains failures", () => {
    const r = matchValue({ status: "open" }, { status: "solved" });
    expect(r.reason).toContain('status: expected "solved", got "open"');
  });
});

describe("pii", () => {
  it("finds emails, phones, SSNs and Luhn-valid cards", () => {
    const types = (t: string) => scanText(t, ".").map((f) => f.type);
    expect(types("mail me at a.person@example.com")).toEqual(["email"]);
    expect(types("call +1 415 555 0134")).toEqual(["phone"]);
    expect(types("call (415) 555-0134")).toEqual(["phone"]);
    expect(types("ssn 123-45-6789")).toEqual(["ssn"]);
    expect(types("card 4242 4242 4242 4242")).toEqual(["card"]);
    expect(types("card 4242 4242 4242 4241")).toEqual([]);
    expect(types("order ord_1001 total $42.50 on 2026-01-01")).toEqual([]);
  });

  it("honours allow lists and extra values", () => {
    expect(scanText("support@help.example", ".", { allow: ["support@help.example"] })).toEqual([]);
    expect(scanText("x@corp.example", ".", { allow: ["/@corp\\.example$/"] })).toEqual([]);
    expect(scanText("born 1990-02-03", ".", { values: ["1990-02-03"] }).map((f) => f.type)).toEqual(["value"]);
  });

  it("walks nested values and reports paths", () => {
    const f = scanValue({ a: [{ text: "a@b.co" }] });
    expect(f[0].path).toBe("a[0].text");
  });
});

describe("util", () => {
  it("globs, reads paths and renders templates", () => {
    expect(globMatch("zendesk.*", "zendesk.ticket.reply")).toBe(true);
    expect(globMatch("generic.refunds.create", "generic.orders.create")).toBe(false);
    expect(getPath({ t: { "1": { tags: ["a"] } } }, "t.1.tags.0")).toBe("a");
    expect(renderTemplate({ id: "{{params.id}}", n: "{{body.amount}}", s: "r-{{params.id}}" }, { params: { id: "7" }, body: { amount: 5 } })).toEqual({ id: "7", n: 5, s: "r-7" });
  });
});
