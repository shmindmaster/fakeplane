/** Plain text, Markdown or a chunk headed for a prompt: instruction phrasing and invisible characters. */
import { phraseHitsByLine, preview } from './common.mjs';
import { findUnicodeTricks } from './unicode.mjs';

export function scanText(source) {
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const lines = text.split(/\r?\n/);
  const findings = phraseHitsByLine(lines).map(({ first, last, ids }) => ({
    rule: 'instruction-phrase', severity: 'medium',
    reason: `Text is worded as instructions to a model (${ids.join(', ')}).`,
    page: null, bbox: null, text: preview(lines.slice(first, last + 1).join(' ')), phrases: ids,
    location: { line: first + 1, ...(last !== first ? { through_line: last + 1 } : {}) },
  }));
  lines.forEach((l, i) => findings.push(...findUnicodeTricks(l, { location: { line: i + 1 } })));
  return { pages: null, findings, attachments: [] };
}
