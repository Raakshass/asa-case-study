/**
 * Pure display helpers of the run view (owner: UI-RUN). No React and no browser-only API: every function takes
 * plain values and returns plain strings or small plain objects, never markup, so untrusted run text can only
 * ever reach the page as React text. Checked by a tsx script outside the repo.
 *
 * Client-safe: from src/lib this file imports only format.ts and types.ts.
 *
 * Source hygiene: this file never contains an invisible or direction-changing character itself. The few that
 * a pattern has to name are built from their code points at load time.
 */
import { formatUsd } from "@/lib/format";
import { STAGES, type RunDetail, type StepStatus, type StepView } from "@/lib/types";
import type { Tone } from "@/components/shared/tones";

/* ------------------------------------------------------------------------------------------------ untrusted text */

/** Hangul fillers, the braille blank and the halfwidth Hangul filler: letters that are drawn as nothing. */
const BLANK_FILLERS = String.fromCodePoint(0x115f, 0x1160, 0x2800, 0x3164, 0xffa0);

/**
 * Control characters, format characters (zero-width, bidirectional marks, embeddings, overrides and isolates, tag
 * characters, soft hyphen) and the blank-looking filler letters: invisible or direction-changing, so they can
 * make two different strings look alike or reorder the text around them.
 */
const HIDDEN_CHARS = new RegExp(String.raw`[\p{Cc}\p{Cf}` + BLANK_FILLERS + "]", "gu");

/** Line and paragraph breaks of every kind: they become a space before the hidden characters are removed. */
const LINE_BREAKS = new RegExp(String.raw`[\t\n\r\f\v\p{Zl}\p{Zp}]`, "gu");

/** The characters the raw-data view writes out as escapes: hidden ones (the C1 controls, format characters, fillers). */
const ESCAPED_CHARS = new RegExp(String.raw`[\x7f-\x9f\p{Cf}` + BLANK_FILLERS + "]", "gu");

/** Cuts to `max` characters (code points, never half a surrogate pair) and marks the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text.length > max * 4 ? text.slice(0, max * 4) : text);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…` : chars.join("");
}

/**
 * Text that comes from an invoice (a reason that quotes the document, a vendor name, a file name, a model's
 * reasoning), made fit for display: invisible and direction-changing characters removed, white space collapsed to
 * single spaces, at most `max` characters. Anything that is not a string is "". It is still only ever rendered as
 * React text; this just keeps a hostile string from reordering or disguising what is around it.
 */
export function displayText(text: unknown, max = 600): string {
  if (typeof text !== "string") return "";
  const clean = text
    .slice(0, max * 8)
    .replace(LINE_BREAKS, " ")
    .replace(HIDDEN_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean, max);
}

/**
 * For the raw-data view: every hidden or direction-changing character is shown as an escape (a right-to-left
 * override becomes its code, written out) instead of being drawn as nothing, so the text can neither reorder its
 * surroundings nor hide what it contains.
 */
