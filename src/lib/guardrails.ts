/**
 * Deterministic guardrails (IMPLEMENTATION_PLAN.md section 6.2 and 6.4, docs/notes-unpdf.md):
 * the stage-2 security screen (injection pattern scan + hidden/tiny text) and the stage-4 grounding
 * check (extracted values must appear as visible tokens). Pure functions of their inputs.
 *
 * OWNER: Phase 4. Everything fed in here comes from an untrusted PDF: nothing is rendered as HTML, quotes
 * are length-limited and stripped of control characters, and no regex can run in more than linear time on
 * a hostile 1 MB text layer (see boundGaps).
 */
import { CONFIG } from "./config";
import { normId } from "./format";
import {
  type FieldGrounding,
  GROUNDED_FIELDS,
  type GroundedField,
  type GroundingResult,
  type InvoiceExtraction,
  type ScreenResult,
  type StepResult,
  type TextItem,
} from "./types";

/* ------------------------------------------------------------------------------------------------
 * Text helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Format (Cf: zero-width, bidi, soft hyphen, BOM) and control (Cc) characters, plus the blank-looking Hangul
 * fillers and Braille blank: invisible in a rendered page, so never part of what a reader sees.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu;
const HAS_INVISIBLE = /[\p{Cf}\p{Cc}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/u;
/** Combining marks: "i" + U+0307 or a precomposed "i" with a diaeresis must not hide a keyword. */
const MARKS = /\p{M}/gu;
/** Control characters that are really whitespace (tab, LF, VT, FF, CR, NEL, LS, PS): they become spaces, never vanish. */
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]/gu;
/**
 * Dash and colon look-alikes that NFKD leaves as they are, so "pre<U+2011>approved" or "system<U+2236>" would slip
 * past /pre-?approved/ and /\bsystem:/ (red team RG-3). The scan reads them as "-" and ":".
 */
const DASH_LIKE = /[\u{058A}\u{2010}-\u{2015}\u{2043}\u{2212}\u{2E3A}\u{2E3B}\u{FE58}\u{FE63}\u{FF0D}]/gu;
const COLON_LIKE = /[\u{02D0}\u{02F8}\u{0589}\u{05C3}\u{2236}\u{A789}\u{FE13}\u{FE55}\u{FF1A}]/gu;

const collapseSpaces = (s: string): string => s.replace(/\s+/g, " ").trim();

