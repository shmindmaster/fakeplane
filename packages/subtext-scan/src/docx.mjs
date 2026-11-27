/**
 * DOCX: runs a reader cannot see, and text in parts a reader does not look at.
 *
 * Run formatting is resolved the way Word does for the properties that hide text: document
 * defaults, then the paragraph style chain, then the character style chain, then direct
 * formatting. Background is the run's highlight or shading, else the paragraph's, the table
 * cell's, or the document background, else white.
 *
 * DOCX has no fixed pages, so a location is the part and 1-based paragraph number.
 */
import { strFromU8, unzipSync } from 'fflate';
import { parseDocument } from 'htmlparser2';

import { channelFinding, hiddenSeverity, MIN_CONTRAST, MIN_FONT_PT, parseColor, phraseHitsByLine, phraseIds, preview, toHex, unreadable, visibleReason } from './common.mjs';
import { findInstructionPhrases } from './phrases.mjs';
import { findUnicodeTricks } from './unicode.mjs';

const WHITE = [255, 255, 255];
const BODY_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const off = (el) => ['0', 'false', 'off'].includes(el?.attribs?.['w:val']);

const kids = (node) => (node?.children ?? []).filter((c) => c.type === 'tag');
const child = (node, name) => kids(node).find((c) => c.name === name);
function* descendants(node, name) {
  for (const c of kids(node)) {
    if (c.name === name) yield c;
    yield* descendants(c, name);
  }
}

function readRPr(rPr) {
  if (!rPr) return {};
  const p = {};
  const vanish = child(rPr, 'w:vanish') ?? child(rPr, 'w:specVanish');
  if (vanish) p.vanish = !off(vanish);
  const color = child(rPr, 'w:color')?.attribs?.['w:val'];
  if (color) p.color = color.toLowerCase() === 'auto' ? 'auto' : color;
  const sz = child(rPr, 'w:sz')?.attribs?.['w:val'];
  if (sz && Number.isFinite(Number(sz))) p.halfPoints = Number(sz);
  const highlight = child(rPr, 'w:highlight')?.attribs?.['w:val'];
  if (highlight) p.highlight = highlight.toLowerCase() === 'none' ? null : highlight;
  const shd = child(rPr, 'w:shd')?.attribs?.['w:fill'];
  if (shd) p.shading = shd.toLowerCase() === 'auto' ? null : shd;
  return p;
}

function readStyles(xml) {
  const styles = new Map();
  let defaults = {};
  if (!xml) return { styles, defaults };
  const doc = parseDocument(xml, { xmlMode: true });
  const root = kids(doc)[0];
  defaults = readRPr(child(child(child(root, 'w:docDefaults'), 'w:rPrDefault'), 'w:rPr'));
  for (const st of descendants(root, 'w:style')) {
    styles.set(st.attribs['w:styleId'], { basedOn: child(st, 'w:basedOn')?.attribs?.['w:val'] ?? null, rPr: readRPr(child(st, 'w:rPr')) });
  }
  return { styles, defaults };
}

function styleChain(styles, id, seen = new Set()) {
  if (!id || seen.has(id) || !styles.has(id)) return {};
  seen.add(id);
  const st = styles.get(id);
  return { ...styleChain(styles, st.basedOn, seen), ...st.rPr };
}

function runText(r) {
  let text = '';
  for (const c of kids(r)) {
    if (c.name === 'w:t') text += c.children.map((t) => t.data ?? '').join('');
    else if (c.name === 'w:tab') text += '\t';
    else if (c.name === 'w:br' || c.name === 'w:cr') text += '\n';
    else if (c.name === 'w:noBreakHyphen') text += '-';
  }
  return text;
}
const deletedText = (r) => kids(r).filter((c) => c.name === 'w:delText').map((c) => c.children.map((t) => t.data ?? '').join('')).join('');

