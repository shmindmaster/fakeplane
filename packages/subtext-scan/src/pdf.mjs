/**
 * PDF: text a model reads that a person cannot see.
 *
 * Walks each page's operator list (pdf.js) with a small painter model: the current transform,
 * fill and stroke colour, opacity, text render mode, optional-content layer, and every filled
 * shape and image in paint order. Each run of text is judged against what is behind it (the
 * top-most fill under it, or the white page) and what is painted over it afterwards.
 *
 * Coordinates are PDF points with the origin at the bottom left of the page, as pdf.js reports
 * `page.view`. A bbox is [x0, y0, x1, y1]: baseline-to-ascent for text.
 */
import { AnnotationMode, getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { channelFinding, hiddenSeverity, MIN_CONTRAST, MIN_FONT_PT, MIN_OPACITY, parseColor, phraseHitsByLine, phraseIds, preview, toHex, unreadable, visibleReason } from './common.mjs';
import { findInstructionPhrases } from './phrases.mjs';
import { findUnicodeTricks } from './unicode.mjs';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const WHITE = [255, 255, 255];
const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask]);
const TEXT_OPS = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);

const compose = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r2 = (n) => Math.round(n * 100) / 100;

function boxOf(points) {
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const transformBox = (m, [x0, y0, x1, y1]) => boxOf([apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)]);
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const contains = (outer, inner, tol = 0.5) => outer[0] - tol <= inner[0] && outer[1] - tol <= inner[1] && outer[2] + tol >= inner[2] && outer[3] + tol >= inner[3];
const containsPoint = (b, [x, y]) => b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3];
const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

function newState() {
  return {
    ctm: IDENTITY, fill: [0, 0, 0], stroke: [0, 0, 0], fillAlpha: 1, strokeAlpha: 1,
    font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, renderMode: 0,
    clip: null,
  };
}

