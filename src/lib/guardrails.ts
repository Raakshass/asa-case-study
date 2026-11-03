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
 * One folded text variant. `text` is what the patterns run on; `lines` is the same text, character for character,
 * except that a whitespace run which held a line break is "\n" instead of " " (only the quote start reads it).
 */
interface Folded {
  text: string;
  lines: string;
}

/** Every whitespace run becomes ONE character: "\n" when the run holds a line break (U+2028 here, see foldedVariants), else " ". */
function collapseKeepingLines(s: string): string {
  return s.replace(/\s+/g, (run) => (run.includes("\u{2028}") ? "\n" : " ")).trim();
}

/**
 * The text variants the patterns run on, all NFKD-folded (fullwidth, ligature, circled and mathematical
 * letters become plain ASCII; combining marks dropped; dash and colon look-alikes read as "-" and ":") with
 * whitespace collapsed to single spaces. Zero-width and other format characters are used both inside words
 * ("ig<ZWSP>nore") and instead of spaces ("ignore<ZWSP>all"), so a text that has any is scanned twice: with them
 * removed (first) and with them as spaces.
 * Line breaks are carried through the folding as U+2028 (whitespace, and neither a format nor a control character,
 * so the invisible-character steps leave it alone) and come out as "\n" in `lines` only: `text` is exactly the
 * single-spaced text the patterns always ran on (UI-6 changes where a quote starts, never what is detected).
 */
