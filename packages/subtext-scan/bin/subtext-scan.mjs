#!/usr/bin/env node
/**
 * subtext-scan [scan] <file...>   report what a model would read that a person cannot see
 * subtext-scan mcp [--root dir]   serve the scanner as an MCP tool over stdio
 *
 * Exit codes: 0 nothing at or above --fail-on, 1 something was, 2 a file could not be scanned
 * or the arguments were wrong.
 */
import { parseArgs } from 'node:util';

import { exceeds, FORMATS, scan, SEVERITIES, showInvisible, VERSION } from '../src/index.mjs';

const HELP = `subtext-scan ${VERSION}
Catch the instructions hidden in a document before your agent follows them.

Usage
  subtext-scan [scan] <file...> [options]   scan PDF, DOCX, HTML or text files ("-" reads stdin)
  subtext-scan mcp [--root <dir>]           run the MCP server over stdio

Options
  --json               machine-readable output (one object, or an array for several files)
  --fail-on <level>    exit 1 if any finding is at or above: high (default), medium, low, info, none
  --format <fmt>       skip detection and read every file as: ${FORMATS.join(', ')}
  --min-font-pt <n>    text smaller than this is unreadable (default 2)
  --min-contrast <n>   contrast ratio below this is unreadable (default 1.25)
  -q, --quiet          print nothing; use the exit code
  -v, --version        print the version
  -h, --help           print this help

Exit codes: 0 clean below the threshold, 1 a finding met the threshold, 2 error.`;

const fail = (msg) => { process.stderr.write(`subtext-scan: ${msg}\n`); process.exit(2); };

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' }, 'fail-on': { type: 'string', default: 'high' }, format: { type: 'string' },
      'min-font-pt': { type: 'string' }, 'min-contrast': { type: 'string' }, root: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' }, version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) { fail(`${err.message}\n\n${HELP}`); }
const { values: opts, positionals } = parsed;

if (opts.help) { console.log(HELP); process.exit(0); }
if (opts.version) { console.log(VERSION); process.exit(0); }

if (positionals[0] === 'mcp') {
  const { serve } = await import('../src/mcp.mjs');
  await serve({ root: opts.root });
} else {
  const files = positionals[0] === 'scan' ? positionals.slice(1) : positionals;
  if (!files.length) fail(`no file given\n\n${HELP}`);
  if (![...SEVERITIES, 'none'].includes(opts['fail-on'])) fail(`--fail-on must be one of ${[...SEVERITIES, 'none'].join(', ')}`);
  if (opts.format && !FORMATS.includes(opts.format)) fail(`--format must be one of ${FORMATS.join(', ')}`);
  const number = (name) => {
    if (opts[name] === undefined) return undefined;
    const n = Number(opts[name]);
    if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
    return n;
  };
  const options = { format: opts.format, minFontPt: number('min-font-pt'), minContrast: number('min-contrast') };
  for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];

  const results = [];
  let errored = false;
  for (const file of files) {
    try {
      const input = file === '-' ? await stdin() : file;
      results.push(await scan(input, { ...options, ...(file === '-' ? { name: 'stdin' } : {}) }));
    } catch (err) {
      errored = true;
      results.push({ file, error: err.message, code: err.code ?? 'ERROR' });
    }
  }
  const failed = results.some((r) => !r.error && exceeds(r, opts['fail-on']));
  if (!opts.quiet) {
    if (opts.json) process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
    else process.stdout.write(results.map(render).join('\n'));
  }
  process.exitCode = errored ? 2 : failed ? 1 : 0;
}

async function stdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Terminal-safe: a hostile document must not be able to emit escape sequences or hide characters. */
function safe(s) {
  return showInvisible(String(s)).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function where(f) {
  const parts = [];
  if (f.page) parts.push(`page ${f.page}`);
  if (f.bbox) parts.push(`bbox ${f.bbox.map((n) => Math.round(n)).join(',')}`);
  const loc = f.location ?? {};
  if (loc.attachment) parts.push(`attachment ${safe(loc.attachment)}`);
  if (loc.part) parts.push(`${loc.part}${loc.paragraph ? ` para ${loc.paragraph}` : ''}`);
  if (loc.line) parts.push(`line ${loc.line}`);
  if (loc.field) parts.push(`field ${safe(loc.field)}`);
  return parts.join('  ');
}

function render(r) {
  if (r.error) return `${safe(r.file)}  ERROR  ${safe(r.error)}\n`;
  const head = `${safe(r.file ?? 'input')}  ${r.format}${r.pages ? ` · ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''} · `;
  if (!r.findings.length) return `${head}no findings\n`;
  const counts = SEVERITIES.slice().reverse().filter((s) => r.summary[s]).map((s) => `${r.summary[s]} ${s}`).join(', ');
  const order = (f) => -SEVERITIES.indexOf(f.severity);
  const lines = [`${head}${counts}`];
  for (const f of [...r.findings].sort((a, b) => order(a) - order(b) || (a.page ?? 0) - (b.page ?? 0))) {
    lines.push(`  ${f.severity.toUpperCase().padEnd(6)}  ${f.rule}${where(f) ? `  ${where(f)}` : ''}`);
    lines.push(`          ${safe(f.reason)}`);
    if (f.text) lines.push(`          "${safe(f.text.length > 200 ? `${f.text.slice(0, 200)}…` : f.text)}"`);
  }
  return `${lines.join('\n')}\n`;
}