/** Walk one page's operator list into text segments and paints. */
async function readPage(page, ocConfig) {
  const opList = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const { fnArray, argsArray } = opList;
  const fonts = new Map();
  const fontOf = (name) => {
    if (!fonts.has(name)) {
      let f = null;
      try { f = page.commonObjs.has(name) ? page.commonObjs.get(name) : page.objs.has(name) ? page.objs.get(name) : null; } catch { f = null; }
      fonts.set(name, {
        matrix: f?.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0],
        ascent: Number.isFinite(f?.ascent) && f.ascent > 0 ? Math.min(f.ascent, 1.2) : 0.8,
        descent: Number.isFinite(f?.descent) && f.descent < 0 ? Math.max(f.descent, -0.5) : -0.2,
      });
    }
    return fonts.get(name);
  };

  let s = newState();
  const stack = [];
  const layers = [];
  let tm = IDENTITY; let tlm = IDENTITY;
  const segments = [];
  const paints = [];
  let seq = 0;
  let pendingClip = false;

  const hiddenLayer = () => layers.find((l) => l.hidden) ?? null;
  // The clip region is tracked as a bounding box: an over-estimate, so text is only called
  // clipped when it lies wholly outside every clip path's bounds.
  const clipTo = (box) => { s.clip = s.clip ? intersect(s.clip, box) : box; };
  const visibleBox = (box) => (s.clip ? intersect(box, s.clip) : box);
  const moveText = (tx, ty) => { tlm = compose(tlm, [1, 0, 0, 1, tx, ty]); tm = tlm; };

  const showGlyphs = (glyphs) => {
    if (!Array.isArray(glyphs) || !s.font) return;
    const font = fontOf(s.font);
    const fs = s.fontSize;
    const dir = fs < 0 ? -1 : 1;
    const widthScale = Math.abs(fs) * font.matrix[0];
    const m = compose(s.ctm, tm);
    const sizePt = Math.abs(fs) * Math.hypot(m[2], m[3]);
    const chars = [];
    for (const g of glyphs) {
      if (typeof g === 'number') {
        const tx = (-g / 1000) * Math.abs(fs) * s.hScale;
        if (tx > 0.25 * Math.abs(fs) && chars.length) chars.push({ ch: ' ', space: true });
        tm = compose(tm, [1, 0, 0, 1, tx, 0]);
        continue;
      }
      if (!g) continue;
      const w0 = (g.width ?? 0) * widthScale;
      const advance = (w0 + (s.charSpacing + (g.isSpace ? s.wordSpacing : 0)) * dir) * s.hScale;
      const gm = compose(s.ctm, tm);
      const lo = font.descent * Math.abs(fs) + s.rise;
      const hi = font.ascent * Math.abs(fs) + s.rise;
      const box = boxOf([apply(gm, 0, lo), apply(gm, w0 * s.hScale, lo), apply(gm, 0, hi), apply(gm, w0 * s.hScale, hi)]);
      chars.push({ ch: g.unicode ?? '', box, baseline: apply(gm, 0, s.rise) });
      tm = compose(tm, [1, 0, 0, 1, advance, 0]);
    }
    if (!chars.some((c) => c.box && c.ch.trim())) return;
    const layer = hiddenLayer();
    segments.push({
      seq: seq++, chars, sizePt,
      renderMode: s.renderMode,
      fill: s.fill, stroke: s.stroke, fillAlpha: s.fillAlpha, strokeAlpha: s.strokeAlpha,
      layer: layer ? layer.name : null, clip: s.clip,
    });
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ...s }); break;
      case OPS.restore: if (stack.length) s = stack.pop(); break;
      case OPS.transform: s.ctm = compose(s.ctm, args); break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...s });
        if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) s.ctm = compose(s.ctm, Array.from(args[0]));
        if (Array.isArray(args[1]) || ArrayBuffer.isView(args[1])) clipTo(transformBox(s.ctm, Array.from(args[1])));
        break;
      case OPS.paintFormXObjectEnd: if (stack.length) s = stack.pop(); break;
      case OPS.setFillRGBColor: s.fill = parseColor(args[0]); break;
      case OPS.setStrokeRGBColor: s.stroke = parseColor(args[0]); break;
      case OPS.setFillTransparent: case OPS.setFillColorN: s.fill = null; break;
      case OPS.setStrokeTransparent: case OPS.setStrokeColorN: s.stroke = null; break;
      case OPS.setGState:
        for (const [key, value] of args[0] ?? []) {
          if (key === 'ca' && Number.isFinite(value)) s.fillAlpha = value;
          else if (key === 'CA' && Number.isFinite(value)) s.strokeAlpha = value;
          else if (key === 'Font' && Array.isArray(value)) { s.font = value[0]; s.fontSize = value[1]; }
        }
        break;
      case OPS.beginText: tm = IDENTITY; tlm = IDENTITY; break;
      case OPS.setFont: s.font = args[0]; s.fontSize = args[1]; break;
      case OPS.setCharSpacing: s.charSpacing = args[0]; break;
      case OPS.setWordSpacing: s.wordSpacing = args[0]; break;
      case OPS.setHScale: s.hScale = args[0] / 100; break;
      case OPS.setLeading: s.leading = args[0]; break;
      case OPS.setTextRise: s.rise = args[0]; break;
      case OPS.setTextRenderingMode: s.renderMode = args[0]; break;
      case OPS.setTextMatrix: tm = Array.from(args[0]); tlm = tm; break;
      case OPS.moveText: moveText(args[0], args[1]); break;
      case OPS.setLeadingMoveText: s.leading = -args[1]; moveText(args[0], args[1]); break;
      case OPS.nextLine: moveText(0, -s.leading); break;
      case OPS.beginMarkedContent: layers.push({ hidden: false }); break;
      case OPS.beginMarkedContentProps: {
        let hidden = false; let name = null;
        if (args[0] === 'OC' && args[1] && ocConfig) {
          try { hidden = !ocConfig.isVisible(args[1]); } catch { hidden = false; }
          const id = args[1].id ?? args[1].ids?.[0];
          name = (id && ocConfig.getGroup?.(id)?.name) || id || 'unnamed layer';
        }
        layers.push({ hidden, name });
        break;
      }
      case OPS.endMarkedContent: layers.pop(); break;
      case OPS.clip: case OPS.eoClip: pendingClip = true; break;
      case OPS.constructPath: {
        const [paintOp, , minMax] = args;
        const box = minMax ? transformBox(s.ctm, Array.from(minMax)) : null;
        if (FILL_OPS.has(paintOp) && box && s.fill && !hiddenLayer()) {
          const bbox = visibleBox(box);
          if (area(bbox) > 0) paints.push({ seq: seq++, kind: 'shape', color: s.fill, alpha: s.fillAlpha, bbox });
        }
        if (pendingClip) { if (box) clipTo(box); pendingClip = false; }
        break;
      }
      default:
        if (TEXT_OPS.has(fn)) {
          showGlyphs(args[0]);
        } else if (IMAGE_OPS.has(fn) && !hiddenLayer()) {
          const kind = fn === OPS.paintSolidColorImageMask ? 'shape' : 'image';
          const bbox = visibleBox(transformBox(s.ctm, [0, 0, 1, 1]));
          if (area(bbox) > 0) paints.push({ seq: seq++, kind, color: kind === 'shape' ? s.fill : null, alpha: s.fillAlpha, bbox });
        }
    }
  }
  return { segments, paints };
}