/** Paragraphs of one part, each with its runs and their resolved formatting and background. */
function readPart(xml, { styles, defaults }, docBackground) {
  const doc = parseDocument(xml, { xmlMode: true });
  const paragraphs = [];
  const deleted = [];
  const walk = (node, ctx) => {
    for (const c of kids(node)) {
      if (c.name === 'w:tc') {
        const fill = child(child(c, 'w:tcPr'), 'w:shd')?.attribs?.['w:fill'];
        walk(c, { ...ctx, cellShading: fill && fill.toLowerCase() !== 'auto' ? fill : ctx.cellShading });
      } else if (c.name === 'w:p') {
        const pPr = child(c, 'w:pPr');
        const pStyle = child(pPr, 'w:pStyle')?.attribs?.['w:val'];
        const fill = child(pPr, 'w:shd')?.attribs?.['w:fill'];
        const para = { index: paragraphs.length + 1, runs: [] };
        paragraphs.push(para);
        walk(c, { ...ctx, para, pStyle, paraShading: fill && fill.toLowerCase() !== 'auto' ? fill : null });
      } else if (c.name === 'w:r' && ctx.para) {
        const rPr = child(c, 'w:rPr');
        const rStyle = child(rPr, 'w:rStyle')?.attribs?.['w:val'];
        const props = { ...defaults, ...styleChain(styles, ctx.pStyle), ...styleChain(styles, rStyle), ...readRPr(rPr) };
        const text = runText(c);
        if (text) {
          const bg = parseColor(props.highlight) ?? parseColor(props.shading) ?? parseColor(ctx.paraShading) ?? parseColor(ctx.cellShading) ?? docBackground ?? WHITE;
          ctx.para.runs.push({ text, props, bg });
        }
        const del = deletedText(c);
        if (del) deleted.push({ paragraph: ctx.para.index, text: del });
        walk(c, { ...ctx, para: null });
      } else {
        walk(c, ctx);
      }
    }
  };
  walk(doc, { para: null });
  return { paragraphs, deleted };
}

function judgeRun(run, opts) {
  const mechanisms = [];
  const evidence = {};
  if (run.props.vanish) mechanisms.push('hidden-attribute');
  if (run.props.halfPoints !== undefined && run.props.halfPoints / 2 < opts.minFontPt) { mechanisms.push('tiny-text'); evidence.font_pt = run.props.halfPoints / 2; }
  const color = run.props.color && run.props.color !== 'auto' ? parseColor(run.props.color) : null;
  if (color) {
    const { ratio, deltaE, hidden } = unreadable(color, run.bg, opts.minContrast);
    if (hidden) { mechanisms.push('low-contrast'); Object.assign(evidence, { color: toHex(color), background: toHex(run.bg), contrast: ratio, delta_e: deltaE }); }
  }
  return { mechanisms, evidence };
}

const describe = {
  'hidden-attribute': () => 'formatted as hidden text (w:vanish)',
  'tiny-text': (e) => `set at ${e.font_pt}pt`,
  'low-contrast': (e) => `coloured ${e.color} on ${e.background} (contrast ${e.contrast.toFixed(2)}:1)`,
};