/** One-line, control-free, length-limited quote for reasons and details. */
function quote(text: string, maxChars: number): string {
  const oneLine = collapseSpaces(text.replace(INVISIBLE, " "));
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}\u{2026}`;
}

/** Code points, not UTF-16 units. */
function countCodePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Characters a reader can see: not whitespace, not zero-width / format / control characters. */
function visibleCharCount(text: string): number {
  return countCodePoints(text.replace(INVISIBLE, "").replace(/\s+/g, ""));
}

/** Height below maxPt, or not a number at all (a degenerate transform must never count as readable). */
const isTiny = (height: number, maxPt: number): boolean => !(height >= maxPt);

/** Joined text layer: items.map(i => i.str).join("") (equals unpdf extractText per page, pages in order). */
export function joinText(items: readonly TextItem[]): string {
  return items.map((i) => i.str).join("");
}

/** Pages are told apart by a newline so a phrase or token never glues across a page break. */
function joinPages(items: readonly TextItem[]): string {
  let out = "";
  let page = 0;
  for (const it of items) {
    if (page !== 0 && it.page !== page) out += "\n";
    page = it.page;
    out += it.str;
  }
  return out;
}

/**
 * Fewer than CONFIG.imageOnlyMaxChars (20) NON-whitespace characters across all pages (zero-width, format
 * and control characters do not count as text either).
 */
export function isImageOnly(items: readonly TextItem[]): boolean {
  let n = 0;
  for (const it of items) {
    n += visibleCharCount(it.str);
    if (n >= CONFIG.imageOnlyMaxChars) return false;
  }
  return true;
}

/* ------------------------------------------------------------------------------------------------
 * Injection scan
 * ---------------------------------------------------------------------------------------------- */

const SNIPPET_MAX_CHARS = 200;
const SNIPPET_BEFORE = 20;
const SNIPPET_AFTER = 40;
const MAX_INJECTION_HITS = 20;
const MAX_MATCHES_PER_PATTERN = 50;
/**
 * `.*` and `.+` in a scan pattern may span at most this many characters. CONFIG has /disregard .*instructions/:
 * on a text of "disregard disregard ..." with no "instructions" an unbounded `.*` rescans to the end of the
 * text from every start, which is quadratic (minutes on 1 MB). A bounded gap keeps each attempt constant.
 * The price: "disregard" and "instructions" more than 200 characters apart no longer match together.
 * Only `.*` and `.+` are bounded: a caller-supplied pattern with nested quantifiers is the caller's problem.
 */
const MAX_PATTERN_GAP = 200;

/** Rewrites unbounded `.*` / `.+` (outside character classes and escapes) into bounded gaps. */
function boundGaps(source: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      out += c + (source[i + 1] ?? "");
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
      out += c;
    } else if (c === "[") {
      inClass = true;
      out += c;
    } else if (c === "." && (source[i + 1] === "*" || source[i + 1] === "+")) {
      out += `.{${source[i + 1] === "*" ? 0 : 1},${MAX_PATTERN_GAP}}`;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** Makes every literal space of a pattern optional (outside character classes and escapes; a space that already has a quantifier is left alone). */
function optionalSpaces(source: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      out += c + (source[i + 1] ?? "");
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
      out += c;
    } else if (c === "[") {
      inClass = true;
      out += c;
    } else if (c === " " && !"?*+{".includes(source[i + 1] ?? "")) {
      out += " ?";
    } else {
      out += c;
    }
  }
  return out;
}

const scanRegexCache = new WeakMap<RegExp, RegExp>();
const spaceOptionalCache = new WeakMap<RegExp, RegExp | null>();

/** Global, gap-bounded clone of a pattern (a caller's pattern is never mutated; /g and /y are replaced by /g). */
function scanRegex(re: RegExp): RegExp {
  let compiled = scanRegexCache.get(re);
  if (!compiled) {
    const flags = `${re.flags.replace(/[gy]/g, "")}g`;
    try {
      compiled = new RegExp(boundGaps(re.source), flags);
    } catch {
      compiled = new RegExp(re.source, flags);
    }
    scanRegexCache.set(re, compiled);
  }
  return compiled;
}

/** scanRegex with every literal space optional; null when the pattern has no space to relax (or cannot be rewritten). */
function spaceOptionalRegex(re: RegExp): RegExp | null {
  if (spaceOptionalCache.has(re)) return spaceOptionalCache.get(re) ?? null;
  const bounded = scanRegex(re);
  const source = optionalSpaces(bounded.source);
  let compiled: RegExp | null = null;
  if (source !== bounded.source) {
    try {
      compiled = new RegExp(source, bounded.flags);
    } catch {
      compiled = null;
    }
  }
  spaceOptionalCache.set(re, compiled);
  return compiled;
}

/**
 * The text variants the patterns run on, all NFKD-folded (fullwidth, ligature, circled and mathematical
 * letters become plain ASCII; combining marks dropped; dash and colon look-alikes read as "-" and ":") with
 * whitespace collapsed to single spaces. Zero-width and other format characters are used both inside words
 * ("ig<ZWSP>nore") and instead of spaces ("ignore<ZWSP>all"), so a text that has any is scanned twice: with them
 * removed (first) and with them as spaces.
 */
function foldedVariants(text: string): string[] {
  const base = text.normalize("NFKD").replace(WHITESPACE_CONTROLS, " ").replace(MARKS, "").replace(DASH_LIKE, "-").replace(COLON_LIKE, ":");
  if (!HAS_INVISIBLE.test(base)) return [collapseSpaces(base)];
  return [collapseSpaces(base.replace(INVISIBLE, "")), collapseSpaces(base.replace(INVISIBLE, " "))];
}

interface Span {
  start: number;
  end: number;
}

/** A snippet window plus the part of it that is match text (word alignment never trims into the matches). */
interface Region extends Span {
  lo: number;
  hi: number;
}

/** Matches of every pattern, at most MAX_MATCHES_PER_PATTERN each, in document order. */
function collectMatches(text: string, regexes: readonly RegExp[]): Span[] {
  const spans: Span[] = [];
  for (const re of regexes) {
    let n = 0;
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
      if (++n >= MAX_MATCHES_PER_PATTERN) break;
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Context windows around the matches; windows that overlap (and still fit in one snippet) share a snippet.
 * A window that starts or ends inside a word is trimmed back to the word edge (never into a match).
 */
function snippetsAround(text: string, spans: readonly Span[]): string[] {
  const regions: Region[] = [];
  for (const s of spans) {
    const start = Math.max(0, s.start - SNIPPET_BEFORE);
    const end = Math.min(text.length, Math.max(s.end, s.start + 1) + SNIPPET_AFTER);
    const last = regions[regions.length - 1];
    if (last && start <= last.end && Math.max(last.end, end) - last.start <= SNIPPET_MAX_CHARS) {
      last.end = Math.max(last.end, end);
      last.hi = Math.max(last.hi, s.end);
    } else {
      regions.push({ start, end: Math.min(end, start + SNIPPET_MAX_CHARS), lo: s.start, hi: s.end });
    }
  }
  const isLow = (i: number) => text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff;
  const isHigh = (i: number) => text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff;
  return regions
    .map((r) => {
      let { start, end } = r;
      if (start > 0 && text[start - 1] !== " ") {
        const space = text.indexOf(" ", start); // we start inside a word: begin at the next one
        if (space !== -1 && space < r.lo) start = space + 1;
      }
      if (end < text.length && text[end] !== " ") {
        const space = text.lastIndexOf(" ", end - 1); // we end inside a word: stop at the previous one
        if (space >= r.hi) end = space;
      }
      if (start < text.length && isLow(start)) start++; // never cut a surrogate pair in half
      if (end > start && end < text.length && isHigh(end - 1)) end--;
      return text.slice(start, end).trim();
    })
    .filter((s) => s.length > 0);
}

/**
 * Injection pattern scan on JOINED text (never per item), after NFKC-style folding and collapsing whitespace to
 * single spaces. Returns one quoted snippet per hit (the match plus a little context, at most 200 characters;
 * hits whose context overlaps share one snippet, so the 5 patterns inside sample #9's single hidden sentence
 * give two snippets, not five near-copies), deduplicated, in document order, at most 20. Default patterns:
 * CONFIG.injectionPatterns. Runs in time linear in the text: see MAX_PATTERN_GAP.
 */
export function scanInjection(text: string, patterns: readonly RegExp[] = CONFIG.injectionPatterns): string[] {
  const out: string[] = [];
  /** true once the hit list is full */
  const scan = (folded: string, regexes: readonly RegExp[]): boolean => {
    for (const snippet of snippetsAround(folded, collectMatches(folded, regexes))) {
      if (!out.includes(snippet)) out.push(snippet);
      if (out.length >= MAX_INJECTION_HITS) return true;
    }
    return false;
  };
  const variants = foldedVariants(text);
  const regexes = patterns.map(scanRegex);
  for (const folded of variants) if (scan(folded, regexes)) return out;
  // Invisible characters used inside words AND between them ("ig<ZWSP>nore all<ZWSP>previous") defeat both variants
  // above: removed, the words glue ("allprevious"); as spaces, a word splits ("ig nore"). So the removed variant is
  // scanned once more with every space of a pattern optional. Only for texts that hide characters (red team RG-3).
  if (variants.length > 1) {
    const relaxed = patterns.map(spaceOptionalRegex).filter((re): re is RegExp => re !== null);
    scan(variants[0], relaxed);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Hidden (tiny) text
 * ---------------------------------------------------------------------------------------------- */

/**
 * Runs of CONSECUTIVE items per page with height < maxPt (default CONFIG.tinyTextMaxPt = 3), whitespace-only
 * items neither starting nor breaking a run, kept when the run has >= minWords (default 4) words.
 * Returns each run's text, whitespace collapsed (zero-width and control characters become spaces, so the
 * quote is clean and cannot reorder a reviewer's screen). Catches #9 (Chromium renders CSS 1px as 0.75pt, split
 * at the "fi" ligature into 3 items). Does NOT catch white text at normal size (no colour in getTextContent).
 */
export function findTinyText(
  items: readonly TextItem[],
  maxPt: number = CONFIG.tinyTextMaxPt,
  minWords: number = CONFIG.tinyTextMinWords,
): string[] {
  const runs: string[] = [];
  let cur = "";
  let page = 0;
  const flush = () => {
    const text = collapseSpaces(cur.replace(INVISIBLE, " "));
    if (text !== "" && text.split(" ").length >= minWords) runs.push(text);
    cur = "";
  };
  for (const it of items) {
    if (it.page !== page) {
      flush();
      page = it.page;
    }
    if (it.str.trim() === "") {
      if (cur) cur += it.str; // separators never start or break a run
    } else if (isTiny(it.height, maxPt)) {
      cur += it.str;
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

/* ------------------------------------------------------------------------------------------------
 * Stage 2
 * ---------------------------------------------------------------------------------------------- */

const MAX_HIDDEN_RUNS = 10;
const MAX_HIDDEN_RUN_CHARS = 500;
const REASON_QUOTE_CHARS = 120;

/**
 * Stage 2: { isImageOnly, textChars, injectionHits: scanInjection(joined text), hiddenText: findTinyText }.
 * hiddenText keeps at most 10 runs of at most 500 characters each (the result is stored as the step detail
 * and polled by the UI); the full text is only ever needed by findTinyText callers.
 */
export function screenPdf(items: readonly TextItem[]): ScreenResult {
  const text = joinPages(items);
  const textChars = visibleCharCount(text);
  return {
    isImageOnly: textChars < CONFIG.imageOnlyMaxChars,
    textChars,
    injectionHits: scanInjection(text),
    hiddenText: findTinyText(items)
      .slice(0, MAX_HIDDEN_RUNS)
      .map((run) => quote(run, MAX_HIDDEN_RUN_CHARS)),
  };
}

function more(total: number): string {
  return total > 1 ? ` (+${total - 1} more)` : "";
}

/**
 * Stage 2 step result. Any injection hit or hidden text -> { status: "fail", severity: "hold" } with a
 * reason containing "Suspicious" for injection hits and "Tiny or hidden text found: '...'" for hidden text
 * (both sentences when both fire). Otherwise "pass" (reason notes "image-only, no text layer" when
 * isImageOnly). detail = the ScreenResult. A fail here is the security flag: decide() never APPROVEs it.
 */
export function checkScreen(screen: ScreenResult): StepResult {
  const sentences: string[] = [];
  if (screen.injectionHits.length > 0) {
    sentences.push(
      `Suspicious instruction-like text found: '${quote(screen.injectionHits[0], REASON_QUOTE_CHARS)}'${more(screen.injectionHits.length)}.`,
    );
  }
  if (screen.hiddenText.length > 0) {
    sentences.push(`Tiny or hidden text found: '${quote(screen.hiddenText[0], REASON_QUOTE_CHARS)}'${more(screen.hiddenText.length)}.`);
  }
  if (sentences.length > 0) {
    return { status: "fail", severity: "hold", reason: sentences.join(" "), detail: { ...screen } };
  }
  const reason = screen.isImageOnly
    ? "No suspicious or hidden text found (image-only, no text layer to scan)"
    : `No injection patterns or hidden text found (${screen.textChars} characters scanned)`;
  return { status: "pass", reason, detail: { ...screen } };
}

/* ------------------------------------------------------------------------------------------------
 * Grounding (stage 4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Grounding text (plan 6.4 as corrected): join str of every item, replacing EVERY item with height < maxPt
 * (default 3) by " ", so tiny/injected text can never ground the values it injects. Whitespace-only items
 * stay as they are, and a newline is put between pages so tokens never glue across a page break.
 */
export function buildGroundingText(items: readonly TextItem[], maxPt: number = CONFIG.tinyTextMaxPt): string {
  let out = "";
  let page = 0;
  for (const it of items) {
    if (page !== 0 && it.page !== page) out += "\n";
    page = it.page;
    out += it.str.trim() !== "" && isTiny(it.height, maxPt) ? " " : it.str;
  }
  return out;
}

/** Whitespace tokens of a text (empty tokens dropped). */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

const MAX_ID_TOKEN_CHARS = 256;
const MAX_AMOUNT_TOKEN_CHARS = 40;

/** sign, currency symbol (dollar, euro, pound, yen), sign, digits with US thousands groups, optional decimals. Anchored, linear. */
const AMOUNT = /^([-+\u{2212}])?[$\u{20AC}\u{A3}\u{A5}]?([-+\u{2212}])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/u;

/**
 * "$4,620.00" -> 4620; "(1,200.00)" -> -1200; "400." -> 400; "4,620.00)" -> 4620; null when the token is not a
 * whole number in US format (so "4,400.00" is 4400, never 400, and "NW-7781", "2026-10-28", "1.150,00" are
 * not amounts).
 */
function parseAmountToken(raw: string): number | null {
  if (raw.length > MAX_AMOUNT_TOKEN_CHARS) return null;
  let t = raw.normalize("NFKC").replace(INVISIBLE, ""); // fullwidth digits and commas fold to ASCII first
  if (!/\d/.test(t)) return null;
  t = t.replace(/[.,;:]+$/, "");
  const parens = t.startsWith("(") && t.endsWith(")"); // accounting negative
  t = parens ? t.slice(1, -1) : t.replace(/^[([]+/, "").replace(/[)\]]+$/, "");
  const m = AMOUNT.exec(t);
  if (!m) return null;
  const sign = m[1] ?? m[2];
  const negative = parens || sign === "-" || sign === "\u{2212}";
  const n = Number(m[3].replace(/,/g, "") + (m[4] ? `.${m[4]}` : ""));
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

const FIELD_LABELS: Record<GroundedField, string> = {
  invoice_number: "invoice number",
  po_reference: "PO reference",
  total: "total",
};

function missReason(f: FieldGrounding): string {
  const shown = typeof f.value === "number" ? f.value.toFixed(2) : quote(String(f.value), 60);
  return `Extracted ${FIELD_LABELS[f.field]} ${shown} does not appear in the document; possible manipulation or misread`;
}

/**
 * Stage 4 grounding (plan 6.4): invoice_number, po_reference (when not null) and total must each match a
 * WHOLE visible token. Identifiers: normId(token) === normId(value) (format.ts), so INV-0042, INV0042 and
 * "inv 0042" are one identifier; an identifier printed as two tokens ("INV" "0042") does not match (a
 * conservative miss). Amounts: strip "$" and "," (and trailing punctuation) from each token, parse, compare
 * within CONFIG.groundingAmountTolerance, so 400 never matches "4,400.00". `visible` is grounding text (string)
 * or its tokens. Miss reason format: "Extracted total 400.00 does not appear in the document; possible
 * manipulation or misread". A null (or blank) extracted value is "not_applicable": a missing invoice number or
 * total is the validate stage's problem, not a grounding miss. Callers pass null instead of calling this for
 * image-only PDFs.
 */
export function groundExtraction(extraction: InvoiceExtraction, visible: string | readonly string[]): GroundingResult {
  const tokens = typeof visible === "string" ? tokenize(visible) : visible.flatMap((chunk) => tokenize(chunk));
  let norms: string[] | null = null;
  const normalised = () => (norms ??= tokens.map((t) => (t.length <= MAX_ID_TOKEN_CHARS ? normId(t) : "")));
  let amounts: (number | null)[] | null = null;
  const parsed = () => (amounts ??= tokens.map(parseAmountToken));

  const ground = (field: GroundedField, value: string | number | null): FieldGrounding => {
    if (value === null || (typeof value === "string" && value.trim() === "")) {
      return { field, value, status: "not_applicable", matchedToken: null };
    }
    let at = -1;
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        // 1e-9 absorbs float noise: |400.01 - 400| is 0.01000000000004... in binary
        at = parsed().findIndex((a) => a !== null && Math.abs(a - value) <= CONFIG.groundingAmountTolerance + 1e-9);
      }
    } else {
      const want = normId(value);
      if (want !== "") at = normalised().indexOf(want);
    }
    return at < 0
      ? { field, value, status: "missing", matchedToken: null }
      : { field, value, status: "grounded", matchedToken: quote(tokens[at], 100) };
  };

  const fields = GROUNDED_FIELDS.map((field) => ground(field, extraction[field]));
  return { fields, misses: fields.filter((f) => f.status === "missing").map(missReason) };
}