export function escapeInvisible(text: string): string {
  return text.replace(ESCAPED_CHARS, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/* ------------------------------------------------------------------------------------------------ type guards */

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** The strings of an array (anything else is skipped), at most `cap` of them. */
export function asStrings(v: unknown, cap = 50): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** A run id (or any id the server hands out) as the shape /runs/<id> accepts, so a link is never built from anything else. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/* ------------------------------------------------------------------------------------------------ numbers */

const COUNT = new Intl.NumberFormat("en-US");

/** 12345 -> "12,345". */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/** 154543 -> "151 KB", 2_400_000 -> "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 352 -> "352 ms", 1325 -> "1.3 s", 12_400 -> "12 s", 125_000 -> "2 min 5 s". null for anything that is not a duration. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 60 ? `${minutes + 1} min 0 s` : `${minutes} min ${seconds} s`;
}

/** The LLM cost of a run: four decimals below one cent ("$0.0042"), the usual two from one cent up. */
export function formatCost(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "–";
  if (usd <= 0) return formatUsd(0);
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return formatUsd(usd);
}

/** 0.02 -> "2%", 0.015 -> "1.5%", 0.5 -> "50%", -0.7 -> "-70%": a fraction as a plain percentage. */
export function formatPercent(fraction: number): string {
  const pct = Math.round(fraction * 1000) / 10;
  return `${Object.is(pct, -0) ? 0 : pct}%`;
}

const PRECISE_USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

/**
 * An amount in the invoice's own currency. USD (or none printed: the pipeline reads that as USD) goes through
 * formatUsd, with up to four decimals only when `precise` and the figure has them (a unit price of $0.0549).
 * Any other three-letter currency is shown with its own code so a euro invoice never looks like dollars; a
 * currency that is not a code (a bare symbol or a word: it comes from the invoice) is shown without a sign and flagged.
 * null when there is no finite amount.
 */
export function formatMoney(value: number | null | undefined, currency?: string | null, opts: { precise?: boolean } = {}): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const v = Object.is(value, -0) ? 0 : value;
  const code = (currency ?? "").trim().toUpperCase();
  const hasExtraDecimals = Math.abs(v * 100 - Math.round(v * 100)) > 1e-6;
  if (code === "" || code === "USD") return opts.precise && hasExtraDecimals ? PRECISE_USD.format(v) : formatUsd(v);
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: code,
        ...(opts.precise && hasExtraDecimals ? { minimumFractionDigits: 2, maximumFractionDigits: 4 } : {}),
      }).format(v);
    } catch {
      return `${v.toFixed(2)} ${code}`;
    }
  }
  return `${v.toFixed(2)} (currency unclear)`;
}

/* ------------------------------------------------------------------------------------------------ time */

function parseMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** How long a stage took (finished minus started; includes the pipeline's short presentational pause), or null. */
export function stepDurationMs(step: Pick<StepView, "started_at" | "finished_at">): number | null {
  const start = parseMs(step.started_at);
  const end = parseMs(step.finished_at);
  return start !== null && end !== null && end >= start ? end - start : null;
}

/**
 * How long the pipeline worked on a run: from the first stage that started (the time the run waited in the queue
 * is not work) to the moment it finished. null for a run that has not finished or has no stage timings (history).
 */
export function runDurationMs(run: Pick<RunDetail, "steps" | "created_at" | "finished_at">): number | null {
  const end = parseMs(run.finished_at);
  if (end === null) return null;
  let start: number | null = null;
  for (const step of run.steps) {
    const at = parseMs(step.started_at);
    if (at !== null && (start === null || at < start)) start = at;
  }
  start ??= parseMs(run.created_at);
  return start !== null && end >= start ? end - start : null;
}

const DATE_TIME = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const DATE_ONLY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** "Nov 3, 2026, 11:42 AM" in the visitor's time zone, or null when the timestamp cannot be read. */
export function formatDateTime(iso: string | null | undefined): string | null {
  const ms = parseMs(iso);
  return ms === null ? null : DATE_TIME.format(new Date(ms));
}

/** "Nov 3, 2026": a pre-loaded history run's time of day is a placeholder, so only the date is shown. */
export function formatDate(iso: string | null | undefined): string | null {
  const ms = parseMs(iso);
  return ms === null ? null : DATE_ONLY.format(new Date(ms));
}

/* ------------------------------------------------------------------------------------------------ progress */

export interface RunProgress {
  /** stages in the pipeline (10) */
  total: number;
  /** stages that have settled (anything but pending and running) */
  settled: number;
  /** the 1-based stage being worked on: the running one, else the next one that has not settled; 1..total */
  current: number;
  currentLabel: string;
}

/** "Processing... stage k of 10": which stage is live and how many have settled. */
export function runProgress(run: Pick<RunDetail, "steps">): RunProgress {
  const total = STAGES.length;
  const settled = run.steps.filter((s) => s.status !== "pending" && s.status !== "running").length;
  const running = run.steps.find((s) => s.status === "running");
  const current = Math.min(total, Math.max(1, running ? running.idx : settled + 1));
  return { total, settled, current, currentLabel: STAGES[current - 1].label };
}

/* ------------------------------------------------------------------------------------------------ step presentation */

/** Tone of a stage's status icon and node (pass green, warn amber, fail and error red, running accent, the rest grey). */
export const STATUS_TONE: Record<StepStatus, Tone> = {
  pending: "neutral",
  running: "info",
  pass: "approve",
  warn: "hold",
  fail: "reject",
  skipped: "neutral",
  error: "reject",
};

/**
 * What a stage means for the decision: severity drives decide(), the status is only how it is drawn. A failed
 * stage rejects or holds, a warning holds (an inferred PO) or is just a note, a system error holds. null for
 * stages that cost nothing (pass, skipped, pending, running).
 */
export function stepImpact(step: Pick<StepView, "status" | "severity">): { label: "Reject" | "Hold" | "Note"; tone: Tone } | null {
  switch (step.status) {
    case "fail":
      return step.severity === "reject" ? { label: "Reject", tone: "reject" } : { label: "Hold", tone: "hold" };
    case "warn":
      return step.severity === "hold" || step.severity === "reject" ? { label: "Hold", tone: "hold" } : { label: "Note", tone: "neutral" };
    case "error":
      return { label: "Hold", tone: "hold" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------------------------------ security evidence */

/** Which detector found a piece of suspicious text. */
export type Detector = "hidden" | "scan" | "model";

export const DETECTOR_LABEL: Record<Detector, string> = {
  hidden: "Tiny-text check",
  scan: "Text scan",
  model: "Model report",
};

const DETECTOR_ORDER: readonly Detector[] = ["hidden", "scan", "model"];

export interface SecurityEvidenceItem {
  /** the quoted text, made fit for display (the longest form any detector reported) */
  text: string;
  /** every detector that reported this text, in a fixed order */
  detectors: Detector[];
  /** every quote merged into this item, as each detector reported it (made fit for display); `text` is one of them */
  sources: string[];
}

export interface SecurityEvidence {
  items: SecurityEvidenceItem[];
  /** quotes that did not fit the cap (they stay in the Security screen and Extract fields stages) */
  more: number;
}

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w !== "");
}

/** Length of the longest run of consecutive words that `a` and `b` share. */
function longestSharedRun(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    prev = row;
  }
  return best;
}

/**
 * Do two quotes report the same passage? The text scan quotes a window of the page (with a few words of the page
 * footer around the sentence), the tiny-text check the whole hidden run and the model its own verbatim copy, so
 * the same instruction arrives as three slightly different strings. They are one passage when the shorter one is
 * (almost) inside the longer one: at least 80% of its words form one unbroken run of the other and no more than
 * six words are left over. Anything less is kept apart, so two different instructions are never merged into one
 * quote (the stage evidence lists every raw snippet anyway).
 */
function samePassage(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const wa = words(a);
  const wb = words(b);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length < 4) return false;
  const shared = longestSharedRun(long, short);
  return shared / short.length >= 0.8 && short.length - shared <= 6;
}