/** Split a segment wherever glyphs cross the page edge or the clip, so seen and unseen text are judged apart. */
function splitByPage(segment, view) {
  const pieces = [];
  for (const c of segment.chars) {
    const prev = pieces.at(-1);
    const off = c.box ? !containsPoint(view, center(c.box)) : prev?.off ?? false;
    const clipped = c.box ? Boolean(segment.clip) && !containsPoint(segment.clip, center(c.box)) : prev?.clipped ?? false;
    if (!prev || prev.off !== off || prev.clipped !== clipped) pieces.push({ ...segment, chars: [], off, clipped });
    pieces.at(-1).chars.push(c);
  }
  return pieces
    .map((p) => {
      const boxes = p.chars.filter((c) => c.box).map((c) => c.box);
      return { ...p, text: p.chars.map((c) => c.ch).join(''), bbox: boxes.length ? boxes.reduce(union) : null, baseline: p.chars.find((c) => c.baseline)?.baseline };
    })
    .filter((p) => p.bbox && p.text.trim());
}

function judge(seg, paints, pageBox, opts) {
  const mechanisms = [];
  const evidence = { font_pt: r2(seg.sizePt), render_mode: seg.renderMode };
  const paintsFill = [0, 2, 4, 6].includes(seg.renderMode);
  const paintsStroke = [1, 2, 5, 6].includes(seg.renderMode);
  if (!paintsFill && !paintsStroke) mechanisms.push('invisible-render-mode');
  const alpha = Math.max(paintsFill ? seg.fillAlpha : 0, paintsStroke ? seg.strokeAlpha : 0);
  if ((paintsFill || paintsStroke) && alpha <= opts.minOpacity) { mechanisms.push('transparent'); evidence.opacity = r2(alpha); }
  if (seg.sizePt < opts.minFontPt) mechanisms.push('tiny-text');
  if (seg.off) mechanisms.push('off-page');
  if (seg.layer) { mechanisms.push('hidden-layer'); evidence.layer = seg.layer; }

  if (seg.clipped && !seg.off) mechanisms.push('clipped');

  const color = paintsFill ? seg.fill : seg.stroke;
  if (color && (paintsFill || paintsStroke) && !seg.off && !seg.clipped) {
    const c = center(seg.bbox);
    let under = null;
    for (let i = paints.length - 1; i >= 0 && !under; i--) {
      const p = paints[i];
      if (p.seq < seg.seq && p.alpha >= 0.5 && containsPoint(p.bbox, c)) under = p;
    }
    const bg = under ? (under.kind === 'image' ? null : under.color) : WHITE;
    if (bg) {
      const { ratio, deltaE, hidden } = unreadable(color, bg, opts.minContrast);
      Object.assign(evidence, { color: toHex(color), background: toHex(bg), contrast: ratio, delta_e: deltaE });
      if (hidden) mechanisms.push('low-contrast');
    }
  }
  const over = paints.find((p) => p.seq > seg.seq && (p.kind === 'image' || p.alpha >= 0.9) && contains(p.bbox, seg.bbox));
  if (over && !seg.off && !seg.clipped) {
    mechanisms.push('covered');
    evidence.covered_by = over.kind;
    evidence.cover_page_fraction = r2(area(intersect(over.bbox, pageBox)) / area(pageBox));
  }
  return { mechanisms, evidence };
}

