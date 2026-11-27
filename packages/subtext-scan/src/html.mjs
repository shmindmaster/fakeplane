/**
 * HTML: text hidden by markup or CSS, and text in places a reader does not look.
 *
 * Styles come from inline `style` attributes and from `<style>` rules whose selector is a single
 * compound of tag, #id and .class parts. Rules with combinators or pseudo-classes, external
 * stylesheets and script-driven styles are not evaluated. A location is a 1-based source line.
 */
import { parseDocument } from 'htmlparser2';

import { channelFinding, hiddenSeverity, MIN_CONTRAST, MIN_FONT_PT, MIN_OPACITY, parseColor, phraseHitsByLine, phraseIds, preview, toHex, unreadable, visibleReason } from './common.mjs';
import { findInstructionPhrases } from './phrases.mjs';
import { findUnicodeTricks } from './unicode.mjs';

const WHITE = [255, 255, 255];
const SKIP = new Set(['script', 'style', 'head']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'blockquote', 'pre', 'form', 'body', 'title', 'dd', 'dt', 'figcaption']);
const ATTRS = ['alt', 'title', 'aria-label', 'aria-description', 'placeholder', 'content', 'value'];

function parseDecls(text) {
  const decls = {};
  for (const part of (text ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    decls[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).replace(/!important/i, '').trim().toLowerCase();
  }
  return decls;
}

function parseRules(css) {
  const rules = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = parseDecls(m[2]);
    for (const sel of m[1].split(',').map((x) => x.trim())) {
      const parsed = /^([a-z][\w-]*)?((?:[.#][\w-]+)*)$/i.exec(sel);
      if (!parsed || (!parsed[1] && !parsed[2])) continue;
      const tag = parsed[1]?.toLowerCase() ?? null;
      const ids = [...parsed[2].matchAll(/#([\w-]+)/g)].map((x) => x[1]);
      const classes = [...parsed[2].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
      rules.push({ tag, ids, classes, decls, specificity: ids.length * 100 + classes.length * 10 + (tag ? 1 : 0) });
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity);
}

function styleOf(el, rules) {
  const classes = new Set((el.attribs?.class ?? '').split(/\s+/).filter(Boolean));
  const style = {};
  for (const r of rules) {
    if (r.tag && r.tag !== el.name) continue;
    if (r.ids.some((id) => el.attribs?.id !== id)) continue;
    if (r.classes.some((c) => !classes.has(c))) continue;
    Object.assign(style, r.decls);
  }
  return Object.assign(style, parseDecls(el.attribs?.style));
}

const px = (v) => {
  const m = /^(-?[\d.]+)(px|pt|em|rem|%)?$/.exec(v ?? '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { px: n, pt: n * 0.75, em: n * 16, rem: n * 16, '%': (n / 100) * 16 }[m[2] ?? 'px'];
};

function hidingOf(el, style, opts) {
  const m = [];
  if (el.attribs && 'hidden' in el.attribs) m.push('hidden-attribute');
  if (el.name === 'template') m.push('template');
  if (style.display === 'none') m.push('display-none');
  if (style.visibility === 'hidden' || style.visibility === 'collapse') m.push('visibility-hidden');
  if (style.opacity !== undefined && parseFloat(style.opacity) <= opts.minOpacity) m.push('transparent');
  if (style.color === 'transparent' || /^rgba\(.*,\s*0(\.0+)?\s*\)$/.test(style.color ?? '')) m.push('transparent');
  const size = style['font-size'] !== undefined ? px(style['font-size']) : null;
  if (size !== null && size * 0.75 < opts.minFontPt) m.push('tiny-text');
  const positioned = ['absolute', 'fixed'].includes(style.position);
  if (positioned && ['left', 'top', 'right', 'bottom'].some((k) => (px(style[k]) ?? 0) <= -500)) m.push('off-screen');
  if ((px(style['text-indent']) ?? 0) <= -500) m.push('off-screen');
  if (/scale\(\s*0(\.0+)?\s*(,\s*0(\.0+)?\s*)?\)/.test(style.transform ?? '')) m.push('collapsed');
  const clipped = /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(style.clip ?? '') || /inset\(\s*(50|100)%\s*\)/.test(style['clip-path'] ?? '');
  const tinyBox = ['width', 'height'].every((k) => (px(style[k]) ?? Infinity) <= 1) && style.overflow === 'hidden';
  if (clipped || tinyBox) m.push('visually-hidden');
  if (style.overflow === 'hidden' && ((px(style['max-height']) ?? Infinity) <= 0 || (px(style.height) ?? Infinity) <= 0) && !tinyBox) m.push('collapsed');
  return [...new Set(m)];
}

const describe = {
  'hidden-attribute': () => 'marked with the hidden attribute',
  template: () => 'inside a <template>, which is never rendered',
  'display-none': () => 'styled display:none',
  'visibility-hidden': () => 'styled visibility:hidden',
  transparent: () => 'styled fully transparent',
  'tiny-text': (e) => `set at ${e.font_pt}pt`,
  'off-screen': () => 'positioned off screen',
  collapsed: () => 'collapsed to zero size',
  'visually-hidden': () => 'clipped to a 1px box (the screen-reader-only pattern)',
  'low-contrast': (e) => `coloured ${e.color} on ${e.background} (contrast ${e.contrast.toFixed(2)}:1)`,
};

function lineAt(starts, index) {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

const textContent = (node) => (node.type === 'text' ? node.data : SKIP.has(node.name) ? '' : (node.children ?? []).map(textContent).join(BLOCK.has(node.name) ? ' ' : ''));

export function scanHtml(source, opts = {}) {
  const options = { minContrast: MIN_CONTRAST, minFontPt: MIN_FONT_PT, minOpacity: MIN_OPACITY, ...opts };
  const html = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const lineStarts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === '\n') lineStarts.push(i + 1);
  const doc = parseDocument(html, { withStartIndices: true, lowerCaseAttributeNames: true, lowerCaseTags: true, recognizeSelfClosing: true });
  const line = (node) => lineAt(lineStarts, node.startIndex ?? 0);

  const css = [];
  const collect = (n) => { for (const c of n.children ?? []) { if (c.name === 'style') css.push(textContent({ ...c, name: 'span' })); collect(c); } };
  collect(doc);
  const rules = parseRules(css.join('\n'));

  const findings = [];
  const visible = [];
  const walk = (node, ctx) => {
    for (const c of node.children ?? []) {
      if (c.type === 'comment') {
        const f = channelFinding({ rule: 'html-comment', channel: 'An HTML comment', text: c.data ?? '', location: { line: line(c) }, longAt: 0 });
        if (f) findings.push(f);
        continue;
      }
      if (c.type === 'text') {
        if (!ctx.hidden && c.data.trim()) visible.push({ line: line(c), text: c.data });
        continue;
      }
      if (c.type !== 'tag' && c.type !== 'script' && c.type !== 'style') continue;
      for (const attr of ATTRS) {
        const value = c.attribs?.[attr];
        if (!value || (attr === 'content' && c.name !== 'meta') || (attr === 'value' && c.name !== 'input')) continue;
        const where = c.name === 'meta' ? `A <meta${c.attribs.name ? ` name="${c.attribs.name}"` : c.attribs.property ? ` property="${c.attribs.property}"` : ''}> tag` : `The ${attr} attribute of a <${c.name}>`;
        const f = channelFinding({ rule: 'html-attribute', channel: where, text: value, location: { line: line(c), element: c.name, attribute: attr }, longAt: c.attribs?.type === 'hidden' ? 1 : 0 });
        if (f) findings.push(f);
      }
      if (c.name === 'script') {
        if ((c.attribs?.type ?? '').includes('json')) {
          const f = channelFinding({ rule: 'html-attribute', channel: 'Structured data in a JSON <script>', text: textContent({ ...c, name: 'span' }), location: { line: line(c), element: 'script' }, longAt: 0 });
          if (f) findings.push(f);
        }
        continue;
      }
      if (SKIP.has(c.name)) { if (c.name === 'head') walk(c, ctx); continue; }
      const style = styleOf(c, rules);
      const color = style.color ? parseColor(style.color) ?? ctx.color : ctx.color;
      const bg = style['background-color'] || style.background ? parseColor(style['background-color'] ?? style.background?.split(/\s+/)[0]) ?? ctx.bg : ctx.bg;
      const mechanisms = hidingOf(c, style, options);
      const evidence = {};
      if (mechanisms.includes('tiny-text')) evidence.font_pt = Math.round(px(style['font-size']) * 0.75 * 100) / 100;
      if (color && !mechanisms.length && (style.color || style['background-color'] || style.background)) {
        const { ratio, deltaE, hidden } = unreadable(color, bg, options.minContrast);
        if (hidden) {
          mechanisms.push('low-contrast');
          Object.assign(evidence, { color: toHex(color), background: toHex(bg), contrast: ratio, delta_e: deltaE });
        }
      }
      if (mechanisms.length || ctx.hidden) {
        const content = textContent(c).replace(/\s+/g, ' ').trim();
        if (content && !ctx.hidden) {
          const phrases = findInstructionPhrases(content);
          let severity = hiddenSeverity(content, phrases);
          if (!phrases.length && mechanisms.every((m) => m === 'visually-hidden') && content.length < 120) severity = 'low';
          findings.push({
            rule: 'hidden-text', severity,
            reason: `Text a reader cannot see: ${mechanisms.map((m) => describe[m](evidence)).join(', ')}.${phrases.length ? ' It is worded as instructions to a model.' : ''}`,
            page: null, bbox: null, text: preview(content), phrases: phraseIds(phrases), mechanisms, evidence, location: { line: line(c), element: c.name },
          });
          findings.push(...findUnicodeTricks(content, { location: { line: line(c) } }));
        }
        walk(c, { ...ctx, color, bg, hidden: true });
        continue;
      }
      if (BLOCK.has(c.name)) visible.push({ line: line(c), text: '\n' });
      walk(c, { ...ctx, color, bg });
    }
  };
  walk(doc, { color: [0, 0, 0], bg: WHITE, hidden: false });

  // Visible text: phrase matching per source line, then invisible-character checks.
  const byLine = new Map();
  for (const v of visible) byLine.set(v.line, `${byLine.get(v.line) ?? ''}${v.text}`);
  const lines = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
  for (const { first, last, ids } of phraseHitsByLine(lines.map(([, t]) => t))) {
    findings.push({
      rule: 'instruction-phrase', severity: 'medium', reason: visibleReason(ids),
      page: null, bbox: null, text: preview(lines.slice(first, last + 1).map(([, t]) => t).join(' ')), phrases: ids,
      location: { line: lines[first][0], ...(last !== first ? { through_line: lines[last][0] } : {}) },
    });
  }
  for (const [ln, t] of lines) findings.push(...findUnicodeTricks(t, { location: { line: ln } }));
  return { pages: null, findings, attachments: [] };
}
