import { describe, expect, it } from "vitest";
import { shouldColor } from "../src/report.js";

describe("shouldColor", () => {
  it("follows the terminal when nothing is set", () => {
    expect(shouldColor({}, true)).toBe(true);
    expect(shouldColor({}, false)).toBe(false);
  });

  it("FORCE_COLOR turns colour on for pipes and recordings, and wins over NO_COLOR", () => {
    for (const value of ["1", "2", "3", "true", ""]) expect(shouldColor({ FORCE_COLOR: value }, false)).toBe(true);
    expect(shouldColor({ FORCE_COLOR: "1", NO_COLOR: "1" }, false)).toBe(true);
  });

  it("FORCE_COLOR=0 or false turns colour off, even in a terminal", () => {
    expect(shouldColor({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(shouldColor({ FORCE_COLOR: "false" }, true)).toBe(false);
  });

  it("NO_COLOR turns colour off in a terminal", () => {
    expect(shouldColor({ NO_COLOR: "1" }, true)).toBe(false);
  });
});