const describe = {
  'low-contrast': (e) => `drawn in ${e.color} on ${e.background} (contrast ${e.contrast.toFixed(2)}:1)`,
  'tiny-text': (e) => `set at ${e.font_pt}pt`,
  'off-page': () => 'placed outside the visible page',
  clipped: () => 'outside the clipping region, so it is never painted',
  'invisible-render-mode': (e) => `drawn with the invisible text render mode (Tr ${e.render_mode})`,
  transparent: (e) => `drawn at ${Math.round(e.opacity * 100)}% opacity`,
  'hidden-layer': (e) => `inside the hidden layer "${e.layer}"`,
  covered: (e) => `covered by ${e.covered_by === 'image' ? 'an image' : 'a filled shape'} drawn on top`,
};

/** Is the page essentially one image (a scan)? Invisible text over it is a normal OCR layer. */
const isScan = (paints, pageBox) => paints.some((p) => p.kind === 'image' && area(intersect(p.bbox, pageBox)) >= 0.5 * area(pageBox));

function hiddenFindings(pageNo, runs, scan) {
  const findings = [];
  const ocr = [];
  for (const run of runs) {
    const text = run.text.replace(/\s+/g, ' ').trim();
    const phrases = findInstructionPhrases(text);
    const ocrLike = scan && run.mechanisms.every((m) => m === 'invisible-render-mode' || (m === 'covered' && run.evidence.covered_by === 'image'));
    if (ocrLike && !phrases.length) { ocr.push(run); continue; }
    const parts = run.mechanisms.map((m) => describe[m](run.evidence));
    findings.push({
      rule: 'hidden-text',
      severity: hiddenSeverity(text, phrases),
      reason: `Text a reader cannot see: ${parts.join(', ')}.${phrases.length ? ' It is worded as instructions to a model.' : ''}`,
      page: pageNo, bbox: run.bbox.map(r2), text: preview(text), phrases: phraseIds(phrases),
      mechanisms: run.mechanisms, evidence: run.evidence,
    });
  }
  if (ocr.length) {
    const text = ocr.map((r) => r.text).join(' ');
    findings.push({
      rule: 'ocr-text-layer', severity: 'info',
      reason: `Page ${pageNo} is a scanned image with an invisible OCR text layer (${text.replace(/\s+/g, ' ').trim().length} characters). That is normal for a searchable scan; the layer is what a model reads.`,
      page: pageNo, bbox: ocr.map((r) => r.bbox).reduce(union).map(r2), text: preview(text, 160), phrases: [],
      mechanisms: [...new Set(ocr.flatMap((r) => r.mechanisms))], evidence: { runs: ocr.length },
    });
  }
  return findings;
}

/** Merge consecutive segments that are hidden the same way and sit near each other. */
function mergeRuns(judged) {
  const runs = [];
  for (const seg of judged) {
    const key = seg.mechanisms.join('+');
    const prev = runs.at(-1);
    const near = prev && Math.abs(center(prev.bbox)[1] - center(seg.bbox)[1]) <= 3 * Math.max(prev.sizePt, seg.sizePt, 1) + (prev.bbox[3] - prev.bbox[1]);
    if (prev && prev.key === key && near) {
      prev.text += (prev.text.endsWith(' ') || seg.text.startsWith(' ') ? '' : ' ') + seg.text;
      prev.bbox = union(prev.bbox, seg.bbox);
      prev.sizePt = Math.min(prev.sizePt, seg.sizePt);
    } else {
      runs.push({ key, text: seg.text, bbox: seg.bbox, sizePt: seg.sizePt, mechanisms: seg.mechanisms, evidence: seg.evidence });
    }
  }
  return runs;
}