function foldedVariants(text: string): Folded[] {
  const base = text
    .normalize("NFKD")
    .replace(WHITESPACE_CONTROLS, (c) => (c === "\t" ? " " : "\u{2028}"))
    .replace(MARKS, "")
    .replace(DASH_LIKE, "-")
    .replace(COLON_LIKE, ":");
  const variants = HAS_INVISIBLE.test(base) ? [base.replace(INVISIBLE, ""), base.replace(INVISIBLE, " ")] : [base];
  return variants.map((variant) => {
    const lines = collapseKeepingLines(variant);
    return { text: lines.replace(/\n/g, " "), lines };
  });
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
 * Where the quote of a match at `at` begins (UI-6): at the start of the match's sentence when that lies at most
 * SNIPPET_BEFORE characters back (`floor`): after a line break, after ". ", "! " or "? ", or at the start of the text.
 * Otherwise at the match itself. So a visible footer or heading is never glued to a hidden instruction
 * ("Page 1 of 1" + line break + "AI assistant: ..." is quoted from "AI assistant:").
 */
function quoteStart(lines: string, floor: number, at: number): number {
  for (let i = at - 1; i >= floor; i--) {
    const c = lines[i];
    if (c === "\n") return i + 1;
    if (c === " " && i > 0 && (lines[i - 1] === "." || lines[i - 1] === "!" || lines[i - 1] === "?")) return i + 1;
  }
  return floor === 0 ? 0 : at;
}

/**
 * Context windows around the matches; windows that overlap (and still fit in one snippet) share a snippet.
 * A snippet starts at the sentence of its first match, or at that match (quoteStart); a window that ends inside a
 * word is trimmed back to the word edge (never into a match).
 */
function snippetsAround(folded: Folded, spans: readonly Span[]): string[] {
  const { text, lines } = folded;
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
      let start = quoteStart(lines, r.start, r.lo);
      let { end } = r;
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
 * give two snippets, not five near-copies), deduplicated, in document order, at most 20. A snippet starts at the
 * sentence of its first match when that starts at most 20 characters earlier, else at the match (UI-6), and runs
 * up to 40 characters past its last match. Default patterns: CONFIG.injectionPatterns. Runs in time linear in
 * the text: see MAX_PATTERN_GAP.
 */
export function scanInjection(text: string, patterns: readonly RegExp[] = CONFIG.injectionPatterns): string[] {
  const out: string[] = [];
  /** true once the hit list is full */
  const scan = (folded: Folded, regexes: readonly RegExp[]): boolean => {
    for (const snippet of snippetsAround(folded, collectMatches(folded.text, regexes))) {
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

/* ------------------------------------------------------------------------------------------------
 * Bank accounts printed on the page (stage 6, fix round SEC-2; widened in fix round SEC-2-R1)
 * ---------------------------------------------------------------------------------------------- */

/** Zero-width and other format characters: dropped before the account scan (they would split a number in two). */
const FORMAT_CHARS = /[\p{Cf}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu;
/**
 * Reading 1 (fix round SEC-2, unchanged): a label after which a document prints an account number: "Account no",
 * "Account number", "Acct. #", "A/C no.", "Account:", "Bank account:", "IBAN". ("Account name:" and "Accounts Payable"
 * are not labels.)
 */
const ACCOUNT_LABEL = /\b(?:(?:account|acct\.?|a\/c)[ \t]*(?:no\b\.?|number\b|num\b\.?|#)[ \t]*[:#.]?|(?:bank[ \t]+)?account[ \t]*:|(iban)\b[ \t]*[:#.]?)[ \t]*/giu;
/** What follows the label: one token, then more groups on the same line only when they start with a digit ("12 3456 7890"). */
const ACCOUNT_VALUE = /^[A-Z0-9][A-Z0-9\-/.]*(?:[ \t][0-9][A-Z0-9\-/.]*)*/iu;
/**
 * An IBAN as printed after its label: country, check digits, then up to 8 groups of letters and digits ("GB29 NWBK
 * 6016 1331 9268 19"). Greedy with no condition after it, so it never backtracks; a word that follows on the same
 * line may be taken in too, which can only make the value differ from the account on file (a HOLD, never an approval).
 */
const IBAN_VALUE = /^[A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]{1,4}){1,8}/iu;
const MAX_PRINTED_ACCOUNTS = 10;
const MAX_ACCOUNT_CHARS = 40;

/*
 * Reading 3 (fix round SEC-2-R1). The attacker writes the label, so the scan reads what an AP clerk would call a bank
 * account, not only reading 1's spellings ("A/C: ...", "Acct: ...", "Acc No ...", "Account 9876543210", "Account Nr.",
 * "Sort code 20-00-00, Account 98765432", "Pay to account number:" with the number on the next line). It runs on the
 * text with every whitespace run made ONE character (a line break when the run has one), so a table cell gap counts
 * once. A label opens a window of ACCOUNT_WINDOW_CHARS that ends early at the next label; the first value in it that
 * looks like an account is read. Kinds of label:
 *  - naming the account number ("Acct: ", "A/C No.", "Account Nr.", "Bank acct", "Beneficiary account", "Konto-Nr.",
 *    "IBAN"): words, line breaks and table cells may stand between label and value; a value needs 4 digits;
 *  - bare "Account" / "Acct" / "A/C": the value must come right after it (a line break allowed, no word between);
 *  - a bank code (sort code, routing / ABA, BSB, transit, SWIFT, BIC, IFSC, BLZ): the value right after it is the
 *    code, not the account, and is skipped; an account after it is read (6 digits, or 4 with a letter);
 *  - bank words ("Bank details", "Payment instructions", "pay to", "remit payment to", "wire funds to", "transfer to",
 *    "deposit into", "beneficiary", "payee", "bank", "wire", "deposit"): the first value that looks like an account
 *    (6 digits, or 4 with a letter; not a ZIP+4, a US phone number or a whole amount with thousands commas).
 * Never a value: a date or a year, an amount (currency sign or cents), a percentage, a phone number after "+", a
 * masked number (****5566). A window stops at a word that owns the number after it (invoice, PO, ref, customer, tel,
 * date, due, total, tax, box, suite ...) and at another field's "label:" ("Due date:", "Account name:").
 * Reading 4: an IBAN anywhere in the text whose ISO 13616 check digits are valid (no label needed).
 */

/** How far after a label a value may start (reading 3); whitespace runs count as one character. */
const ACCOUNT_WINDOW_CHARS = 60;
/** Between the words of a label: nothing, one space, one line break or a hyphen (whitespace runs are one character here). */
const LABEL_GAP = String.raw`[ \n\-]?`;
const NUMBER_WORD = String.raw`(?:number|nbr|num|nr|no|n°|#)(?![a-z])\.?`;
/** "acc" names an account only with a number word or a colon after it, never bare: "ACC-44-5566" is an account, not a label. */
const BARE_ACCOUNT_WORDS = String.raw`account|acct|accnt|a\/c|kontonummer|kontonr|konto|kto|compte|cuenta`;
const ACCOUNT_WORD = String.raw`(?:${BARE_ACCOUNT_WORDS}|acc)\b`;
/** After an owner word ("Bank acct", "Beneficiary account no"): an account word, "acc" only with a number word or a colon. */
const OWNED_ACCOUNT = String.raw`(?:(?:${BARE_ACCOUNT_WORDS})\b(?:\.?${LABEL_GAP}${NUMBER_WORD})?|acc\b\.?(?:${LABEL_GAP}${NUMBER_WORD}|[ ]?[:#]))`;
/**
 * Every kind of label of reading 3, one alternative per named group (first match wins at a position). Literal words only:
 * linear. Never the middle of a hyphenated value ("NW-ACCT-98765432" is one value, not a label).
 */
const BANK_LABEL = new RegExp(
  String.raw`(?<![A-Za-z0-9][-./_])(?:` +
  [
    String.raw`(?<iban>\biban\b)`,
    String.raw`(?<number>\b${ACCOUNT_WORD}\.?${LABEL_GAP}${NUMBER_WORD})`,
    String.raw`(?<colon>\b${ACCOUNT_WORD}\.?[ ]?[:#])`,
    String.raw`(?<owner>\b(?:bank|beneficiary(?:['’]s)?|payee|checking|chequing|cheque|savings|current|deposit|receiving|destination|settlement|payment|remittance|business|company|corporate|vendor|supplier)${LABEL_GAP}${OWNED_ACCOUNT})`,
    String.raw`(?<code>\b(?:sort${LABEL_GAP}code|sortcode|swift${LABEL_GAP}code|swift|bic|aba|rtn|bsb|ifsc|blz|(?:bank|branch)${LABEL_GAP}code)\b|\b(?:routing|transit)\b(?:${LABEL_GAP}${NUMBER_WORD})?)`,
    String.raw`(?<details>\b(?:bank(?:ing)?${LABEL_GAP}(?:details|info|information|particulars|coordinates)|account${LABEL_GAP}(?:details|info|information)|(?:payment|remittance|settlement|transfer|wire)${LABEL_GAP}(?:details|information|instructions)|wiring${LABEL_GAP}instructions)\b)`,
    String.raw`(?<payto>\b(?:pay(?:ments?)?|remit(?:tance)?|send${LABEL_GAP}payment|make${LABEL_GAP}payment|wire|transfer|deposit|credit|payable)(?: [a-z]{1,15})? (?:to|into)\b)`,
    String.raw`(?<bankword>\b(?:beneficiary|payee|bank|wire|deposit)\b)`,
    String.raw`(?<bare>\b(?:${BARE_ACCOUNT_WORDS})\b\.?)`,
  ].join("|") +
    ")",
  "giu",
);
/** A customer's own account number at the vendor ("Your account no", "Customer acct:") is not where to pay. */
const CUSTOMER_BEFORE = /\b(?:customer|client|cust|your)\.?[ \n]?$/i;

interface WindowRule {
  /** fewest digits a value needs; `withLetter` when the value also has a letter (an account code such as "NW-1234") */
  minDigits: number;
  withLetter: number;
  /** words may stand between the label and the value ("Account no: Harborview Savings Bank 98765432") */
  filler: boolean;
  /** the value right after the label is a bank code (sort code, routing number, SWIFT), not the account */
  code: boolean;
  /** the label only says bank details are near: ZIP+4, US phone and comma amount shapes are not read either */
  loose: boolean;
}
const NAMED_RULE: WindowRule = { minDigits: 4, withLetter: 4, filler: true, code: false, loose: false };
const BARE_RULE: WindowRule = { minDigits: 4, withLetter: 4, filler: false, code: false, loose: false };
const CODE_RULE: WindowRule = { minDigits: 6, withLetter: 4, filler: true, code: true, loose: true };
const NEARBY_RULE: WindowRule = { minDigits: 6, withLetter: 4, filler: true, code: false, loose: true };

/** Words that own the number after them (an invoice, PO, reference, phone, date, amount, address number): a window ends there. */
const NOT_ACCOUNT_WORDS = new Set([
  "invoice", "inv", "order", "po", "p.o", "purchase", "ref", "reference", "customer", "cust", "client", "id", "tel",
  "telephone", "phone", "fax", "mobile", "cell", "call", "email", "e-mail", "date", "dated", "due", "total", "subtotal",
  "amount", "balance", "tax", "vat", "gst", "hst", "ein", "tin", "abn", "ssn", "qty", "quantity", "page", "box",
  "lockbox", "suite", "ste", "unit", "zip", "postcode",
]);
/** Words that may carry a colon inside a window without ending it: the rest of a bank-details block. */
const ACCOUNT_BLOCK_WORDS = new Set([
  "account", "acct", "accnt", "acc", "a/c", "no", "nr", "nbr", "num", "number", "n", "iban", "bank", "banking",
  "details", "beneficiary", "payee", "code", "sort", "sortcode", "routing", "aba", "rtn", "bsb", "transit", "swift",
  "bic", "ifsc", "blz", "branch", "wire", "transfer", "deposit", "credit", "remit", "remittance", "payment",
  "instructions", "information", "info", "to", "into", "konto", "kontonummer", "kontonr", "kto", "compte", "cuenta",
]);
/** The value right after one of these is a bank or branch code, not the account ("Sort code 20-00-00", "SWIFT NWBKGB2L"). */
const BANK_CODE_WORDS = new Set(["code", "sortcode", "routing", "aba", "rtn", "bsb", "transit", "swift", "bic", "ifsc", "blz"]);
/** May stand between a code word and its value ("Routing number: 021000021"). */
const NUMBER_WORDS = new Set(["no", "nr", "nbr", "num", "number", "n"]);
/** One token of a window: letters and digits with inner separators ("ACC-00-9911", "a/c", "1,150.00"). Sticky, no backtracking. */
const WINDOW_CHUNK = /[A-Za-z0-9]+(?:[-./_,][A-Za-z0-9]+)*/y;
/** Where an IBAN may start in the text (reading 4): two capitals and two digits at the start of a token. */
const IBAN_START = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}/g;

/** Whitespace runs as one character: a line break when the run has one, else a space. */
function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, (run) => (/[\n\v\f\r\u{85}\u{2028}\u{2029}]/u.test(run) ? "\n" : " "));
}

/** ISO 13616 mod-97 step: one more character (A = 10 ... Z = 35) appended to a remainder. */
function mod97(rem: number, ch: string): number {
  const code = ch.charCodeAt(0);
  return code >= 65 ? (rem * 100 + code - 55) % 97 : (rem * 10 + code - 48) % 97;
}

/**
 * An IBAN whose check digits are valid, starting at `at` (two capitals, two digits, then capitals and digits with single
 * spaces allowed between groups, 15 to 34 characters in all, ending at a token edge), else null. The longest valid one
 * wins, so a word printed after it on the same line is not taken in. Reads at most 34 letters and digits.
 */
function ibanAt(text: string, at: number): string | null {
  if (!/^[A-Z]{2}\d{2}/.test(text.slice(at, at + 4)) || (at > 0 && /[A-Za-z0-9]/.test(text[at - 1]))) return null;
  const head = text.slice(at, at + 4);
  let rem = 0; // mod 97 of the characters after the first four (which are appended last, ISO 13616)
  let count = 4;
  let best = -1;
  for (let j = at + 4; j < text.length && count < 34; ) {
    const ch = text[j];
    if (/[A-Z0-9]/.test(ch)) {
      rem = mod97(rem, ch);
      count++;
      j++;
      if (count >= 15 && !/[A-Za-z0-9]/.test(text[j] ?? "")) {
        let full = rem;
        for (const h of head) full = mod97(full, h);
        if (full === 1) best = j;
      }
    } else if (ch === " " && /[A-Z0-9]/.test(text[j + 1] ?? "")) {
      j++;
    } else {
      break;
    }
  }
  return best === -1 ? null : text.slice(at, best);
}

const inRange = (s: string, lo: number, hi: number): boolean => Number(s) >= lo && Number(s) <= hi;

/** A year (1900-2099) or a date: 2026-10-28, 10/28/2026, 28.10.26 (day and month in range, either order). */
function isDateOrYear(value: string): boolean {
  if (/^(?:19|20)\d{2}$/.test(value)) return true;
  let m = /^(?:19|20)\d{2}[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (m) return inRange(m[1], 1, 12) && inRange(m[2], 1, 31);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](?:\d{2}|(?:19|20)\d{2})$/.exec(value);
  return m !== null && ((inRange(m[1], 1, 31) && inRange(m[2], 1, 12)) || (inRange(m[1], 1, 12) && inRange(m[2], 1, 31)));
}

/** Could `value` (at `at`..`end` of `view`) be a bank account? Digits, then the shapes a reader knows are something else. */
function accountLike(view: string, at: number, end: number, value: string, rule: WindowRule): boolean {
  const digits = value.replace(/\D/g, "").length;
  if (digits < (/[A-Za-z]/.test(value) ? rule.withLetter : rule.minDigits)) return false;
  const before = view.slice(Math.max(0, at - 6), at);
  if (/[+$€£¥] ?$/u.test(before) || /\b(?:usd|eur|gbp|cad|aud|chf) ?$/i.test(before)) return false; // a phone number (+1 ...) or an amount
  if (/[*•]{2,} ?$/u.test(before) || /^[xX*]{2,}/.test(value)) return false; // masked (****5566, XXXX-5566): no one can pay into it
  if (view[end] === "%" || isDateOrYear(value) || /^\d+(?:,\d{3})*\.\d{1,2}$/.test(value)) return false; // a percentage, date, year or amount with cents
  if (rule.loose) {
    if (/^\d{1,3}(?:,\d{3})+$/.test(value) || /^\d{5}-\d{4}$/.test(value)) return false; // a whole amount, a ZIP+4 code
    if (/^\d{3}[-. ]\d{3}[-. ]\d{4}$/.test(value) || /\(\d{3}\) ?$/.test(before)) return false; // a US phone number
  }
  return true;
}

/**
 * Reading 3's window: the first value that looks like an account, starting at `from` (the end of a label) and before
 * min(from + ACCOUNT_WINDOW_CHARS, limit) (`limit` is where the next label starts). Every regex sees at most the
 * window plus MAX_ACCOUNT_CHARS, so the work per label is bounded. `shapeAt` maps where an account on file is printed
 * in its own format ("ACC 44 5566") to where that print ends: such a value is read whole.
 */
function readAfterLabel(flat: string, from: number, limit: number, rule: WindowRule, shapeAt: ReadonlyMap<number, number>): string | null {
  const startBefore = Math.max(0, Math.min(limit, from + ACCOUNT_WINDOW_CHARS) - from);
  const view = flat.slice(from, Math.min(flat.length, from + startBefore + MAX_ACCOUNT_CHARS));
  let codeNext = rule.code; // the next value is a bank code
  let i = 0;
  while (i < startBefore) {
    const ch = view[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === "\n") {
      codeNext = false; // a value on a later line is not the code's
      i++;
      continue;
    }
    let value: string | null = null;
    let next = i;
    const shapeEnd = shapeAt.get(from + i);
    if (shapeEnd !== undefined) {
      value = flat.slice(from + i, shapeEnd);
      next = shapeEnd - from;
    } else {
      const iban = ibanAt(view, i);
      if (iban !== null) {
        value = iban;
        next = i + iban.length;
      }
    }
    if (value === null) {
      WINDOW_CHUNK.lastIndex = i;
      const m = WINDOW_CHUNK.exec(view);
      if (m === null) {
        i++; // punctuation (":", "#", "(", "|", "·" ...): a pending code skip survives it
        continue;
      }
      next = i + m[0].length;
      if (!/\d/.test(m[0])) {
        const word = m[0].toLowerCase();
        if (NOT_ACCOUNT_WORDS.has(word)) return null;
        const colon = view[next] === ":" || (view[next] === " " && view[next + 1] === ":");
        if (colon && !ACCOUNT_BLOCK_WORDS.has(word)) return null; // another field's label ("Due date:", "Account name:")
        if (BANK_CODE_WORDS.has(word)) codeNext = true;
        else if (!NUMBER_WORDS.has(word)) {
          if (!rule.filler) return null;
          codeNext = false;
        }
        i = next;
        continue;
      }
      value = m[0];
      // A number printed in short groups is one value ("1234 5678 9012", "GB12 3456"), up to MAX_ACCOUNT_CHARS. A long
      // group is a whole number, so the next table cell is not taken in ("98765432" then "20-00-00").
      let group = m[0];
      while (value.length < MAX_ACCOUNT_CHARS && group.length <= 5 && /\d$/.test(group) && view[next] === " " && /\d/.test(view[next + 1] ?? "")) {
        WINDOW_CHUNK.lastIndex = next + 1;
        const more = WINDOW_CHUNK.exec(view);
        if (more === null) break;
        group = more[0];
        value = `${value} ${group}`;
        next += 1 + group.length;
      }
    }
    if (codeNext) {
      codeNext = false; // "Sort code 20-00-00": the code, not the account
      i = next;
      continue;
    }
    if (accountLike(view, i, next, value, rule)) return value.slice(0, MAX_ACCOUNT_CHARS);
    if (!rule.filler) return null;
    i = next;
  }
  return null;
}

/** A regex for the SHAPE of an account on file: its letters as they are, any digit for a digit, an optional separator for anything else. */
function accountShape(onFile: string): RegExp | null {
  const value = onFile.normalize("NFKC").trim();
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value) || value.length > MAX_ACCOUNT_CHARS) return null; // digits only would match any number
  let body = "";
  for (const ch of value) {
    if (/[A-Za-z]/.test(ch)) body += ch;
    else if (/\d/.test(ch)) body += "\\d";
    else body += "[\\s\\-./]?";
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Account numbers printed in the visible text (pass buildGroundingText: tiny text is already gone), so the bank check
 * does not rest on the model alone (SEC-2: a model that obeyed a hidden note and left bank_account empty got an
 * invoice printing a NEW account approved). Four readings, all deterministic and linear in the text:
 *  1. the value right after an account label on its line ("Account no: ACC-00-9911", "Account number 1234 5678",
 *     "IBAN DE89 3704 ...") (fix round SEC-2, unchanged);
 *  2. anything shaped like an account on file (its letters, digits and separators), e.g. "ACC-00-9911" next to
 *     "ACC-44-5566", wherever it stands. An account on file with no letter gives no shape (it would match any number);
 *  3. (SEC-2-R1) the attacker writes the label: other spellings and bank words ("A/C:", "Acct:", "Acc No", "Account
 *     9876543210", "Account Nr.", "Bank details: Sort code 20-00-00, Account 98765432", "Pay to account number:" with the
 *     number on the next line or in the next table cell, "beneficiary", "remit to", "wire to", "deposit into" ...), see
 *     BANK_LABEL and readAfterLabel above;
 *  4. (SEC-2-R1) an IBAN anywhere whose check digits are valid.
 * Readings 1 and 2 run first and exactly as before, so every value the first version read is still read; 3 and 4 can
 * only add values (each one that is not the vendor's account on file is a bank mismatch: a HOLD, never an approval).
 * A value needs at least 4 digits. Returns the values as printed (one line, at most 40 characters; a longer one from
 * readings 3 and 4 is cut to 40, never dropped), one per account (compared with normId), at most 10. checkVendor
 * compares them with the vendor's account on file.
 */
export function printedBankAccounts(text: string, accountsOnFile: readonly (string | null)[] = []): string[] {
  const clean = (typeof text === "string" ? text : "").normalize("NFKC").replace(FORMAT_CHARS, "").replace(DASH_LIKE, "-");
  const found = new Map<string, string>();
  const full = () => found.size >= MAX_PRINTED_ACCOUNTS;
  const keep = (raw: string) => {
    const value = raw.trim().replace(/[.\-/]+$/, "");
    const key = normId(value);
    if (value.length > MAX_ACCOUNT_CHARS || (key.match(/\d/g) ?? []).length < 4 || found.has(key) || full()) return;
    found.set(key, value);
  };
  // 1. the value right after an account label, on the label's line (fix round SEC-2)
  for (const m of clean.matchAll(ACCOUNT_LABEL)) {
    const after = clean.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2 * MAX_ACCOUNT_CHARS);
    const value = (m[1] !== undefined ? IBAN_VALUE : ACCOUNT_VALUE).exec(after);
    if (value) keep(value[0]);
  }
  // 2. anything shaped like an account on file (fix round SEC-2)
  const shapes = new Map<string, RegExp>();
  for (const onFile of accountsOnFile) {
    if (typeof onFile !== "string") continue;
    const shape = accountShape(onFile);
    if (shape) shapes.set(shape.source, shape);
  }
  for (const shape of shapes.values()) for (const m of clean.matchAll(shape)) keep(m[0]);
  if (full()) return [...found.values()];

  // 3. labels and bank words, the value in a window after them (SEC-2-R1)
  const flat = flattenWhitespace(clean);
  const spans: [number, number][] = [];
  for (const shape of shapes.values()) for (const m of flat.matchAll(shape)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const shapeAt = new Map<number, number>();
  for (const [start, end] of spans) if (!shapeAt.has(start)) shapeAt.set(start, end);
  let open: { from: number; rule: WindowRule } | null = null;
  let span = 0;
  for (const m of flat.matchAll(BANK_LABEL)) {
    const at = m.index ?? 0;
    if (open !== null) {
      const value = readAfterLabel(flat, open.from, at, open.rule, shapeAt); // a window ends where the next label starts
      if (value !== null) keep(value);
      open = null;
    }
    if (full()) break;
    while (span < spans.length && spans[span][1] <= at) span++;
    if (span < spans.length && spans[span][0] < at + m[0].length) continue; // overlaps a print of an account on file ("Bank ACC 44 5566")
    const g = m.groups ?? {};
    const named = g.number !== undefined || g.colon !== undefined;
    if ((named || g.bare !== undefined) && CUSTOMER_BEFORE.test(flat.slice(Math.max(0, at - 12), at))) continue;
    const rule =
      named || g.iban !== undefined || g.owner !== undefined ? NAMED_RULE : g.bare !== undefined ? BARE_RULE : g.code !== undefined ? CODE_RULE : NEARBY_RULE;
    open = { from: at + m[0].length, rule };
  }
  if (open !== null && !full()) {
    const value = readAfterLabel(flat, open.from, flat.length, open.rule, shapeAt);
    if (value !== null) keep(value);
  }

  // 4. an IBAN anywhere, when its check digits are valid (SEC-2-R1)
  for (const m of flat.matchAll(IBAN_START)) {
    if (full()) break;
    const iban = ibanAt(flat, m.index ?? 0);
    if (iban !== null) keep(iban);
  }
  return [...found.values()];
}