function quotes(value: unknown, cap: number): string[] {
  return asStrings(value, cap)
    .map((s) => displayText(s, 600))
    .filter((s) => s !== "");
}

/**
 * The evidence of the shield banner: what the text scan matched (screen.injectionHits), the tiny-text runs
 * (screen.hiddenText) and what the model reported (extraction.suspicious_content), merged so one hidden
 * instruction is quoted ONCE with the detectors that caught it, not three times. At most `cap` quotes are kept.
 */
export function buildSecurityEvidence(input: { injectionHits?: unknown; hiddenText?: unknown; suspicious?: unknown }, cap = 5): SecurityEvidence {
  const sources: Array<[Detector, string[]]> = [
    ["hidden", quotes(input.hiddenText, 10)],
    ["model", quotes(input.suspicious, 20)],
    ["scan", quotes(input.injectionHits, 20)],
  ];
  const items: Array<{ text: string; detectors: Set<Detector>; sources: string[] }> = [];
  for (const [detector, texts] of sources) {
    for (const text of texts) {
      const hit = items.find((item) => samePassage(item.text, text));
      if (hit) {
        hit.detectors.add(detector);
        hit.sources.push(text);
        if (text.length > hit.text.length) hit.text = text; // show the most complete form
      } else {
        items.push({ text, detectors: new Set([detector]), sources: [text] });
      }
    }
  }
  const shown = items.slice(0, cap).map((item) => ({
    text: item.text,
    detectors: DETECTOR_ORDER.filter((d) => item.detectors.has(d)),
    sources: item.sources,
  }));
  return { items: shown, more: Math.max(0, items.length - shown.length) };
}