/** Visible text as lines, for phrase matching that maps a match back to its line boxes. */
function visibleLines(segments) {
  const lines = [];
  for (const seg of segments) {
    const y = seg.baseline?.[1] ?? seg.bbox[1];
    const line = lines.find((l) => Math.abs(l.y - y) <= 0.4 * Math.max(l.size, seg.sizePt));
    if (line) { line.parts.push(seg); line.bbox = union(line.bbox, seg.bbox); } else lines.push({ y, size: seg.sizePt, parts: [seg], bbox: seg.bbox });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => ({ bbox: l.bbox, text: l.parts.sort((a, b) => a.bbox[0] - b.bbox[0]).map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim() }));
}

function phraseFindingsForLines(pageNo, lines) {
  return phraseHitsByLine(lines.map((l) => l.text)).map(({ first, last, ids }) => {
    const span = lines.slice(first, last + 1);
    return {
      rule: 'instruction-phrase', severity: 'medium', reason: visibleReason(ids),
      page: pageNo, bbox: span.map((l) => l.bbox).reduce(union).map(r2), text: preview(span.map((l) => l.text).join(' ')), phrases: ids,
    };
  });
}

const squash = (t) => t.toLowerCase().replace(/[\s\p{P}]+/gu, '');

async function annotationFindings(page, pageNo, view, nested, visibleText) {
  const findings = [];
  let annots = [];
  try { annots = await page.getAnnotations(); } catch { return findings; }
  const onPage = squash(visibleText);
  for (const a of annots) {
    // A Popup is hidden by design and repeats the contents of its parent comment, which is checked itself.
    if (a.subtype === 'Popup') continue;
    // A flattened form keeps hidden widgets whose values are also printed on the page; those are not hidden content.
    const pieces = [a.contentsObj?.str, a.richText?.str, a.alternativeText, a.textContent?.join?.(' '), ...(Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue])]
      .filter((t) => typeof t === 'string' && t.trim() && !onPage.includes(squash(t)));
    const text = [...new Set(pieces)].join('\n');
    const rect = Array.isArray(a.rect) ? a.rect.map(Number) : null;
    const hiddenFlag = (a.annotationFlags & 2) || (a.annotationFlags & 32) || a.hidden;
    const offPage = rect && area(intersect(rect, view)) === 0;
    const zero = rect && area(rect) === 0;
    const hidden = hiddenFlag || offPage || zero;
    const label = `${hidden ? 'A hidden ' : 'A '}${a.subtype ?? 'annotation'} annotation`;
    if (text) {
      const f = channelFinding({ rule: 'annotation', channel: label, text, page: pageNo, bbox: rect?.map(r2) ?? null, location: { subtype: a.subtype ?? null, hidden: Boolean(hidden) }, longAt: 0 });
      if (f) findings.push(f);
      else if (hidden && /\p{L}{2,}/u.test(text)) {
        findings.push({ rule: 'annotation', severity: 'medium', reason: `${label} holds text a reader does not see on the page.`, page: pageNo, bbox: rect?.map(r2) ?? null, text: preview(text), phrases: [], location: { subtype: a.subtype ?? null, hidden: true } });
      }
    }
    if (a.fileId || a.file?.content) nested.push({ id: a.fileId ?? null, filename: a.file?.filename ?? 'attachment', content: a.file?.content ?? null, page: pageNo });
  }
  return findings;
}

