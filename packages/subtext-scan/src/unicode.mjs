/**
 * Characters that change what a model reads without changing what a person sees.
 *
 *   Unicode tag characters (U+E0000-E007F) render as nothing but spell out ASCII; they are decoded.
 *   Bidirectional controls reorder what is displayed relative to what is stored.
 *   Zero-width characters split or pad words invisibly.
 */
import { phraseIds, preview } from './common.mjs';
import { findInstructionPhrases } from './phrases.mjs';

const TAGS = /[\u{E0000}-\u{E007F}]+/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
// ZWJ and ZWNJ are excluded: emoji sequences and several scripts (Persian, Indic) need them.
const ZERO_WIDTH = /[\u200B\u2060-\u2064\u180E]|(?<!^)\uFEFF/g;
const INVISIBLE = /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069\u200B\u2060-\u2064\u180E\uFEFF]/gu;

/** Visible-text form of `text`: every invisible character above shown as <U+XXXX>. */
export const showInvisible = (text) => text.replace(INVISIBLE, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
export const stripInvisible = (text) => text.replace(INVISIBLE, '');

export function findUnicodeTricks(text, { page = null, bbox = null, location = {} } = {}) {
  const findings = [];
  if (!text) return findings;
  for (const m of text.matchAll(TAGS)) {
    const decoded = [...m[0]].map((c) => c.codePointAt(0) - 0xE0000).filter((n) => n >= 0x20 && n < 0x7F).map((n) => String.fromCharCode(n)).join('');
    if (!decoded.trim()) continue;
    const phrases = findInstructionPhrases(decoded);
    findings.push({
      rule: 'unicode-tags', severity: 'high',
      reason: `${[...m[0]].length} invisible Unicode tag characters spell out text a reader cannot see${phrases.length ? ', worded as instructions to a model' : ''}.`,
      page, bbox, text: preview(decoded), phrases: phraseIds(phrases), location,
    });
  }
  const bidi = text.match(BIDI);
  if (bidi) {
    findings.push({
      rule: 'bidi-control', severity: 'medium',
      reason: `${bidi.length} bidirectional control character${bidi.length === 1 ? '' : 's'} can make the displayed order differ from the order a model reads.`,
      page, bbox, text: preview(showInvisible(around(text, text.search(BIDI)))), phrases: [], location,
    });
  }
  const zw = text.match(ZERO_WIDTH);
  if (zw && zw.length >= 3) {
    ZERO_WIDTH.lastIndex = 0;
    findings.push({
      rule: 'zero-width', severity: 'low',
      reason: `${zw.length} zero-width characters are hidden in the text; they can split words to slip past filters or carry an encoded payload.`,
      page, bbox, text: preview(showInvisible(around(text, text.search(ZERO_WIDTH)))), phrases: [], location,
    });
  }
  return findings;
}

const around = (text, at) => text.slice(Math.max(0, at - 40), at + 80);
