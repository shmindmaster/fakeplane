import { relative } from "node:path";
import type { RunReport, ScenarioResult } from "./runner.js";

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { red: paint(31), green: paint(32), yellow: paint(33), dim: paint(2), bold: paint(1) };

const rel = (file: string) => {
  const r = relative(process.cwd(), file).replace(/\\/g, "/") || file;
  return r.startsWith("../") ? r.split("/").slice(-3).join("/") : r;
};

function badge(status: string): string {
  if (status === "pass") return color.green(" PASS ");
  if (status === "error") return color.yellow(" ERROR");
  return color.red(" FAIL ");
}

export function formatScenario(r: ScenarioResult, verbose = false): string {
  const lines: string[] = [];
  const reps = r.attempts.length > 1 ? ` ${Math.round(r.passRate * 100)}% of ${r.attempts.length} runs passed` : "";
  lines.push(`${badge(r.status)} ${color.bold(r.name)} ${color.dim(`${rel(r.file)} (${r.durationMs}ms)${reps}`)}`);
  const a = r.shown;
  if (a.error) lines.push(`   ${color.yellow("!")} agent error: ${a.error}`);
  for (const res of a.assertions) {
    if (res.ok && !verbose && r.status === "pass") continue;
    lines.push(res.ok ? `   ${color.green("✓")} ${res.name}` : `   ${color.red("✗")} ${res.name}\n     ${color.dim(res.message)}`);
  }
  if (r.status !== "pass" || verbose) {
    lines.push(color.dim(`     ${a.calls.length} calls, ${a.effects.length} side effects, ${a.turns.length} agent deliveries`));
  }
  return lines.join("\n");
}

export function formatSummary(report: RunReport): string {
  const total = report.scenarios.length;
  const parts = [color.green(`${report.passed} passed`)];
  if (report.failed) parts.push(color.red(`${report.failed} failed`));
  if (report.errored) parts.push(color.yellow(`${report.errored} errored`));
  return `\n${parts.join(", ")} (${total} scenario${total === 1 ? "" : "s"}) in ${(report.durationMs / 1000).toFixed(1)}s`;
}

function xml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JUnit XML: one testsuite per scenario, one testcase per assertion. */
export function toJUnit(report: RunReport): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  let tests = 0;
  let failures = 0;
  let errors = 0;
  const suites: string[] = [];
  for (const r of report.scenarios) {
    const a = r.shown;
    const cases: string[] = [];
    const classname = xml(rel(r.file));
    if (a.error) {
      errors++;
      cases.push(`    <testcase classname="${classname}" name="${xml(r.name)}: agent run" time="0"><error message="${xml(a.error)}">${xml(a.error)}</error></testcase>`);
    }
    for (const res of a.assertions) {
      const body = res.ok ? "" : `<failure message="${xml(res.message)}">${xml(res.message)}</failure>`;
      if (!res.ok) failures++;
      cases.push(`    <testcase classname="${classname}" name="${xml(r.name)}: ${xml(res.name)}" time="0">${body}</testcase>`);
    }
    if (r.attempts.length > 1) {
      const ok = r.status === "pass";
      if (!ok) failures++;
      cases.push(`    <testcase classname="${classname}" name="${xml(r.name)}: pass rate" time="0">${ok ? "" : `<failure message="pass rate ${Math.round(r.passRate * 100)}%">pass rate ${Math.round(r.passRate * 100)}% across ${r.attempts.length} runs</failure>`}</testcase>`);
    }
    tests += cases.length;
    const caseFailures = cases.filter((c) => c.includes("<failure")).length;
    const caseErrors = cases.filter((c) => c.includes("<error")).length;
    suites.push(`  <testsuite name="${xml(r.name)}" tests="${cases.length}" failures="${caseFailures}" errors="${caseErrors}" time="${(r.durationMs / 1000).toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`);
  }
  out.push(`<testsuites name="fakeplane" tests="${tests}" failures="${failures}" errors="${errors}" time="${(report.durationMs / 1000).toFixed(3)}">`);
  out.push(...suites);
  out.push("</testsuites>");
  return out.join("\n") + "\n";
}

export function toMarkdown(report: RunReport): string {
  const icon = (s: string) => (s === "pass" ? "✅" : s === "error" ? "⚠️" : "❌");
  const lines = [`### fakeplane: ${report.passed}/${report.scenarios.length} scenarios passed`, "", "| | Scenario | Result |", "|---|---|---|"];
  for (const r of report.scenarios) {
    const failed = r.shown.assertions.filter((a) => !a.ok);
    const detail = r.shown.error ? `agent error: ${r.shown.error}` : failed.length ? failed.map((a) => `${a.name}: ${a.message}`).join("<br>") : `${r.shown.assertions.length} assertions passed`;
    lines.push(`| ${icon(r.status)} | ${r.name.replace(/\|/g, "\\|")} | ${detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 600)} |`);
  }
  return lines.join("\n") + "\n";
}