async function metadataFindings(pdf) {
  const findings = [];
  let meta = null;
  try { meta = await pdf.getMetadata(); } catch { return findings; }
  const fields = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === 'string') fields.push([`${prefix}${k}`, v]);
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}.`);
    }
  };
  walk(meta?.info, '');
  try { walk(meta?.metadata?.getAll?.(), 'xmp:'); } catch { /* malformed XMP */ }
  const seen = new Set();
  for (const [field, value] of fields) {
    if (seen.has(value)) continue;
    seen.add(value);
    const f = channelFinding({ rule: 'metadata', channel: `Document metadata field "${field}"`, text: value, location: { field } });
    if (f) findings.push(f);
  }
  return findings;
}

async function outlineFindings(pdf) {
  const findings = [];
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { return findings; }
  const titles = [];
  const walk = (items) => { for (const it of items ?? []) { if (it.title) titles.push(it.title); walk(it.items); } };
  walk(outline);
  for (const title of titles) {
    const f = channelFinding({ rule: 'metadata', channel: 'A bookmark title', text: title, location: { field: 'outline' }, longAt: 0 });
    if (f) findings.push(f);
  }
  return findings;
}

async function scriptFindings(pdf) {
  let js = null;
  try { js = await pdf.getJSActions(); } catch { return []; }
  const code = Object.values(js ?? {}).flat().filter((x) => typeof x === 'string');
  if (!code.length) return [];
  const text = code.join('\n');
  return [channelFinding({ rule: 'javascript', channel: 'Document JavaScript', text, location: {}, longAt: 0 })
    ?? { rule: 'javascript', severity: 'low', reason: `The document carries ${code.length} JavaScript action${code.length === 1 ? '' : 's'}. Extractors ignore them, but the file is not inert.`, page: null, bbox: null, text: preview(text, 200), phrases: [], location: {} }];
}

export async function scanPdf(bytes, opts = {}) {
  const options = { minContrast: MIN_CONTRAST, minFontPt: MIN_FONT_PT, minOpacity: MIN_OPACITY, maxPages: Infinity, ...opts };
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, fontExtraProperties: true, verbosity: 0, stopAtErrors: false });
  let pdf;
  try { pdf = await task.promise; } catch (err) {
    await task.destroy().catch(() => {});
    if (err?.name === 'PasswordException') throw Object.assign(new Error('the PDF is encrypted with a password; it cannot be scanned without it'), { code: 'ENCRYPTED' });
    throw Object.assign(new Error(`not a readable PDF: ${err?.message ?? err}`), { code: 'UNREADABLE' });
  }
  try {
    let ocConfig = null;
    try { ocConfig = await pdf.getOptionalContentConfig(); } catch { ocConfig = null; }
    const findings = [];
    const nested = [];
    const pages = Math.min(pdf.numPages, options.maxPages);
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p);
      const view = page.view;
      const { segments, paints } = await readPage(page, ocConfig);
      const pieces = segments.flatMap((seg) => splitByPage(seg, view));
      const judged = pieces.map((seg) => ({ ...seg, ...judge(seg, paints, view, options) }));
      const hidden = judged.filter((seg) => seg.mechanisms.length);
      const visible = judged.filter((seg) => !seg.mechanisms.length);
      findings.push(...hiddenFindings(p, mergeRuns(hidden), isScan(paints, view)));
      findings.push(...phraseFindingsForLines(p, visibleLines(visible)));
      findings.push(...findUnicodeTricks(judged.map((seg) => seg.text).join(' '), { page: p }));
      findings.push(...await annotationFindings(page, p, view, nested, visible.map((seg) => seg.text).join(' ')));
      page.cleanup();
    }
    findings.push(...await metadataFindings(pdf), ...await outlineFindings(pdf), ...await scriptFindings(pdf));
    try {
      const all = await pdf.getAttachments();
      const entries = all instanceof Map ? [...all.entries()] : Object.entries(all ?? {});
      for (const [id, a] of entries) nested.push({ id, filename: a.filename ?? id, content: a.content ?? null, description: a.description });
    } catch { /* no attachments */ }
    const seen = new Set();
    const attachments = [];
    for (const a of nested) {
      if (a.id && seen.has(a.id)) continue;
      if (a.id) seen.add(a.id);
      let content = a.content;
      if (!content && a.id) { try { content = await pdf.getAttachmentContent(a.id); } catch { content = null; } }
      attachments.push({ ...a, content: content ?? new Uint8Array() });
    }
    return { pages: pdf.numPages, scannedPages: pages, findings, attachments };
  } finally {
    await task.destroy();
  }
}
