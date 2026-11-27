/** Severity, colour and finding helpers shared by every format. */
import { findInstructionPhrases } from './phrases.mjs';

export const SEVERITIES = ['info', 'low', 'medium', 'high'];
export const rank = (severity) => SEVERITIES.indexOf(severity);
export const maxSeverity = (findings) => findings.reduce((m, f) => (m === null || rank(f.severity) > rank(m) ? f.severity : m), null);

/** Contrast below this ratio (WCAG formula) is treated as unreadable: #f0f0f0 on white is 1.13. */
export const MIN_CONTRAST = 1.25;
/** Text whose rendered height is below this many points is treated as unreadable. */
export const MIN_FONT_PT = 2;
/** Text at or below this opacity is treated as unreadable. */
export const MIN_OPACITY = 0.1;

export const TEXT_PREVIEW = 600;

export function parseColor(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((n) => Math.min(255, Math.round(parseFloat(n))));
  }
  return NAMED_COLORS[s] ? parseColor(NAMED_COLORS[s]) : null;
}

export const toHex = (rgb) => (rgb ? `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}` : null);

function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function lab(rgb) {
  const lin = rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const xyz = [
    (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047,
    0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2],
    (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883,
  ].map((t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/** CIE76 colour difference. Hue counts: red on grey of equal luminance is still easy to see. */
export function deltaE(a, b) {
  const [p, q] = [lab(a), lab(b)];
  return Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 10) / 10;
}

/** Colour below this CIE76 difference from its background is hard to tell apart even when hues differ. */
export const MAX_DELTA_E = 20;

/** Is `fg` on `bg` unreadable? Both the luminance contrast and the colour difference must be small. */
export function unreadable(fg, bg, minContrast = MIN_CONTRAST) {
  const ratio = contrastRatio(fg, bg);
  const dE = deltaE(fg, bg);
  return { ratio, deltaE: dE, hidden: ratio < minContrast && dE < MAX_DELTA_E };
}

const words = (text) => (text.match(/\p{L}{2,}/gu) ?? []).length;

/**
 * Severity of text a reader cannot see.
 *   high    it is worded as an instruction to a model
 *   medium  it contains words (a hidden clause, keyword stuffing)
 *   low     no words: stray glyphs, digits, punctuation
 */
export function hiddenSeverity(text, phrases) {
  if (phrases.length) return 'high';
  return words(text) ? 'medium' : 'low';
}

export function preview(text, max = TEXT_PREVIEW) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const phraseIds = (phrases) => [...new Set(phrases.map((p) => p.id))];

/**
 * Phrase matches over a sequence of lines, joined so a phrase may wrap onto the next line.
 * One entry per starting line: { first, last, ids } with 0-based line indexes.
 */
export function phraseHitsByLine(texts) {
  let joined = '';
  const starts = [];
  for (const t of texts) { starts.push(joined.length); joined += `${t.replace(/\s+/g, ' ')} `; }
  const byLine = new Map();
  for (const hit of findInstructionPhrases(joined)) {
    const first = starts.findLastIndex((s) => s <= hit.index);
    const last = starts.findLastIndex((s) => s <= hit.index + hit.match.length - 1);
    const entry = byLine.get(first) ?? { first, last, ids: [] };
    entry.last = Math.max(entry.last, last);
    if (!entry.ids.includes(hit.id)) entry.ids.push(hit.id);
    byLine.set(first, entry);
  }
  return [...byLine.values()].sort((a, b) => a.first - b.first);
}

export const visibleReason = (ids, subject = 'Visible text') => `${subject} is worded as instructions to a model (${ids.join(', ')}). A person can see it, but a model may follow it.`;

/** A finding for text in a channel a reader does not see on the page (metadata, comments, alt text). */
export function channelFinding({ rule, channel, text, location = {}, page = null, bbox = null, longAt = 300 }) {
  const phrases = findInstructionPhrases(text);
  if (phrases.length) {
    return { rule, severity: 'high', reason: `${channel} contains text worded as instructions to a model.`, page, bbox, text: preview(text), phrases: phraseIds(phrases), location };
  }
  if (longAt && text.trim().length >= longAt) {
    return { rule, severity: 'low', reason: `${channel} holds ${text.trim().length} characters of text a reader does not see on the page.`, page, bbox, text: preview(text), phrases: [], location };
  }
  return null;
}

const NAMED_COLORS = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080', maroon: '#800000', purple: '#800080',
  teal: '#008080', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff',
  magenta: '#ff00ff', orange: '#ffa500', whitesmoke: '#f5f5f5', snow: '#fffafa', ivory: '#fffff0',
  ghostwhite: '#f8f8ff', floralwhite: '#fffaf0', linen: '#faf0e6', azure: '#f0ffff', mintcream: '#f5fffa',
  aliceblue: '#f0f8ff', honeydew: '#f0fff0', seashell: '#fff5ee', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  gainsboro: '#dcdcdc', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969',
  // Word highlight names
  darkblue: '#00008b', darkcyan: '#008b8b', darkgreen: '#006400', darkmagenta: '#8b008b', darkred: '#8b0000',
  darkyellow: '#808000', lightgreen: '#90ee90',
};