function partFindings(part, { paragraphs, deleted }, opts) {
  const findings = [];
  const groups = [];
  const visible = [];
  for (const para of paragraphs) {
    let line = '';
    for (const run of para.runs) {
      const { mechanisms, evidence } = judgeRun(run, opts);
      if (!mechanisms.length) { line += run.text; continue; }
      const key = mechanisms.join('+');
      const prev = groups.at(-1);
      if (prev && prev.key === key && para.index - prev.last <= 1) { prev.text += (prev.last === para.index ? '' : '\n') + run.text; prev.last = para.index; }
      else groups.push({ key, mechanisms, evidence, text: run.text, first: para.index, last: para.index });
    }
    visible.push({ paragraph: para.index, text: line });
  }
  for (const g of groups) {
    const text = g.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const phrases = findInstructionPhrases(text);
    findings.push({
      rule: 'hidden-text', severity: hiddenSeverity(text, phrases),
      reason: `Text a reader cannot see: ${g.mechanisms.map((m) => describe[m](g.evidence)).join(', ')}.${phrases.length ? ' It is worded as instructions to a model.' : ''}`,
      page: null, bbox: null, text: preview(text), phrases: phraseIds(phrases), mechanisms: g.mechanisms, evidence: g.evidence,
      location: { part, paragraph: g.first, ...(g.last !== g.first ? { through_paragraph: g.last } : {}) },
    });
  }
  for (const { first, last, ids } of phraseHitsByLine(visible.map((v) => v.text))) {
    findings.push({
      rule: 'instruction-phrase', severity: 'medium', reason: visibleReason(ids),
      page: null, bbox: null, text: preview(visible.slice(first, last + 1).map((v) => v.text).join(' ')), phrases: ids,
      location: { part, paragraph: visible[first].paragraph, ...(last !== first ? { through_paragraph: visible[last].paragraph } : {}) },
    });
  }
  for (const d of deleted) {
    const f = channelFinding({ rule: 'tracked-change', channel: 'Deleted text kept in a tracked change', text: d.text, location: { part, paragraph: d.paragraph }, longAt: 0 });
    if (f) findings.push(f);
  }
  const all = paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
  findings.push(...findUnicodeTricks(all, { location: { part } }));
  return findings;
}

function textOf(node) {
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? []).map((c) => textOf(c) + (c.name === 'w:p' ? '\n' : '')).join('');
}

function propertyFindings(files) {
  const findings = [];
  for (const part of ['docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml']) {
    if (!files[part]) continue;
    const doc = parseDocument(strFromU8(files[part]), { xmlMode: true });
    const root = kids(doc)[0];
    for (const el of kids(root)) {
      const name = el.attribs?.name ?? el.name;
      const value = textOf(el).trim();
      if (!value) continue;
      const f = channelFinding({ rule: 'metadata', channel: `Document property "${name}"`, text: value, location: { part, field: name } });
      if (f) findings.push(f);
    }
  }
  return findings;
}

function commentFindings(files) {
  const xml = files['word/comments.xml'];
  if (!xml) return [];
  const doc = parseDocument(strFromU8(xml), { xmlMode: true });
  const findings = [];
  for (const c of descendants(kids(doc)[0], 'w:comment')) {
    const f = channelFinding({ rule: 'comment', channel: `A review comment by "${c.attribs['w:author'] ?? 'unknown'}"`, text: textOf(c), location: { part: 'word/comments.xml', comment: c.attribs['w:id'] ?? null }, longAt: 0 });
    if (f) findings.push(f);
  }
  return findings;
}

export function scanDocx(bytes, opts = {}) {
  const options = { minContrast: MIN_CONTRAST, minFontPt: MIN_FONT_PT, ...opts };
  let files;
  try { files = unzipSync(new Uint8Array(bytes)); } catch (err) {
    throw Object.assign(new Error(`not a readable DOCX: ${err?.message ?? err}`), { code: 'UNREADABLE' });
  }
  if (!files['word/document.xml']) throw Object.assign(new Error('not a DOCX: word/document.xml is missing'), { code: 'UNREADABLE' });
  const styles = readStyles(files['word/styles.xml'] ? strFromU8(files['word/styles.xml']) : null);
  const docXml = strFromU8(files['word/document.xml']);
  const bgVal = /<w:background\b[^>]*\bw:color="([0-9A-Fa-f]{6})"/.exec(docXml)?.[1];
  const docBackground = bgVal ? parseColor(bgVal) : null;

  const findings = [];
  const parts = Object.keys(files).filter((p) => BODY_PARTS.test(p)).sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)));
  for (const part of parts) findings.push(...partFindings(part, readPart(strFromU8(files[part]), styles, docBackground), options));
  findings.push(...commentFindings(files), ...propertyFindings(files));

  const attachments = Object.entries(files)
    .filter(([p, data]) => p.startsWith('word/') && data.length && !p.endsWith('.xml') && !p.endsWith('.rels') && !p.startsWith('word/media/') && !p.startsWith('word/fonts/') && !p.startsWith('word/theme/'))
    .map(([p, content]) => ({ filename: p, content }));
  return { pages: null, findings, attachments };
}
