export type Severity = 'info' | 'low' | 'medium' | 'high';
export type Format = 'pdf' | 'docx' | 'html' | 'text';

export type Rule =
  | 'hidden-text'
  | 'ocr-text-layer'
  | 'instruction-phrase'
  | 'metadata'
  | 'annotation'
  | 'attachment'
  | 'javascript'
  | 'comment'
  | 'tracked-change'
  | 'html-comment'
  | 'html-attribute'
  | 'unicode-tags'
  | 'bidi-control'
  | 'zero-width';

export type Mechanism =
  | 'low-contrast'
  | 'tiny-text'
  | 'off-page'
  | 'invisible-render-mode'
  | 'transparent'
  | 'hidden-layer'
  | 'covered'
  | 'clipped'
  | 'hidden-attribute'
  | 'template'
  | 'display-none'
  | 'visibility-hidden'
  | 'off-screen'
  | 'collapsed'
  | 'visually-hidden';

export interface Finding {
  rule: Rule;
  severity: Severity;
  /** One sentence a person can act on. */
  reason: string;
  /** 1-based page number (PDF), else null. */
  page: number | null;
  /** [x0, y0, x1, y1] in PDF points, origin bottom-left of the page (PDF), else null. */
  bbox: [number, number, number, number] | null;
  /** The text a model would read, whitespace-collapsed and truncated to 600 characters. Untrusted. */
  text: string;
  /** Ids of the phrase rules the text matched (see PHRASE_RULES). */
  phrases: string[];
  /** How the text is hidden, for rule 'hidden-text' and 'ocr-text-layer'. */
  mechanisms?: Mechanism[];
  /** Measured values behind the verdict: font_pt, color, background, contrast, delta_e, render_mode, opacity, layer, covered_by. */
  evidence?: Record<string, unknown>;
  /** Where the finding is when there is no page and bbox: part/paragraph (DOCX), line (HTML, text), field, attachment. */
  location?: Record<string, unknown>;
}

export interface ScanResult {
  scanner: { name: 'subtext-scan'; version: string };
  file: string | null;
  format: Format;
  sha256: string;
  bytes: number;
  pages: number | null;
  findings: Finding[];
  summary: { total: number; info: number; low: number; medium: number; high: number; max: Severity | null };
}

export interface ScanOptions {
  /** Skip detection and read the input as this format. */
  format?: Format;
  /** Name used for format detection and reported as `file` when scanning bytes. */
  name?: string;
  /** Contrast ratio (WCAG formula) below which text is unreadable. Default 1.25. */
  minContrast?: number;
  /** Rendered height in points below which text is unreadable. Default 2. */
  minFontPt?: number;
  /** Opacity at or below which text is unreadable. Default 0.1. */
  minOpacity?: number;
  /** Scan at most this many PDF pages. Default all. */
  maxPages?: number;
}

export interface PhraseRule {
  id: string;
  description: string;
  pattern: string;
  regex: RegExp;
}

export interface PhraseHit {
  id: string;
  match: string;
  index: number;
}

export const VERSION: string;
export const FORMATS: Format[];
export const SEVERITIES: Severity[];
export const PHRASE_RULES: PhraseRule[];

/** Scan a file path or the file's bytes. */
export function scan(input: string | Uint8Array | ArrayBuffer, options?: ScanOptions): Promise<ScanResult>;
/** True when any finding is at or above `threshold`. 'none' never exceeds. */
export function exceeds(result: Pick<ScanResult, 'findings'>, threshold?: Severity | 'none'): boolean;
export function summarize(findings: Finding[]): ScanResult['summary'];
export function detectFormat(bytes: Uint8Array, name?: string): Format | null;
export function findInstructionPhrases(text: string): PhraseHit[];
export function findUnicodeTricks(text: string, where?: { page?: number | null; bbox?: Finding['bbox']; location?: Record<string, unknown> }): Finding[];
/** Replace invisible format characters with <U+XXXX> so they can be seen. */
export function showInvisible(text: string): string;
/** Remove invisible format characters (tag characters, bidi controls, zero-width characters). */
export function stripInvisible(text: string): string;
