/**
 * subtext-scan: find what a model will read in a document that a person cannot see.
 *
 *   scan(pathOrBytes, options)   -> { file, format, findings, summary, ... }
 *   exceeds(result, 'high')      -> true when any finding is at or above the threshold
 *   findInstructionPhrases(text) -> the phrase rules a string matches
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { maxSeverity, preview, rank, SEVERITIES } from './common.mjs';
import { scanDocx } from './docx.mjs';
import { scanHtml } from './html.mjs';
import { scanPdf } from './pdf.mjs';
import { scanText } from './text.mjs';

export { SEVERITIES } from './common.mjs';
export { findInstructionPhrases, PHRASE_RULES } from './phrases.mjs';
export { findUnicodeTricks, showInvisible, stripInvisible } from './unicode.mjs';

export const VERSION = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
export const FORMATS = ['pdf', 'docx', 'html', 'text'];
const MAX_DEPTH = 2;

/** The format of `bytes`, from its magic number first and its file name second. */
export function detectFormat(bytes, name = '') {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (head.startsWith('PK\u0003\u0004')) {
    if (Buffer.from(bytes).includes('word/document.xml')) return 'docx';
    return null;
  }
  const ext = path.extname(name).toLowerCase();
  if (['.html', '.htm', '.xhtml', '.svg'].includes(ext)) return 'html';
  if (['.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.eml'].includes(ext)) return 'text';
  if (/^\s*(<!doctype html|<html|<head|<body|<meta|<div|<p\b|<!--)/i.test(head)) return 'html';
  const sample = Buffer.from(bytes.subarray(0, 4096));
  const binary = sample.filter((b) => b === 0 || (b < 8)).length;
  return binary === 0 ? 'text' : null;
}

const SCANNERS = { pdf: scanPdf, docx: scanDocx, html: scanHtml, text: scanText };

async function scanBytes(bytes, { format, name, depth, ...options }) {
  const fmt = format ?? detectFormat(bytes, name);
  if (!fmt) throw Object.assign(new Error(`unsupported file type${name ? `: ${name}` : ''} (subtext-scan reads PDF, DOCX, HTML and text)`), { code: 'UNSUPPORTED' });
  if (!SCANNERS[fmt]) throw Object.assign(new Error(`unknown format "${fmt}"; use one of ${FORMATS.join(', ')}`), { code: 'UNSUPPORTED' });
  const { pages, findings, attachments } = await SCANNERS[fmt](bytes, options);

  for (const a of attachments ?? []) {
    const content = a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content ?? []);
    const nestedFormat = content.length ? detectFormat(content, a.filename) : null;
    const where = a.page ? { attachment: a.filename, page: a.page } : { attachment: a.filename };
    findings.push({
      rule: 'attachment', severity: 'low',
      reason: `The document embeds a file "${a.filename}" (${content.length} bytes). Some loaders extract attachments into the model's context; most reviewers never open them.`,
      page: a.page ?? null, bbox: null, text: a.description ? preview(a.description) : '', phrases: [], location: where,
    });
    if (!nestedFormat || depth >= MAX_DEPTH) continue;
    try {
      const inner = await scanBytes(content, { ...options, name: a.filename, depth: depth + 1 });
      // A reader of the document never sees an attachment's content, so phrasing in it is a hidden channel.
      for (const f of inner.findings) {
        findings.push({ ...f, severity: f.phrases?.length ? 'high' : f.severity, reason: `In the embedded file "${a.filename}": ${f.reason}`, page: a.page ?? null, bbox: null, location: { ...where, inner: { page: f.page, bbox: f.bbox, ...f.location } } });
      }
    } catch { /* an unreadable attachment is reported above */ }
  }
  return { format: fmt, pages, findings };
}

/**
 * Scan a document. `input` is a file path or the file's bytes.
 * Options: format ('pdf' | 'docx' | 'html' | 'text'), name (for format detection and the report),
 * minContrast, minFontPt, minOpacity, maxPages.
 */
export async function scan(input, options = {}) {
  const isPath = typeof input === 'string';
  const bytes = isPath ? new Uint8Array(await readFile(input)) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const name = options.name ?? (isPath ? input : undefined);
  const { format, pages, findings } = await scanBytes(bytes, { ...options, name, depth: 0 });
  const normalized = findings.map((f) => ({
    rule: f.rule, severity: f.severity, reason: f.reason,
    page: f.page ?? null, bbox: f.bbox ?? null, text: f.text ?? '', phrases: f.phrases ?? [],
    ...(f.mechanisms ? { mechanisms: f.mechanisms } : {}),
    ...(f.evidence ? { evidence: f.evidence } : {}),
    ...(f.location && Object.keys(f.location).length ? { location: f.location } : {}),
  }));
  return {
    scanner: { name: 'subtext-scan', version: VERSION },
    file: name ?? null,
    format,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    pages: pages ?? null,
    findings: normalized,
    summary: summarize(normalized),
  };
}

export function summarize(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity]++;
  return { total: findings.length, ...counts, max: maxSeverity(findings) };
}

/** True when `result` has a finding at or above `threshold` ('info' | 'low' | 'medium' | 'high'). */
export function exceeds(result, threshold = 'high') {
  if (threshold === 'none' || threshold === 'never') return false;
  if (!SEVERITIES.includes(threshold)) throw new Error(`unknown severity "${threshold}"; use one of ${SEVERITIES.join(', ')}`);
  return result.findings.some((f) => rank(f.severity) >= rank(threshold));
}
